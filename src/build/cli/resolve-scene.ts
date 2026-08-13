/**
 * Resolve a scene's guessed coordinates against the bundle's own data.
 *
 *   npm run resolve:scene -- bundles/bay-area [--out scenes/bay-area.json]
 *
 * Prints what moved and by how much. Without --out it is a dry run, which is
 * the right default: this rewrites hand-authored config, and you want to read
 * the diff before taking it.
 */

import { loadBundle } from '../bundle.ts';
import { resolveScene } from '../resolve.ts';
import { loadScene } from '../scene.ts';

async function main(): Promise<void> {
  const argv = process.argv.slice(2);
  const bundleDir = argv.find((a) => !a.startsWith('--'));
  if (!bundleDir) {
    console.error(
      'usage: resolve:scene <bundleDir> [--scene <scene.json>] [--out <scene.json>]',
    );
    process.exit(2);
  }
  const outIndex = argv.indexOf('--out');
  const outPath = outIndex >= 0 ? argv[outIndex + 1] : undefined;
  const sceneIndex = argv.indexOf('--scene');
  const scenePath = sceneIndex >= 0 ? argv[sceneIndex + 1] : undefined;

  const bundle = await loadBundle(bundleDir);
  // Prefer the live config over the manifest's snapshot: the manifest records
  // what was built, and edits since then would otherwise be silently ignored.
  const sceneOverride = scenePath ? await loadScene(scenePath) : undefined;
  if (bundle.buildings.length === 0) {
    console.warn(
      '!! bundle has no buildings; building name matching will find nothing and ' +
        'every target will fall through to terrain snapping',
    );
  }

  const { scene, changes, unchanged } = resolveScene(bundle, {}, sceneOverride);

  console.log(`${scene.name}`);
  console.log(`  ${bundle.buildings.length} buildings available for name matching\n`);

  if (changes.length === 0) {
    console.log('Nothing to resolve.');
  } else {
    console.log('  ' + 'id'.padEnd(24) + 'kind'.padEnd(10) + 'moved'.padStart(9) + '  detail');
    for (const c of changes) {
      console.log(
        '  ' +
          c.id.padEnd(24) +
          c.kind.padEnd(10) +
          `${c.movedBy.toFixed(0)} m`.padStart(9) +
          `  ${c.detail}${c.verified ? '  [verified]' : ''}`,
      );
    }
  }

  if (unchanged.length) {
    console.log(`\nUnchanged: ${unchanged.join(', ')}`);
  }

  const verified = changes.filter((c) => c.verified).length;
  console.log(
    `\n${verified} of ${changes.length} changes were confirmed against an independent ` +
      'source; the rest are self-consistent with the scene DEM but not verified.',
  );

  if (outPath) {
    const { writeFile } = await import('node:fs/promises');
    await writeFile(outPath, `${JSON.stringify(scene, null, 2)}\n`);
    console.log(`\nWrote ${outPath}`);
  } else {
    console.log('\nDry run. Pass --out <scene.json> to write the resolved scene.');
  }
}

main().catch((err: unknown) => {
  console.error(err instanceof Error ? err.message : err);
  process.exit(1);
});
