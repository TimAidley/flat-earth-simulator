/**
 * Inspect Overture features near a point.
 *
 *   npm run probe -- --theme base --type infrastructure \
 *     --bbox -122.49,37.80,-122.46,37.84 --where "subtype = 'bridge'"
 *
 * Exists because some features cannot be resolved automatically from the
 * buildings layer and have to be found by hand first. The Golden Gate towers
 * are the case in point: they carry the best sightlines on the Bay Trail and
 * are neither buildings nor summits, so their coordinates stayed hand-typed
 * while everything around them got verified.
 *
 * Needs DuckDB's spatial and httpfs extensions, which are fetched at runtime
 * and are unreachable from some development sandboxes — run it on a CI runner
 * when that is the case.
 */

import { ProviderUnavailableError } from '../providers/types.ts';

const DEFAULT_RELEASE = '2026-07-22.0';

interface Args {
  theme: string;
  type: string;
  bbox: [number, number, number, number];
  where?: string;
  columns: string;
  limit: number;
  release: string;
}

function parseArgs(argv: string[]): Args {
  const flag = (name: string): string | undefined => {
    const i = argv.indexOf(`--${name}`);
    return i >= 0 ? argv[i + 1] : undefined;
  };
  const bboxRaw = flag('bbox');
  if (!bboxRaw) {
    console.error(
      'usage: probe --theme <theme> --type <type> --bbox <minLon,minLat,maxLon,maxLat>\n' +
        '             [--where <sql>] [--columns <sql>] [--limit <n>] [--release <id>]',
    );
    process.exit(2);
  }
  const parts = bboxRaw.split(',').map(Number);
  if (parts.length !== 4 || parts.some(Number.isNaN)) {
    throw new Error(`bad --bbox '${bboxRaw}'; expected minLon,minLat,maxLon,maxLat`);
  }
  const args: Args = {
    theme: flag('theme') ?? 'base',
    type: flag('type') ?? 'infrastructure',
    bbox: parts as [number, number, number, number],
    columns: flag('columns') ?? 'subtype, class, names.primary AS name',
    limit: Number(flag('limit') ?? 60),
    release: flag('release') ?? DEFAULT_RELEASE,
  };
  const where = flag('where');
  if (where) args.where = where;
  return args;
}

async function main(): Promise<void> {
  const args = parseArgs(process.argv.slice(2));
  const { DuckDBInstance } = await import('@duckdb/node-api');
  const instance = await DuckDBInstance.create(':memory:');
  const conn = await instance.connect();

  try {
    await conn.run(
      `INSTALL spatial; LOAD spatial; INSTALL httpfs; LOAD httpfs; SET s3_region='us-west-2';`,
    );
  } catch (cause) {
    throw new ProviderUnavailableError(
      'probe',
      'could not load DuckDB spatial/httpfs extensions (fetched from extensions.duckdb.org)',
      cause,
    );
  }

  const [minLon, minLat, maxLon, maxLat] = args.bbox;
  const path =
    `s3://overturemaps-us-west-2/release/${args.release}` +
    `/theme=${args.theme}/type=${args.type}/*.parquet`;

  const sql = `
    SELECT
      id,
      ${args.columns},
      round(ST_Y(ST_Centroid(geometry)), 7) AS lat,
      round(ST_X(ST_Centroid(geometry)), 7) AS lon,
      ST_GeometryType(geometry)             AS geom_type,
      round(ST_Length(ST_Boundary(geometry)), 1) AS boundary_m
    FROM read_parquet('${path}', hive_partitioning=1)
    WHERE bbox.xmin >= ${minLon} AND bbox.xmax <= ${maxLon}
      AND bbox.ymin >= ${minLat} AND bbox.ymax <= ${maxLat}
      ${args.where ? `AND (${args.where})` : ''}
    LIMIT ${args.limit}
  `;

  console.log(`# ${args.theme}/${args.type} @ ${args.release}`);
  console.log(`# bbox ${args.bbox.join(', ')}${args.where ? `  where ${args.where}` : ''}\n`);

  const rows = (await conn.runAndReadAll(sql)).getRowObjects();
  if (rows.length === 0) {
    console.log('(no features matched)');
    return;
  }
  for (const row of rows) {
    console.log(JSON.stringify(row));
  }
  console.log(`\n${rows.length} features`);
}

main().catch((err: unknown) => {
  console.error(err instanceof Error ? err.message : err);
  process.exit(1);
});
