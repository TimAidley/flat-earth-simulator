/**
 * Buildings from Overture Maps.
 *
 * Overture merges OpenStreetMap, Microsoft ML footprints, Google Open
 * Buildings and Esri into one schema with `height`, `num_floors` and
 * `roof_shape`, and publishes GeoParquet on a public S3 bucket. DuckDB reads
 * it with predicate pushdown on the `bbox` struct column, so a bounding-box
 * extract touches a small fraction of the planet-scale dataset.
 *
 * `height` is null for most buildings worldwide, but the correlation runs our
 * way: tall buildings in major cities are exactly what OSM mappers tag, and
 * tall buildings are exactly what forms a horizon. Where it is missing we fall
 * back to floors, then to a default — and record which, because a render built
 * on assumed heights is not a measurement.
 *
 * ## Not exercised in the development sandbox
 *
 * This provider needs DuckDB's `spatial` and `httpfs` extensions, which are
 * fetched at runtime from extensions.duckdb.org. That host is blocked by the
 * sandbox's network policy (HTTP 403 at the proxy), so this code path has been
 * written against the documented Overture access pattern but not run against
 * live data here. It should work unmodified on a machine with normal egress;
 * `buildings-overture.test.ts` covers the pure logic (height fallback, WKB
 * decoding) that does not need the network.
 */

import type {
  BBox,
  Building,
  BuildingProvider,
  Coverage,
  HeightSource,
  Provenance,
} from './types.ts';
import { ProviderUnavailableError } from './types.ts';

/** Metres per storey when only a floor count is known. */
export const METRES_PER_FLOOR = 3.2;

/** Last-resort height when neither a measurement nor a floor count exists. */
export const DEFAULT_BUILDING_HEIGHT = 8;

export interface OvertureOptions {
  /** Overture release, e.g. '2026-07-22.0'. */
  release: string;
  s3Region?: string;
}

/** Resolve a height and record how we got it. */
export function resolveHeight(
  height: number | null | undefined,
  numFloors: number | null | undefined,
): { height: number; heightSource: HeightSource } {
  if (height != null && Number.isFinite(height) && height > 0) {
    return { height, heightSource: 'measured' };
  }
  if (numFloors != null && Number.isFinite(numFloors) && numFloors > 0) {
    return { height: numFloors * METRES_PER_FLOOR, heightSource: 'floors' };
  }
  return { height: DEFAULT_BUILDING_HEIGHT, heightSource: 'default' };
}

/** Describe an unknown value well enough to debug a type mismatch from a log. */
function describe(value: unknown): string {
  if (value === null) return 'null';
  if (value === undefined) return 'undefined';
  const t = typeof value;
  if (t !== 'object') return t;
  const ctor = (value as object).constructor?.name ?? '(no constructor)';
  const keys = Object.keys(value as object).slice(0, 6).join(',');
  return `${ctor}{${keys}}`;
}

/**
 * Coerce whatever the database driver hands back for a BLOB column into bytes.
 *
 * Drivers disagree about this — a BLOB may arrive as a Uint8Array, a Node
 * Buffer, a raw ArrayBuffer, or a wrapper object with the bytes on a property.
 * Getting it wrong throws deep inside the WKB reader, which previously meant
 * every building was silently dropped while the height counters still reported
 * thousands of successes. Handle the shapes explicitly, and when none matches,
 * say exactly what arrived instead.
 */
export function toBytes(value: unknown): Uint8Array {
  if (value instanceof Uint8Array) return value; // also covers Buffer
  if (value instanceof ArrayBuffer) return new Uint8Array(value);
  if (ArrayBuffer.isView(value)) {
    return new Uint8Array(value.buffer, value.byteOffset, value.byteLength);
  }
  if (value && typeof value === 'object') {
    for (const prop of ['bytes', 'data', 'value'] as const) {
      const inner = (value as Record<string, unknown>)[prop];
      if (inner instanceof Uint8Array) return inner;
      if (inner instanceof ArrayBuffer) return new Uint8Array(inner);
    }
  }
  throw new Error(`Cannot interpret BLOB value as bytes: got ${describe(value)}`);
}

/**
 * Decode the exterior ring of a WKB polygon or multipolygon into [lon, lat]
 * pairs. Interior rings are dropped: a hole cannot occlude anything, so it has
 * no bearing on a sightline. For a multipolygon the largest ring wins.
 */
export function wkbExteriorRing(wkb: Uint8Array): [number, number][] {
  const view = new DataView(wkb.buffer, wkb.byteOffset, wkb.byteLength);
  let offset = 0;

  const littleEndian = view.getUint8(offset) === 1;
  offset += 1;
  const type = view.getUint32(offset, littleEndian);
  offset += 4;

  const readRing = (): [number, number][] => {
    const n = view.getUint32(offset, littleEndian);
    offset += 4;
    const ring: [number, number][] = [];
    for (let i = 0; i < n; i++) {
      const x = view.getFloat64(offset, littleEndian);
      const y = view.getFloat64(offset + 8, littleEndian);
      offset += 16;
      ring.push([x, y]);
    }
    return ring;
  };

  const readPolygon = (): [number, number][] => {
    const nRings = view.getUint32(offset, littleEndian);
    offset += 4;
    let exterior: [number, number][] = [];
    for (let r = 0; r < nRings; r++) {
      const ring = readRing();
      if (r === 0) exterior = ring;
    }
    return exterior;
  };

  const geomType = type & 0xff;
  if (geomType === 3) return readPolygon();

  if (geomType === 6) {
    const nPolys = view.getUint32(offset, littleEndian);
    offset += 4;
    let best: [number, number][] = [];
    for (let p = 0; p < nPolys; p++) {
      offset += 1; // per-geometry byte order
      offset += 4; // per-geometry type
      const ring = readPolygon();
      if (ring.length > best.length) best = ring;
    }
    return best;
  }

  throw new Error(`Unsupported WKB geometry type ${geomType}; expected polygon or multipolygon`);
}

export class OvertureBuildingProvider implements BuildingProvider {
  readonly id = 'overture';

  constructor(private readonly opts: OvertureOptions) {}

  async coverage(_bbox: BBox): Promise<Coverage> {
    return {
      available: true,
      notes: [
        'Overture is global, but height completeness tracks OpenStreetMap density. ' +
          'Expect good coverage of tall buildings in major cities and sparse coverage elsewhere.',
      ],
    };
  }

  async fetch(
    bbox: BBox,
    minHeightMetres: number,
  ): Promise<{ buildings: Building[]; provenance: Provenance }> {
    const { DuckDBInstance } = await importDuckDB(this.id);
    const instance = await DuckDBInstance.create(':memory:');
    const conn = await instance.connect();

    try {
      await conn.run(
        `INSTALL spatial; LOAD spatial; INSTALL httpfs; LOAD httpfs;
         SET s3_region='${this.opts.s3Region ?? 'us-west-2'}';`,
      );
    } catch (cause) {
      throw new ProviderUnavailableError(
        this.id,
        'could not load DuckDB spatial/httpfs extensions (they are fetched from ' +
          'extensions.duckdb.org at runtime; check network egress)',
        cause,
      );
    }

    const path =
      `s3://overturemaps-us-west-2/release/${this.opts.release}` +
      `/theme=buildings/type=building/*.parquet`;

    // The bbox struct is a native column, so this filter is pushed down to the
    // parquet row-group statistics rather than scanning the planet.
    const sql = `
      SELECT
        id,
        names.primary          AS name,
        height,
        num_floors             AS num_floors,
        ST_AsWKB(geometry)     AS wkb
      FROM read_parquet('${path}', hive_partitioning=1)
      WHERE bbox.xmin >= ${bbox.lonMin} AND bbox.xmax <= ${bbox.lonMax}
        AND bbox.ymin >= ${bbox.latMin} AND bbox.ymax <= ${bbox.latMax}
        AND (height >= ${minHeightMetres}
             OR num_floors >= ${Math.ceil(minHeightMetres / METRES_PER_FLOOR)})
    `;

    let rows: Record<string, unknown>[];
    try {
      const result = await conn.runAndReadAll(sql);
      rows = result.getRowObjects();
    } catch (cause) {
      throw new ProviderUnavailableError(this.id, 'Overture query failed', cause);
    }

    const buildings: Building[] = [];
    let measured = 0;
    let fromFloors = 0;
    let defaulted = 0;
    let geometryFailures = 0;
    let firstGeometryError: string | undefined;

    for (const row of rows) {
      // Decode geometry first. Counting a building before knowing we can place
      // it is how the counters once reported thousands of heights for an empty
      // output.
      let footprint: [number, number][];
      try {
        footprint = wkbExteriorRing(toBytes(row['wkb']));
      } catch (err) {
        geometryFailures++;
        firstGeometryError ??= err instanceof Error ? err.message : String(err);
        continue;
      }
      if (footprint.length < 3) {
        geometryFailures++;
        firstGeometryError ??= `ring had only ${footprint.length} points`;
        continue;
      }

      const { height, heightSource } = resolveHeight(
        row['height'] as number | null,
        row['num_floors'] as number | null,
      );
      if (heightSource === 'measured') measured++;
      else if (heightSource === 'floors') fromFloors++;
      else defaulted++;

      const b: Building = {
        id: String(row['id']),
        height,
        heightSource,
        footprint,
      };
      const name = row['name'];
      if (typeof name === 'string') b.name = name;
      const floors = row['num_floors'];
      if (typeof floors === 'number') b.numFloors = floors;
      buildings.push(b);
    }

    // Rows arriving but nothing surviving means a decoding bug, not sparse
    // data. Fail rather than hand back an empty layer that looks deliberate.
    if (rows.length > 0 && buildings.length === 0) {
      throw new ProviderUnavailableError(
        this.id,
        `all ${rows.length} rows failed geometry decoding — first error: ` +
          `${firstGeometryError ?? 'unknown'}`,
      );
    }

    return {
      buildings,
      provenance: {
        source: `Overture Maps buildings, release ${this.opts.release}`,
        url: 'https://docs.overturemaps.org/guides/buildings/',
        licence: 'ODbL / CDLA-Permissive, per source; attribution required',
        retrievedAt: new Date().toISOString(),
        verified: defaulted === 0 && fromFloors === 0 && geometryFailures === 0,
        notes: [
          `${buildings.length} buildings at or above ${minHeightMetres} m ` +
            `(from ${rows.length} rows).`,
          `Heights: ${measured} measured, ${fromFloors} derived from floor count, ` +
            `${defaulted} defaulted to ${DEFAULT_BUILDING_HEIGHT} m.`,
          ...(geometryFailures > 0
            ? [
                `${geometryFailures} rows dropped on geometry decoding — first error: ` +
                  `${firstGeometryError}`,
              ]
            : []),
          ...(defaulted > 0
            ? [
                'Buildings with defaulted heights are effectively unknown and should ' +
                  'not be used as measurement references.',
              ]
            : []),
        ],
      },
    };
  }
}

async function importDuckDB(providerId: string): Promise<typeof import('@duckdb/node-api')> {
  try {
    return await import('@duckdb/node-api');
  } catch (cause) {
    throw new ProviderUnavailableError(
      providerId,
      'DuckDB is not installed; run `npm install @duckdb/node-api`',
      cause,
    );
  }
}
