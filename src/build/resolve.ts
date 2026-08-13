/**
 * Resolve a scene's guessed coordinates against the data it will be rendered
 * from.
 *
 * The scene shipped with coordinates typed from memory, and running the
 * sightline calculator showed what that costs: one shoreline observer landed
 * on a water cell and was handed a ground elevation of exactly the water-clamp
 * value, which maximises hidden height and pushed it to the top of the
 * ranking. The recommendation was an artefact of a bad coordinate.
 *
 * Three kinds of fix, in decreasing order of authority:
 *
 *   buildings  matched by name against the Overture layer, taking its centroid
 *              and its tagged height. Overture is an independent source and is
 *              the same data the renderer will draw, so a match is a genuine
 *              verification.
 *   summits    natural features snapped to the highest DEM cell within a
 *              search radius. Self-consistent rather than independent — it
 *              cannot be wrong relative to what gets rendered, but it inherits
 *              whatever the DEM got wrong.
 *   observers  snapped to the nearest cell that is actually land, curing the
 *              on-the-water case.
 *
 * Only the first counts as verification, and the distinction is recorded
 * rather than flattened.
 */

import { geodesicInverse } from '../core/index.ts';
import { sampleTerrain, type LoadedBundle } from './bundle.ts';
import type { SceneConfig, Observer, Target } from './scene.ts';
import type { Building, TerrainGrid } from './providers/types.ts';

export interface ResolutionChange {
  id: string;
  kind: 'building' | 'summit' | 'observer';
  /** Metres the point moved. */
  movedBy: number;
  detail: string;
  /** True only when an independent source confirmed the point. */
  verified: boolean;
}

export interface ResolveResult {
  scene: SceneConfig;
  changes: ResolutionChange[];
  unchanged: string[];
}

/** Centroid of a footprint ring, as [lon, lat]. */
export function ringCentroid(ring: [number, number][]): [number, number] {
  // Area-weighted centroid; falls back to the vertex mean for degenerate rings.
  let area = 0;
  let cx = 0;
  let cy = 0;
  for (let i = 0, j = ring.length - 1; i < ring.length; j = i++) {
    const [xi, yi] = ring[i]!;
    const [xj, yj] = ring[j]!;
    const cross = xj * yi - xi * yj;
    area += cross;
    cx += (xj + xi) * cross;
    cy += (yj + yi) * cross;
  }
  if (area === 0) {
    const n = ring.length;
    return [
      ring.reduce((s, p) => s + p[0], 0) / n,
      ring.reduce((s, p) => s + p[1], 0) / n,
    ];
  }
  return [cx / (3 * area), cy / (3 * area)];
}

function normalise(s: string): string {
  return s.toLowerCase().replace(/[^a-z0-9]+/g, ' ').trim();
}

/**
 * Find the building whose name best matches `query`, within `radiusMetres` of
 * the guessed position. The radius matters: Overture contains many buildings
 * with similar names, and an unbounded name match can land in another city.
 */
export function matchBuilding(
  buildings: Building[],
  query: string,
  near: { lat: number; lon: number },
  radiusMetres: number,
): Building | null {
  const q = normalise(query);
  let best: { building: Building; distance: number } | null = null;

  for (const b of buildings) {
    if (!b.name) continue;
    const n = normalise(b.name);
    if (n !== q && !n.includes(q) && !q.includes(n)) continue;

    const [lon, lat] = ringCentroid(b.footprint);
    const { distance } = geodesicInverse(near, { lat, lon });
    if (distance > radiusMetres) continue;
    if (!best || distance < best.distance) best = { building: b, distance };
  }
  return best?.building ?? null;
}

/** Highest DEM cell within `radiusMetres`, with its elevation. */
export function findSummit(
  grid: TerrainGrid,
  near: { lat: number; lon: number },
  radiusMetres: number,
): { lat: number; lon: number; elevation: number } | null {
  const latSpan = grid.bbox.latMax - grid.bbox.latMin;
  const lonSpan = grid.bbox.lonMax - grid.bbox.lonMin;
  const degLat = radiusMetres / 111_320;
  const degLon = radiusMetres / (111_320 * Math.cos((near.lat * Math.PI) / 180));

  const j0 = Math.max(0, Math.floor(((grid.bbox.latMax - (near.lat + degLat)) / latSpan) * grid.height));
  const j1 = Math.min(grid.height - 1, Math.ceil(((grid.bbox.latMax - (near.lat - degLat)) / latSpan) * grid.height));
  const i0 = Math.max(0, Math.floor((((near.lon - degLon) - grid.bbox.lonMin) / lonSpan) * grid.width));
  const i1 = Math.min(grid.width - 1, Math.ceil((((near.lon + degLon) - grid.bbox.lonMin) / lonSpan) * grid.width));

  let best: { lat: number; lon: number; elevation: number } | null = null;
  for (let j = j0; j <= j1; j++) {
    const lat = grid.bbox.latMax - ((j + 0.5) / grid.height) * latSpan;
    for (let i = i0; i <= i1; i++) {
      const lon = grid.bbox.lonMin + ((i + 0.5) / grid.width) * lonSpan;
      const v = grid.data[j * grid.width + i]!;
      if (v === grid.noDataValue) continue;
      if (geodesicInverse(near, { lat, lon }).distance > radiusMetres) continue;
      if (!best || v > best.elevation) best = { lat, lon, elevation: v };
    }
  }
  return best;
}

/** Nearest cell that is genuinely land, i.e. above the water-clamp level. */
export function findNearestLand(
  grid: TerrainGrid,
  near: { lat: number; lon: number },
  waterLevel: number,
  maxRadiusMetres: number,
): { lat: number; lon: number; elevation: number } | null {
  const latSpan = grid.bbox.latMax - grid.bbox.latMin;
  const lonSpan = grid.bbox.lonMax - grid.bbox.lonMin;
  const cellLat = latSpan / grid.height;
  const steps = Math.ceil(maxRadiusMetres / (cellLat * 111_320));

  let best: { lat: number; lon: number; elevation: number; distance: number } | null = null;
  const j0 = Math.round(((grid.bbox.latMax - near.lat) / latSpan) * grid.height);
  const i0 = Math.round(((near.lon - grid.bbox.lonMin) / lonSpan) * grid.width);

  for (let dj = -steps; dj <= steps; dj++) {
    for (let di = -steps; di <= steps; di++) {
      const j = j0 + dj;
      const i = i0 + di;
      if (j < 0 || j >= grid.height || i < 0 || i >= grid.width) continue;
      const v = grid.data[j * grid.width + i]!;
      if (v === grid.noDataValue || v <= waterLevel + 0.5) continue;
      const lat = grid.bbox.latMax - ((j + 0.5) / grid.height) * latSpan;
      const lon = grid.bbox.lonMin + ((i + 0.5) / grid.width) * lonSpan;
      const distance = geodesicInverse(near, { lat, lon }).distance;
      if (distance > maxRadiusMetres) continue;
      if (!best || distance < best.distance) best = { lat, lon, elevation: v, distance };
    }
  }
  return best;
}

export interface ResolveOptions {
  /** Search radius for building name matches, metres. */
  buildingRadius?: number;
  /** Search radius for summit snapping, metres. */
  summitRadius?: number;
  /** Search radius for shoreline snapping, metres. */
  observerRadius?: number;
}

/**
 * @param sceneOverride Resolve this scene rather than the manifest's snapshot.
 *   The manifest records what was *built*; config keeps evolving after that,
 *   so resolving the baked copy silently ignores edits made since.
 */
export function resolveScene(
  bundle: LoadedBundle,
  opts: ResolveOptions = {},
  sceneOverride?: SceneConfig,
): ResolveResult {
  const scene: SceneConfig = structuredClone(sceneOverride ?? bundle.manifest.scene);
  const changes: ResolutionChange[] = [];
  const unchanged: string[] = [];
  const waterLevel = scene.terrain.clampBelowToLevel ?? 0;

  const buildingRadius = opts.buildingRadius ?? 2000;
  const summitRadius = opts.summitRadius ?? 1500;
  const observerRadius = opts.observerRadius ?? 400;

  for (const target of scene.targets as Target[]) {
    const guess = { lat: target.lat, lon: target.lon };

    // A target that has not declared its kind is left alone. Guessing is worse
    // than doing nothing here: summit-snapping a skyscraper walks it onto the
    // nearest hill and reports the move as a successful resolution.
    if (target.kind === undefined || target.kind === 'fixed') {
      unchanged.push(target.id);
      continue;
    }

    if (target.kind === 'building') {
      const match = matchBuilding(bundle.buildings, target.name, guess, buildingRadius);
      if (!match) {
        unchanged.push(target.id);
        continue;
      }
      const [lon, lat] = ringCentroid(match.footprint);
      const movedBy = geodesicInverse(guess, { lat, lon }).distance;
      const oldHeight = target.structureHeight;
      target.lat = lat;
      target.lon = lon;
      target.structureHeight = match.height;
      target.verified = match.heightSource === 'measured';
      target.notes =
        `Resolved against Overture building '${match.name}' (${match.id}); ` +
        `height ${match.height.toFixed(0)} m from ${match.heightSource}.`;
      changes.push({
        id: target.id,
        kind: 'building',
        movedBy,
        detail:
          `matched '${match.name}', height ${oldHeight?.toFixed(0) ?? '?'} -> ` +
          `${match.height.toFixed(0)} m (${match.heightSource})`,
        verified: target.verified,
      });
      continue;
    }

    // Natural features: snap to the highest cell nearby. The guessed point
    // frequently sat on an island's flank rather than its summit, which
    // understated its height as an occluder by a hundred metres or more.
    const summit = findSummit(bundle.terrain, guess, summitRadius);
    if (summit && summit.elevation > waterLevel + 1) {
      const movedBy = geodesicInverse(guess, summit).distance;
      const oldHeight = target.structureHeight;
      target.lat = summit.lat;
      target.lon = summit.lon;
      target.baseElevation = 0;
      target.structureHeight = summit.elevation;
      target.notes =
        `Snapped to the highest DEM cell within ${summitRadius} m. Derived from ` +
        'the scene\'s own terrain, so self-consistent but not independently verified.';
      changes.push({
        id: target.id,
        kind: 'summit',
        movedBy,
        detail: `height ${oldHeight?.toFixed(0) ?? '?'} -> ${summit.elevation.toFixed(0)} m`,
        verified: false,
      });
      continue;
    }

    unchanged.push(target.id);
  }

  for (const observer of scene.observers as Observer[]) {
    const guess = { lat: observer.lat, lon: observer.lon };
    const here = sampleTerrain(bundle.terrain, guess.lat, guess.lon);

    // A sample sitting exactly at the clamp level means the point is on water,
    // not on the shoreline path. Left alone it reports a ground elevation of
    // zero, which maximises hidden height and skews the whole ranking.
    const onWater = here === null || here <= waterLevel + 0.5;
    if (!onWater) {
      observer.groundElevation = here;
      unchanged.push(observer.id);
      continue;
    }

    const land = findNearestLand(bundle.terrain, guess, waterLevel, observerRadius);
    if (!land) {
      unchanged.push(observer.id);
      continue;
    }
    const movedBy = geodesicInverse(guess, land).distance;
    observer.lat = land.lat;
    observer.lon = land.lon;
    observer.groundElevation = land.elevation;
    observer.notes =
      `Original coordinate fell on water; snapped ${movedBy.toFixed(0)} m to the ` +
      'nearest land cell. The coordinate itself is still unverified.';
    changes.push({
      id: observer.id,
      kind: 'observer',
      movedBy,
      detail: `was on water; ground now ${land.elevation.toFixed(2)} m`,
      verified: false,
    });
  }

  return { scene, changes, unchanged };
}
