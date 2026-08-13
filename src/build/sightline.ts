/**
 * Sightline analysis: what an observer can actually see of a target, given
 * curvature, refraction, and everything in the way.
 *
 * Curvature is rarely the thing that hides a distant object — intervening
 * terrain and buildings usually get there first, and a curvature figure quoted
 * without an occlusion check is worse than useless because it sounds precise.
 * So the profile walk is the main event here and the closed-form hidden height
 * is a sanity check alongside it.
 *
 * Everything is computed for both models from the same code path, differing
 * only in `invR`. There is no separate "flat" branch to drift out of step.
 */

import {
  geodesicInverse,
  geodesicDirect,
  eulerRadius,
  inverseEffectiveRadius,
  apparentElevation,
  hiddenHeight,
  criticalObserverHeight,
  horizonDistance,
  angularSizeArcmin,
  horizontalFovDeg,
  arcminPerPixel,
  type LatLon,
} from '../core/index.ts';
import { sampleTerrain, type LoadedBundle } from './bundle.ts';
import type { Building } from './providers/types.ts';

export interface ObserverState {
  position: LatLon;
  /** Ground elevation above the scene datum, metres. */
  groundElevation: number;
  /** Eye height above ground, metres. */
  eyeHeight: number;
}

export interface TargetState {
  position: LatLon;
  /** Base elevation above the scene datum, metres. */
  baseElevation: number;
  /** Structure height above its base, metres. */
  structureHeight: number;
}

/** One sample along the ray. */
export interface ProfileSample {
  /** Surface distance from the observer, metres. */
  distance: number;
  /** Terrain height above datum, metres; null where the grid had no data. */
  terrain: number | null;
  /** Tallest building at this point above datum, metres; null if none. */
  building: number | null;
  /** Apparent elevation of the obstruction top, radians. */
  elevation: number;
}

export interface ModelResult {
  /** Inverse effective radius used, 1/m. */
  invR: number;
  /** Refraction coefficient used. */
  k: number;
  /** Distance to the observer's own horizon, metres. Infinite when flat. */
  horizonDistance: number;
  /** Closed-form hidden height ignoring obstructions, metres. */
  hiddenByCurvature: number;
  /** Eye height at which curvature alone stops hiding anything, metres. */
  criticalObserverHeight: number;
  /**
   * Lowest point of the target still visible, as a height above datum, taking
   * curvature *and* obstructions into account. This is the number that matters.
   */
  lowestVisible: number;
  /** Whether anything other than curvature is responsible for the occlusion. */
  blockedByObstruction: boolean;
  /** The obstruction responsible, if any. */
  blocker?: { distance: number; height: number; kind: 'terrain' | 'building' };
  /** True if the whole target is hidden. */
  fullyHidden: boolean;
}

export interface SightlineResult {
  observerId?: string;
  targetId?: string;
  distance: number;
  bearing: number;
  /** Local radius of curvature for this latitude and azimuth, metres. */
  radius: number;
  profile: ProfileSample[];
  round: ModelResult;
  flat: ModelResult;
  /** Difference in lowest visible height between the models, metres. */
  difference: number;
  /** That difference in arcminutes as seen from the observer. */
  differenceArcmin: number;
}

export interface AnalyseOptions {
  /** Refraction coefficient. */
  k?: number;
  /** Spacing of profile samples, metres. Defaults to the terrain cell size. */
  stepMetres?: number;
  /** Include buildings as occluders. */
  includeBuildings?: boolean;
}

/**
 * Bucketed index over building footprints, so the profile walk does not test
 * every building at every step.
 */
class BuildingIndex {
  private readonly buckets = new Map<string, Building[]>();
  private readonly cell = 0.005; // degrees, ~500 m

  constructor(buildings: Building[]) {
    for (const b of buildings) {
      for (const key of this.keysFor(b)) {
        const list = this.buckets.get(key);
        if (list) list.push(b);
        else this.buckets.set(key, [b]);
      }
    }
  }

  private *keysFor(b: Building): Generator<string> {
    let latMin = Infinity;
    let latMax = -Infinity;
    let lonMin = Infinity;
    let lonMax = -Infinity;
    for (const [lon, lat] of b.footprint) {
      if (lat < latMin) latMin = lat;
      if (lat > latMax) latMax = lat;
      if (lon < lonMin) lonMin = lon;
      if (lon > lonMax) lonMax = lon;
    }
    const seen = new Set<string>();
    for (let lat = latMin; lat <= latMax + this.cell; lat += this.cell) {
      for (let lon = lonMin; lon <= lonMax + this.cell; lon += this.cell) {
        const key = `${Math.floor(lat / this.cell)}:${Math.floor(lon / this.cell)}`;
        if (!seen.has(key)) {
          seen.add(key);
          yield key;
        }
      }
    }
  }

  /** Tallest building containing this point, or null. */
  tallestAt(lat: number, lon: number): Building | null {
    const key = `${Math.floor(lat / this.cell)}:${Math.floor(lon / this.cell)}`;
    const candidates = this.buckets.get(key);
    if (!candidates) return null;
    let best: Building | null = null;
    for (const b of candidates) {
      if (!pointInRing(lon, lat, b.footprint)) continue;
      if (!best || b.height > best.height) best = b;
    }
    return best;
  }
}

/** Ray-casting point-in-polygon. */
export function pointInRing(x: number, y: number, ring: [number, number][]): boolean {
  let inside = false;
  for (let i = 0, j = ring.length - 1; i < ring.length; j = i++) {
    const [xi, yi] = ring[i]!;
    const [xj, yj] = ring[j]!;
    if (yi > y !== yj > y && x < ((xj - xi) * (y - yi)) / (yj - yi) + xi) {
      inside = !inside;
    }
  }
  return inside;
}

/**
 * Lowest height on the target visible over an obstruction skyline at
 * `maxElevation`. Bisected rather than solved in closed form: apparent
 * elevation is monotonic in height, so bisection is robust and the cost is
 * irrelevant next to the profile walk.
 */
function solveLowestVisible(
  eyeHeight: number,
  distance: number,
  invR: number,
  maxElevation: number,
  hMin: number,
  hMax: number,
): number {
  if (apparentElevation(eyeHeight, distance, hMin, invR) >= maxElevation) return hMin;
  if (apparentElevation(eyeHeight, distance, hMax, invR) < maxElevation) return Infinity;

  let lo = hMin;
  let hi = hMax;
  for (let i = 0; i < 80; i++) {
    const mid = (lo + hi) / 2;
    if (apparentElevation(eyeHeight, distance, mid, invR) < maxElevation) lo = mid;
    else hi = mid;
  }
  return (lo + hi) / 2;
}

function evaluateModel(
  observer: ObserverState,
  target: TargetState,
  distance: number,
  invR: number,
  k: number,
  profile: ProfileSample[],
): ModelResult {
  const eye = observer.groundElevation + observer.eyeHeight;

  // The skyline: highest apparent elevation of anything between here and there.
  let maxElevation = -Infinity;
  let blocker: ModelResult['blocker'] | undefined;
  for (const s of profile) {
    const el = apparentElevation(eye, s.distance, obstructionHeight(s), invR);
    if (el > maxElevation) {
      maxElevation = el;
      blocker = {
        distance: s.distance,
        height: obstructionHeight(s),
        kind: s.building !== null ? 'building' : 'terrain',
      };
    }
  }

  // The observer's own horizon is the floor: with nothing in the way, that is
  // still what cuts the target's base.
  //
  // These formulas take height above the *datum* — the water surface the
  // curvature is measured against — not height above local ground. Passing
  // eye-above-ground here would put an observer on a 10 m mound at a 5.4 km
  // horizon instead of 12.8 km, and that error falls exactly on the
  // walk-the-transition experiment this tool exists to plan.
  const curvatureHidden = hiddenHeight(eye, distance, invR);
  const horizonElevation = apparentElevation(eye, distance, curvatureHidden, invR);
  if (horizonElevation > maxElevation) {
    maxElevation = horizonElevation;
    blocker = undefined;
  }

  const topOfTarget = target.baseElevation + target.structureHeight;
  const lowestVisible = solveLowestVisible(
    eye,
    distance,
    invR,
    maxElevation,
    target.baseElevation,
    topOfTarget,
  );

  // "Blocked" has to mean an obstruction actually hides part of the target,
  // not merely that the tallest thing on the profile happened to be terrain.
  // The target's own shoreline sits one step short of the target and would
  // otherwise flag every over-water sightline as obstructed.
  const curvatureOnlyLowest = Math.max(
    target.baseElevation,
    solveLowestVisible(eye, distance, invR, horizonElevation, target.baseElevation, topOfTarget),
  );
  const obstructed =
    blocker !== undefined && lowestVisible > curvatureOnlyLowest + 0.01;

  return {
    invR,
    k,
    horizonDistance: horizonDistance(eye, invR),
    hiddenByCurvature: curvatureHidden,
    criticalObserverHeight: criticalObserverHeight(distance, invR),
    lowestVisible: Number.isFinite(lowestVisible) ? lowestVisible : topOfTarget,
    blockedByObstruction: obstructed,
    ...(obstructed && blocker ? { blocker } : {}),
    fullyHidden: !Number.isFinite(lowestVisible),
  };
}

function obstructionHeight(s: ProfileSample): number {
  const terrain = s.terrain ?? 0;
  return s.building !== null ? Math.max(terrain, s.building) : terrain;
}

/** Analyse one observer-target pair. */
export function analyseSightline(
  bundle: LoadedBundle,
  observer: ObserverState,
  target: TargetState,
  opts: AnalyseOptions = {},
): SightlineResult {
  const k = opts.k ?? 0.13;
  const { distance, initialBearing } = geodesicInverse(observer.position, target.position);
  const radius = eulerRadius(observer.position.lat, initialBearing);
  const invR = inverseEffectiveRadius(radius, k);

  const step = opts.stepMetres ?? bundle.manifest.scene.terrain.cellSizeMetres;
  const index =
    opts.includeBuildings !== false && bundle.buildings.length
      ? new BuildingIndex(bundle.buildings)
      : null;

  // Walk between the endpoints, excluding both: the observer's own cell and
  // the target itself are not obstructions.
  const profile: ProfileSample[] = [];
  for (let d = step; d < distance - step; d += step) {
    const p = geodesicDirect(observer.position, initialBearing, d);
    const terrain = sampleTerrain(bundle.terrain, p.lat, p.lon);
    const b = index?.tallestAt(p.lat, p.lon) ?? null;
    profile.push({
      distance: d,
      terrain,
      building: b ? (b.baseElevation ?? terrain ?? 0) + b.height : null,
      elevation: 0, // filled per model below; kept for the round case
    });
  }

  const round = evaluateModel(observer, target, distance, invR, k, profile);
  const flat = evaluateModel(observer, target, distance, 0, k, profile);

  // Record the round-model elevations on the profile for plotting.
  const eye = observer.groundElevation + observer.eyeHeight;
  for (const s of profile) {
    s.elevation = apparentElevation(eye, s.distance, obstructionHeight(s), invR);
  }

  const difference = round.lowestVisible - flat.lowestVisible;
  return {
    distance,
    bearing: initialBearing,
    radius,
    profile,
    round,
    flat,
    difference,
    differenceArcmin: angularSizeArcmin(difference, distance),
  };
}

/**
 * How many pixels the flat/round difference spans for a given lens. The number
 * that decides whether an observation is worth the trip.
 */
export function differenceInPixels(
  result: SightlineResult,
  focalLength35mm: number,
  aspect: number,
  pixelsWide: number,
): number {
  const fov = horizontalFovDeg(focalLength35mm, aspect);
  return result.differenceArcmin / arcminPerPixel(fov, pixelsWide);
}
