/**
 * Build a scene bundle.
 *
 *   npm run build:scene -- scenes/bay-area.json [--out bundles/bay-area] [--strict]
 *
 * A provider that cannot reach its source is reported loudly and recorded in
 * the manifest's `unverified` list rather than aborting the build, so a
 * partial bundle is still useful — terrain alone answers most occlusion
 * questions. `--strict` turns any such failure into an error, which is what
 * you want in CI or before treating a bundle as a measurement.
 */

import { join } from 'node:path';
import { loadScene, unverifiedItems } from '../scene.ts';
import { TerrariumTerrainProvider } from '../providers/terrain-terrarium.ts';
import { OvertureBuildingProvider } from '../providers/buildings-overture.ts';
import { NoaaTideProvider } from '../providers/tide-noaa.ts';
import { ProviderUnavailableError } from '../providers/types.ts';
import type { Building, Provenance, TideStation } from '../providers/types.ts';
import { writeBundle, sampleTerrain } from '../bundle.ts';
import { expandStructure, towerSpan } from '../structures.ts';

interface Args {
  scenePath: string;
  outDir: string;
  strict: boolean;
  cacheDir: string;
}

function parseArgs(argv: string[]): Args {
  const positional = argv.filter((a) => !a.startsWith('--'));
  const scenePath = positional[0];
  if (!scenePath) {
    console.error('usage: build:scene <scene.json> [--out <dir>] [--strict]');
    process.exit(2);
  }
  const outIndex = argv.indexOf('--out');
  const sceneId = scenePath.replace(/.*\//, '').replace(/\.json$/, '');
  return {
    scenePath,
    outDir: outIndex >= 0 ? argv[outIndex + 1]! : join('bundles', sceneId),
    strict: argv.includes('--strict'),
    cacheDir: join('.cache', 'tiles'),
  };
}

function failedProvenance(source: string, reason: string): Provenance {
  return {
    source,
    licence: 'n/a',
    retrievedAt: new Date().toISOString(),
    verified: false,
    notes: [`LAYER MISSING: ${reason}`],
  };
}

async function main(): Promise<void> {
  const args = parseArgs(process.argv.slice(2));
  const scene = await loadScene(args.scenePath);
  const unverified = unverifiedItems(scene);

  console.log(`Building '${scene.name}'`);
  console.log(
    `  bbox ${scene.bbox.latMin}..${scene.bbox.latMax} N, ` +
      `${scene.bbox.lonMin}..${scene.bbox.lonMax} E`,
  );

  // --- terrain -------------------------------------------------------------
  const terrainProvider = new TerrariumTerrainProvider({
    zoom: scene.terrain.zoom ?? 13,
    cacheDir: args.cacheDir,
  });
  const coverage = await terrainProvider.coverage(scene.bbox);
  console.log(
    `  terrain: ${terrainProvider.id}, native ~${coverage.resolutionMetres?.toFixed(1)} m/px, ` +
      `resampling to ${scene.terrain.cellSizeMetres} m`,
  );
  const terrain = await terrainProvider.fetch(scene.bbox, scene.terrain.cellSizeMetres);
  console.log(`    ${terrain.grid.width} x ${terrain.grid.height} cells`);

  // Global DEMs carry bathymetry, so open water arrives as seafloor depth, not
  // water surface. Without this every over-water sightline would be tested
  // against a surface ~20 m below the one that actually blocks it.
  const clampLevel = scene.terrain.clampBelowToLevel;
  if (clampLevel !== undefined) {
    const { data, noDataValue } = terrain.grid;
    let clamped = 0;
    for (let i = 0; i < data.length; i++) {
      const v = data[i]!;
      if (v !== noDataValue && v < clampLevel) {
        data[i] = clampLevel;
        clamped++;
      }
    }
    const pct = ((clamped / data.length) * 100).toFixed(1);
    console.log(`    clamped ${clamped} cells (${pct}%) up to ${clampLevel} m`);
    terrain.provenance.notes = [
      ...(terrain.provenance.notes ?? []),
      `${clamped} cells (${pct}%) below ${clampLevel} m were raised to it, standing in ` +
        'for a water surface. This assumes nothing in the scene is genuinely below that ' +
        'level; a coastline-derived water mask would remove the assumption.',
    ];
    unverified.push(
      `terrain: bathymetry clamped to ${clampLevel} m in place of a real water mask ` +
        `(${pct}% of cells affected)`,
    );
  }

  // --- buildings -----------------------------------------------------------
  let buildings: { buildings: Building[]; provenance: Provenance };
  try {
    const provider = new OvertureBuildingProvider({ release: scene.buildings.release });
    console.log(`  buildings: ${provider.id} ${scene.buildings.release}`);
    buildings = await provider.fetch(scene.bbox, scene.buildings.minHeightMetres);
    console.log(`    ${buildings.buildings.length} buildings`);
  } catch (err) {
    if (args.strict || !(err instanceof ProviderUnavailableError)) throw err;
    const reason = err.message;
    console.warn(`  !! buildings unavailable: ${reason}`);
    console.warn('     continuing without them; re-run with --strict to make this fatal');
    buildings = { buildings: [], provenance: failedProvenance('Overture Maps buildings', reason) };
    unverified.push(`buildings layer missing: ${reason}`);
  }

  // --- structures ----------------------------------------------------------
  // Expanded into ordinary buildings so the renderer and the sightline
  // calculator handle them through the paths they already have.
  for (const structure of scene.structures ?? []) {
    const parts = expandStructure(structure);
    buildings.buildings.push(...parts);
    const span = towerSpan(structure);
    console.log(
      `  structure: ${structure.name} -> ${parts.length} parts, ` +
        `tower span ${span.toFixed(1)} m`,
    );
    buildings.provenance.notes = [
      ...(buildings.provenance.notes ?? []),
      `${structure.name}: ${parts.length} parts from published dimensions. ${structure.source}`,
    ];
    if (!structure.verified) {
      unverified.push(`structure '${structure.id}': ${structure.source}`);
    }
  }

  // --- tide ----------------------------------------------------------------
  let tide: { stations: TideStation[]; provenance: Provenance } | undefined;
  if (scene.tide) {
    try {
      const provider = new NoaaTideProvider();
      console.log(`  tide: ${provider.id}, stations ${scene.tide.stationIds.join(', ')}`);
      tide = await provider.fetch(scene.tide.stationIds);
      console.log(`    ${tide.stations.length} stations`);
    } catch (err) {
      if (args.strict || !(err instanceof ProviderUnavailableError)) throw err;
      console.warn(`  !! tide unavailable: ${err.message}`);
      unverified.push(`tide layer missing: ${err.message}`);
    }
  }

  // --- observer ground elevations -----------------------------------------
  // Sampled from terrain rather than taken from GPS altitude: consumer GNSS
  // vertical error is 10-20 m against an effect of a few metres, whereas on
  // ground this flat a horizontal fix error costs almost nothing vertically.
  for (const observer of scene.observers) {
    if (observer.groundElevation !== undefined) continue;
    const sampled = sampleTerrain(terrain.grid, observer.lat, observer.lon);
    if (sampled === null) {
      unverified.push(`observer '${observer.id}': no terrain data at this location`);
      continue;
    }
    observer.groundElevation = sampled;
  }

  const manifest = await writeBundle(args.outDir, {
    scene,
    terrain,
    buildings,
    ...(tide ? { tide } : {}),
    unverified,
  });

  console.log(`\nWrote ${args.outDir}`);
  console.log(`  terrain.f32     ${manifest.terrain.width * manifest.terrain.height * 4} bytes`);
  console.log(`  buildings.json  ${manifest.buildings.count} features`);

  if (manifest.unverified.length) {
    console.log(`\n${manifest.unverified.length} unverified assumptions in this bundle:`);
    for (const item of manifest.unverified) console.log(`  - ${item}`);
    console.log(
      '\nThis bundle can be rendered, but is not a measurement until these are resolved.',
    );
  } else {
    console.log('\nEvery layer and coordinate has a cited source.');
  }
}

main().catch((err: unknown) => {
  console.error(err instanceof Error ? err.message : err);
  process.exit(1);
});
