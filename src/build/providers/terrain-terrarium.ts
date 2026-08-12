/**
 * Terrain from the AWS Terrain Tiles open dataset (Mapzen Terrarium format).
 *
 * Chosen for v1 because it needs no credentials, no extensions and no project
 * index: plain z/x/y PNGs on a public bucket. USGS 3DEP 1 m would be better
 * near the shoreline, but 3DEP is organised by irregular project footprints —
 * the CA_SanFrancisco_B23 project covers only part of the Bay Area box — so
 * using it means first building a cross-project tile index. That is worth
 * doing for the renderer, where 1 m detail shows; it is not worth doing for
 * occlusion testing over water, where the far shoreline is what matters and
 * 30 m is ample.
 *
 * Height is encoded across the RGB channels:
 *
 *   metres = (R * 256 + G + B / 256) - 32768
 *
 * ## Vertical datum caveat
 *
 * Terrarium is a mosaic of SRTM, NED and GMTED, whose native datums differ
 * (SRTM is EGM96, NED is NAVD88). It is tagged EGM2008 here because that is
 * the closest single label, but the mixture means sub-metre vertical accuracy
 * should not be assumed, and the provenance is marked unverified accordingly.
 * For measurement work this layer wants replacing with 3DEP.
 */

import { PNG } from 'pngjs';
import type {
  BBox,
  Coverage,
  Provenance,
  TerrainGrid,
  TerrainProvider,
} from './types.ts';
import { ProviderUnavailableError } from './types.ts';

const BASE_URL = 'https://elevation-tiles-prod.s3.amazonaws.com/terrarium';
const TILE_PX = 256;
const NO_DATA = -32768;

/** Terrarium's source data is ~30 m at best; beyond z13 it is interpolation. */
const DEFAULT_ZOOM = 13;

export function lonToTileX(lon: number, zoom: number): number {
  return ((lon + 180) / 360) * 2 ** zoom;
}

export function latToTileY(lat: number, zoom: number): number {
  const r = (lat * Math.PI) / 180;
  return ((1 - Math.asinh(Math.tan(r)) / Math.PI) / 2) * 2 ** zoom;
}

export function tileXToLon(x: number, zoom: number): number {
  return (x / 2 ** zoom) * 360 - 180;
}

export function tileYToLat(y: number, zoom: number): number {
  const n = Math.PI - (2 * Math.PI * y) / 2 ** zoom;
  return (180 / Math.PI) * Math.atan(0.5 * (Math.exp(n) - Math.exp(-n)));
}

/** Decode a Terrarium PNG tile into metres. */
export function decodeTerrarium(png: PNG): Float32Array {
  const out = new Float32Array(png.width * png.height);
  for (let i = 0; i < out.length; i++) {
    const o = i * 4;
    const r = png.data[o]!;
    const g = png.data[o + 1]!;
    const b = png.data[o + 2]!;
    out[i] = r * 256 + g + b / 256 - 32768;
  }
  return out;
}

export interface TerrariumOptions {
  zoom?: number;
  /** Directory for caching fetched tiles, so repeat builds are offline. */
  cacheDir?: string;
  fetchImpl?: typeof fetch;
}

export class TerrariumTerrainProvider implements TerrainProvider {
  readonly id = 'terrarium';
  private readonly zoom: number;
  private readonly fetchImpl: typeof fetch;
  private readonly cacheDir: string | undefined;

  constructor(opts: TerrariumOptions = {}) {
    this.zoom = opts.zoom ?? DEFAULT_ZOOM;
    this.fetchImpl = opts.fetchImpl ?? fetch;
    this.cacheDir = opts.cacheDir;
  }

  async coverage(bbox: BBox): Promise<Coverage> {
    // Web Mercator tiling is undefined beyond +/-85.05 degrees. Irrelevant for
    // the Bay Area, but a global scene centred on a pole would silently get a
    // hole exactly where it matters most, so refuse rather than mislead.
    if (bbox.latMax > 85.05 || bbox.latMin < -85.05) {
      return {
        available: false,
        notes: [
          'Web Mercator tiling does not extend beyond +/-85.05 degrees latitude; ' +
            'a polar scene needs a geographic or polar-stereographic source.',
        ],
      };
    }
    const metresPerPixel =
      (156543.03392 * Math.cos((((bbox.latMin + bbox.latMax) / 2) * Math.PI) / 180)) /
      2 ** this.zoom;
    return {
      available: true,
      resolutionMetres: metresPerPixel,
      datum: 'egm2008',
      notes: [
        `Terrarium zoom ${this.zoom}, about ${metresPerPixel.toFixed(1)} m/px at this latitude.`,
        'Source is a mosaic of SRTM, NED and GMTED with differing native vertical datums.',
      ],
    };
  }

  private async fetchTile(x: number, y: number): Promise<Float32Array> {
    const url = `${BASE_URL}/${this.zoom}/${x}/${y}.png`;

    if (this.cacheDir) {
      const cached = await readCache(this.cacheDir, `${this.zoom}-${x}-${y}.png`);
      if (cached) return decodeTerrarium(PNG.sync.read(cached));
    }

    let res: Response;
    try {
      res = await this.fetchImpl(url);
    } catch (cause) {
      throw new ProviderUnavailableError(this.id, `could not reach ${url}`, cause);
    }
    if (!res.ok) {
      // Tiles outside the dataset's coverage 404; treat as no-data rather than fatal.
      if (res.status === 404) return new Float32Array(TILE_PX * TILE_PX).fill(NO_DATA);
      throw new ProviderUnavailableError(this.id, `HTTP ${res.status} for ${url}`);
    }
    const buf = Buffer.from(await res.arrayBuffer());
    if (this.cacheDir) await writeCache(this.cacheDir, `${this.zoom}-${x}-${y}.png`, buf);
    return decodeTerrarium(PNG.sync.read(buf));
  }

  async fetch(
    bbox: BBox,
    cellSizeMetres: number,
  ): Promise<{ grid: TerrainGrid; provenance: Provenance }> {
    const coverage = await this.coverage(bbox);
    if (!coverage.available) {
      throw new ProviderUnavailableError(
        this.id,
        coverage.notes?.join(' ') ?? 'no coverage for this box',
      );
    }

    const x0 = Math.floor(lonToTileX(bbox.lonMin, this.zoom));
    const x1 = Math.floor(lonToTileX(bbox.lonMax, this.zoom));
    const y0 = Math.floor(latToTileY(bbox.latMax, this.zoom)); // north edge -> low y
    const y1 = Math.floor(latToTileY(bbox.latMin, this.zoom));

    const nx = x1 - x0 + 1;
    const ny = y1 - y0 + 1;

    // Stitch into one mosaic so bilinear sampling across tile seams is trivial.
    const mosaicW = nx * TILE_PX;
    const mosaicH = ny * TILE_PX;
    const mosaic = new Float32Array(mosaicW * mosaicH);

    for (let ty = 0; ty < ny; ty++) {
      // Tiles within a row are independent; fetch a row at a time to keep
      // concurrency bounded without serialising the whole grid.
      const row = await Promise.all(
        Array.from({ length: nx }, (_, tx) => this.fetchTile(x0 + tx, y0 + ty)),
      );
      for (let tx = 0; tx < nx; tx++) {
        const tile = row[tx]!;
        for (let py = 0; py < TILE_PX; py++) {
          const dst = (ty * TILE_PX + py) * mosaicW + tx * TILE_PX;
          mosaic.set(tile.subarray(py * TILE_PX, (py + 1) * TILE_PX), dst);
        }
      }
    }

    const midLat = (bbox.latMin + bbox.latMax) / 2;
    const metresPerDegLat = 111132.92 - 559.82 * Math.cos(2 * (midLat * Math.PI) / 180);
    const metresPerDegLon = 111412.84 * Math.cos((midLat * Math.PI) / 180);

    const width = Math.max(
      2,
      Math.round(((bbox.lonMax - bbox.lonMin) * metresPerDegLon) / cellSizeMetres),
    );
    const height = Math.max(
      2,
      Math.round(((bbox.latMax - bbox.latMin) * metresPerDegLat) / cellSizeMetres),
    );

    const data = new Float32Array(width * height);

    for (let j = 0; j < height; j++) {
      const lat = bbox.latMax - ((j + 0.5) / height) * (bbox.latMax - bbox.latMin);
      const gy = (latToTileY(lat, this.zoom) - y0) * TILE_PX;
      for (let i = 0; i < width; i++) {
        const lon = bbox.lonMin + ((i + 0.5) / width) * (bbox.lonMax - bbox.lonMin);
        const gx = (lonToTileX(lon, this.zoom) - x0) * TILE_PX;
        data[j * width + i] = bilinear(mosaic, mosaicW, mosaicH, gx - 0.5, gy - 0.5);
      }
    }

    return {
      grid: { bbox, width, height, datum: 'egm2008', data, noDataValue: NO_DATA },
      provenance: {
        source: `AWS Terrain Tiles (Terrarium), zoom ${this.zoom}`,
        url: 'https://registry.opendata.aws/terrain-tiles/',
        licence: 'Mixed public domain / CC-BY; see dataset attribution requirements',
        retrievedAt: new Date().toISOString(),
        resolutionMetres: coverage.resolutionMetres ?? 0,
        datum: 'egm2008',
        verified: false,
        notes: [
          'Datum tagged EGM2008 as the closest single label; the underlying mosaic ' +
            'combines SRTM (EGM96) and NED (NAVD88), so sub-metre vertical accuracy ' +
            'should not be assumed.',
          'Replace with USGS 3DEP before treating any render as a measurement.',
          `${nx * ny} tiles stitched, resampled to ${width}x${height} at ${cellSizeMetres} m.`,
        ],
      },
    };
  }
}

function bilinear(
  src: Float32Array,
  w: number,
  h: number,
  x: number,
  y: number,
): number {
  const x0 = Math.floor(x);
  const y0 = Math.floor(y);
  const fx = x - x0;
  const fy = y - y0;
  const cx0 = clamp(x0, 0, w - 1);
  const cx1 = clamp(x0 + 1, 0, w - 1);
  const cy0 = clamp(y0, 0, h - 1);
  const cy1 = clamp(y0 + 1, 0, h - 1);

  const v00 = src[cy0 * w + cx0]!;
  const v10 = src[cy0 * w + cx1]!;
  const v01 = src[cy1 * w + cx0]!;
  const v11 = src[cy1 * w + cx1]!;

  // Any no-data corner poisons the interpolation; propagate rather than
  // silently averaging a sentinel into the terrain.
  if (v00 === NO_DATA || v10 === NO_DATA || v01 === NO_DATA || v11 === NO_DATA) {
    return NO_DATA;
  }

  const top = v00 + (v10 - v00) * fx;
  const bottom = v01 + (v11 - v01) * fx;
  return top + (bottom - top) * fy;
}

function clamp(v: number, lo: number, hi: number): number {
  return v < lo ? lo : v > hi ? hi : v;
}

async function readCache(dir: string, name: string): Promise<Buffer | null> {
  const { readFile } = await import('node:fs/promises');
  const { join } = await import('node:path');
  try {
    return await readFile(join(dir, name));
  } catch {
    return null;
  }
}

async function writeCache(dir: string, name: string, buf: Buffer): Promise<void> {
  const { writeFile, mkdir } = await import('node:fs/promises');
  const { join } = await import('node:path');
  await mkdir(dir, { recursive: true });
  await writeFile(join(dir, name), buf);
}
