/**
 * Sightline report.
 *
 *   npm run sightline -- bundles/bay-area                     # rank every pair
 *   npm run sightline -- bundles/bay-area --from albany-bulb --to ggb-south-tower
 *   npm run sightline -- bundles/bay-area --k 0.3 --lens 600
 *
 * The ranking mode is the one worth running before a ride: it scores every
 * observer against every target and tells you which stops are worth making,
 * and — just as usefully — which are blocked by something in the way.
 */

import { loadBundle } from '../bundle.ts';
import { analyseSightline, differenceInPixels } from '../sightline.ts';
import type { SightlineResult, ObserverState, TargetState } from '../sightline.ts';
import type { Observer, Target } from '../scene.ts';

interface Args {
  bundleDir: string;
  from?: string;
  to?: string;
  k: number;
  lens: number;
  aspect: number;
  pixels: number;
  eyeHeight?: number;
}

function parseArgs(argv: string[]): Args {
  const flag = (name: string): string | undefined => {
    const i = argv.indexOf(`--${name}`);
    return i >= 0 ? argv[i + 1] : undefined;
  };
  const bundleDir = argv.find((a) => !a.startsWith('--') && argv.indexOf(a) === 0);
  if (!bundleDir) {
    console.error(
      'usage: sightline <bundleDir> [--from <observerId>] [--to <targetId>]\n' +
        '                 [--k <refraction>] [--lens <mm35>] [--eye <metres>]',
    );
    process.exit(2);
  }
  const num = (name: string, dflt: number): number => {
    const v = flag(name);
    return v === undefined ? dflt : Number(v);
  };
  const args: Args = {
    bundleDir,
    k: num('k', 0.13),
    lens: num('lens', 600),
    aspect: num('aspect', 3 / 2),
    pixels: num('pixels', 1920),
  };
  const from = flag('from');
  if (from) args.from = from;
  const to = flag('to');
  if (to) args.to = to;
  const eye = flag('eye');
  if (eye) args.eyeHeight = Number(eye);
  return args;
}

const m = (v: number): string => (Number.isFinite(v) ? `${v.toFixed(2)} m` : '—');
const km = (v: number): string => (Number.isFinite(v) ? `${(v / 1000).toFixed(2)} km` : '∞');

function reportPair(
  observer: Observer,
  target: Target,
  result: SightlineResult,
  args: Args,
): void {
  const px = differenceInPixels(result, args.lens, args.aspect, args.pixels);

  console.log(`\n${observer.name}  ->  ${target.name}`);
  console.log(
    `  ${km(result.distance)} on bearing ${result.bearing.toFixed(1)}°, ` +
      `local radius ${(result.radius / 1000).toFixed(1)} km`,
  );
  console.log(
    `  observer eye ${m((observer.groundElevation ?? 0) + observer.eyeHeight)} above datum, ` +
      `horizon at ${km(result.round.horizonDistance)}`,
  );

  console.log('                        round            flat');
  console.log(
    `  lowest visible        ${m(result.round.lowestVisible).padEnd(16)} ${m(result.flat.lowestVisible)}`,
  );
  console.log(
    `  hidden by curvature   ${m(result.round.hiddenByCurvature).padEnd(16)} ${m(0)}`,
  );
  console.log(
    `  critical eye height   ${m(result.round.criticalObserverHeight).padEnd(16)} —`,
  );

  if (result.round.blockedByObstruction && result.round.blocker) {
    const b = result.round.blocker;
    console.log(
      `  !! occluded by ${b.kind} at ${km(b.distance)}, ${m(b.height)} above datum — ` +
        'not a curvature test',
    );
  }
  if (result.round.fullyHidden) {
    console.log('  !! target entirely hidden');
  }

  console.log(
    `  difference            ${m(result.difference)} = ` +
      `${result.differenceArcmin.toFixed(2)}' = ${px.toFixed(0)} px at ${args.lens} mm`,
  );
}

function score(result: SightlineResult): number {
  // Obstructed sightlines are worthless as curvature tests however large the
  // curvature term is, so they score zero rather than merely low.
  if (result.round.blockedByObstruction || result.round.fullyHidden) return 0;
  return result.differenceArcmin;
}

async function main(): Promise<void> {
  const args = parseArgs(process.argv.slice(2));
  const bundle = await loadBundle(args.bundleDir);
  const scene = bundle.manifest.scene;

  console.log(`${scene.name}`);
  console.log(
    `  k = ${args.k}, lens ${args.lens} mm (35 mm equiv), ${args.pixels} px wide`,
  );
  if (bundle.buildings.length === 0) {
    console.log('  !! bundle has no buildings; occlusion is terrain-only');
  }

  const observers = args.from
    ? scene.observers.filter((o) => o.id === args.from)
    : scene.observers;
  const targets = args.to ? scene.targets.filter((t) => t.id === args.to) : scene.targets;

  if (!observers.length) throw new Error(`no observer matching '${args.from}'`);
  if (!targets.length) throw new Error(`no target matching '${args.to}'`);

  const rows: { observer: Observer; target: Target; result: SightlineResult }[] = [];

  for (const observer of observers) {
    for (const target of targets) {
      const obsState: ObserverState = {
        position: { lat: observer.lat, lon: observer.lon },
        groundElevation: observer.groundElevation ?? 0,
        eyeHeight: args.eyeHeight ?? observer.eyeHeight,
      };
      const tgtState: TargetState = {
        position: { lat: target.lat, lon: target.lon },
        baseElevation: target.baseElevation ?? 0,
        structureHeight: target.structureHeight ?? 0,
      };
      const result = analyseSightline(bundle, obsState, tgtState, { k: args.k });
      rows.push({ observer, target, result });
    }
  }

  const single = observers.length === 1 && targets.length === 1;
  if (single) {
    reportPair(rows[0]!.observer, rows[0]!.target, rows[0]!.result, args);
  } else {
    rows.sort((a, b) => score(b.result) - score(a.result));
    console.log('\nRanked by observable signal (obstructed pairs score zero):\n');
    console.log(
      '  ' +
        'observer'.padEnd(20) +
        'target'.padEnd(28) +
        'dist'.padStart(9) +
        'diff'.padStart(9) +
        'arcmin'.padStart(8) +
        'px'.padStart(6) +
        '  note',
    );
    for (const { observer, target, result } of rows) {
      const px = differenceInPixels(result, args.lens, args.aspect, args.pixels);
      const blocked = result.round.blockedByObstruction || result.round.fullyHidden;
      const note = result.round.fullyHidden
        ? 'fully hidden'
        : result.round.blockedByObstruction && result.round.blocker
          ? `blocked by ${result.round.blocker.kind} at ${km(result.round.blocker.distance)}`
          : '';
      console.log(
        '  ' +
          observer.id.padEnd(20) +
          target.id.padEnd(28) +
          km(result.distance).padStart(9) +
          `${result.difference.toFixed(1)} m`.padStart(9) +
          result.differenceArcmin.toFixed(2).padStart(8) +
          (blocked ? '—' : px.toFixed(0)).padStart(6) +
          (note ? `  ${note}` : ''),
      );
    }
  }

  if (bundle.manifest.unverified.length) {
    console.log(
      `\n${bundle.manifest.unverified.length} unverified assumptions underlie these ` +
        'numbers; see the bundle manifest. Treat as planning, not measurement.',
    );
  }
}

main().catch((err: unknown) => {
  console.error(err instanceof Error ? err.message : err);
  process.exit(1);
});
