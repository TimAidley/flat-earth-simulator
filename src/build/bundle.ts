/**
 * Scene bundle: a self-contained, offline-capable directory holding everything
 * one scene needs.
 *
 * Written as a manifest plus raw binary side-cars rather than one packed file,
 * so the browser can range-request the terrain grid without parsing JSON
 * around it, and so a human can inspect what was built.
 *
 * The manifest carries provenance for every layer and an explicit list of
 * unverified assumptions. That list is the difference between a picture and a
 * measurement, and the renderer is expected to surface it rather than bury it.
 */

import type { Provenance, TerrainGrid, Building, TideStation } from './providers/types.ts';
import type { SceneConfig } from './scene.ts';

export const BUNDLE_FORMAT_VERSION = 1;

export interface BundleManifest {
  formatVersion: number;
  scene: SceneConfig;
  builtAt: string;
  terrain: {
    file: string;
    width: number;
    height: number;
    bbox: SceneConfig['bbox'];
    datum: string;
    noDataValue: number;
    /** Row-major, row 0 at latMax, column 0 at lonMin. */
    layout: 'row-major-north-west-origin';
    dtype: 'float32';
    provenance: Provenance;
  };
  buildings: {
    file: string;
    count: number;
    minHeightMetres: number;
    provenance: Provenance;
  };
  tide?: {
    file: string;
    stationCount: number;
    provenance: Provenance;
  };
  /**
   * Everything in this bundle resting on an unchecked assumption. Empty means
   * every layer and every coordinate has a cited source.
   */
  unverified: string[];
}

export interface BundleInput {
  scene: SceneConfig;
  terrain: { grid: TerrainGrid; provenance: Provenance };
  buildings: { buildings: Building[]; provenance: Provenance };
  tide?: { stations: TideStation[]; provenance: Provenance };
  unverified: string[];
}

/** Write a bundle to `outDir`, creating it if needed. Returns the manifest. */
export async function writeBundle(
  outDir: string,
  input: BundleInput,
): Promise<BundleManifest> {
  const { mkdir, writeFile } = await import('node:fs/promises');
  const { join } = await import('node:path');

  await mkdir(outDir, { recursive: true });

  const { grid } = input.terrain;
  await writeFile(join(outDir, 'terrain.f32'), Buffer.from(grid.data.buffer));
  await writeFile(
    join(outDir, 'buildings.json'),
    JSON.stringify(input.buildings.buildings),
  );

  const manifest: BundleManifest = {
    formatVersion: BUNDLE_FORMAT_VERSION,
    scene: input.scene,
    builtAt: new Date().toISOString(),
    terrain: {
      file: 'terrain.f32',
      width: grid.width,
      height: grid.height,
      bbox: grid.bbox,
      datum: grid.datum,
      noDataValue: grid.noDataValue,
      layout: 'row-major-north-west-origin',
      dtype: 'float32',
      provenance: input.terrain.provenance,
    },
    buildings: {
      file: 'buildings.json',
      count: input.buildings.buildings.length,
      minHeightMetres: input.scene.buildings.minHeightMetres,
      provenance: input.buildings.provenance,
    },
    unverified: input.unverified,
  };

  if (input.tide) {
    await writeFile(join(outDir, 'tide.json'), JSON.stringify(input.tide.stations));
    manifest.tide = {
      file: 'tide.json',
      stationCount: input.tide.stations.length,
      provenance: input.tide.provenance,
    };
  }

  await writeFile(join(outDir, 'manifest.json'), JSON.stringify(manifest, null, 2));
  return manifest;
}

export interface LoadedBundle {
  manifest: BundleManifest;
  terrain: TerrainGrid;
  buildings: Building[];
}

/** Read a bundle written by {@link writeBundle}. */
export async function loadBundle(dir: string): Promise<LoadedBundle> {
  const { readFile } = await import('node:fs/promises');
  const { join } = await import('node:path');

  const manifest = JSON.parse(
    await readFile(join(dir, 'manifest.json'), 'utf8'),
  ) as BundleManifest;

  if (manifest.formatVersion !== BUNDLE_FORMAT_VERSION) {
    throw new Error(
      `Bundle format version ${manifest.formatVersion} does not match ` +
        `${BUNDLE_FORMAT_VERSION}; rebuild the scene.`,
    );
  }

  const raw = await readFile(join(dir, manifest.terrain.file));
  const terrain: TerrainGrid = {
    bbox: manifest.terrain.bbox,
    width: manifest.terrain.width,
    height: manifest.terrain.height,
    datum: manifest.terrain.datum as TerrainGrid['datum'],
    noDataValue: manifest.terrain.noDataValue,
    data: new Float32Array(raw.buffer, raw.byteOffset, raw.byteLength / 4),
  };

  const buildings = JSON.parse(
    await readFile(join(dir, manifest.buildings.file), 'utf8'),
  ) as Building[];

  return { manifest, terrain, buildings };
}

/**
 * Sample a terrain grid at a latitude/longitude, bilinearly.
 * Returns `null` outside the grid or where the source had no data.
 */
export function sampleTerrain(grid: TerrainGrid, lat: number, lon: number): number | null {
  const { bbox, width, height, data, noDataValue } = grid;
  if (lat < bbox.latMin || lat > bbox.latMax || lon < bbox.lonMin || lon > bbox.lonMax) {
    return null;
  }

  const fx = ((lon - bbox.lonMin) / (bbox.lonMax - bbox.lonMin)) * width - 0.5;
  const fy = ((bbox.latMax - lat) / (bbox.latMax - bbox.latMin)) * height - 0.5;

  const x0 = Math.max(0, Math.min(width - 1, Math.floor(fx)));
  const y0 = Math.max(0, Math.min(height - 1, Math.floor(fy)));
  const x1 = Math.min(width - 1, x0 + 1);
  const y1 = Math.min(height - 1, y0 + 1);
  const tx = Math.max(0, Math.min(1, fx - x0));
  const ty = Math.max(0, Math.min(1, fy - y0));

  const v00 = data[y0 * width + x0]!;
  const v10 = data[y0 * width + x1]!;
  const v01 = data[y1 * width + x0]!;
  const v11 = data[y1 * width + x1]!;
  if (
    v00 === noDataValue ||
    v10 === noDataValue ||
    v01 === noDataValue ||
    v11 === noDataValue
  ) {
    return null;
  }

  const top = v00 + (v10 - v00) * tx;
  const bottom = v01 + (v11 - v01) * tx;
  return top + (bottom - top) * ty;
}
