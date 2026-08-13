/**
 * Scene configuration: what to build, from where, for which observers and
 * targets.
 *
 * A scene is the unit of portability. Nothing in the codebase is Bay Area
 * specific — the region lives entirely in a config file plus whatever
 * providers it names, so using this somewhere else means writing a new scene
 * (and possibly new providers), not editing the pipeline.
 */

import type { VerticalDatum } from '../core/datum.ts';
import type { DatumSeparations } from '../core/datum.ts';
import type { BBox } from './providers/types.ts';

export interface NamedPoint {
  id: string;
  name: string;
  lat: number;
  lon: number;
  /**
   * Whether these coordinates have been checked against an authoritative
   * source. Unverified points are usable for planning but must not be treated
   * as measurement references.
   */
  verified: boolean;
  notes?: string;
}

/** A place the observer can stand. */
export interface Observer extends NamedPoint {
  /**
   * Ground elevation above the scene datum, metres. Omit to sample it from the
   * terrain grid at build time — which is the better route, since horizontal
   * GPS error translates into almost no vertical error on flat ground.
   */
  groundElevation?: number;
  /** Default eye height above ground, metres. */
  eyeHeight: number;
}

/**
 * What kind of thing a target is, which decides how (and whether) its
 * coordinate can be resolved automatically.
 *
 * This is not decoration. Without it the resolver has to guess, and guessing
 * wrong is expensive: falling back to "snap to the highest cell nearby" moved
 * Salesforce Tower 1.5 km onto a hill and Treasure Island 1.5 km onto Yerba
 * Buena Island. A target whose kind is unknown is left alone.
 */
export type TargetKind =
  /** Resolvable by name against the Overture buildings layer. */
  | 'building'
  /** A natural high point; snap to the highest DEM cell nearby. */
  | 'summit'
  /** Neither — bridge towers, stretches of waterfront, low made ground. */
  | 'fixed';

/** Something to look at. */
export interface Target extends NamedPoint {
  /** How this target may be resolved. Omitted means "leave alone". */
  kind?: TargetKind;
  /** Height of the structure above its own base, metres. */
  structureHeight?: number;
  /** Base elevation above the scene datum, metres. */
  baseElevation?: number;
}

export interface SceneConfig {
  id: string;
  name: string;
  bbox: BBox;
  /** Datum every height in the bundle is expressed in. */
  verticalDatum: VerticalDatum;
  datumSeparations: DatumSeparations;
  terrain: {
    provider: 'terrarium';
    zoom?: number;
    /** Output grid cell size, metres. */
    cellSizeMetres: number;
    /**
     * Raise every cell below this height to it, in scene datum metres.
     *
     * Terrarium — and most global DEMs — carry bathymetry, so open water comes
     * back as seafloor depth rather than water surface: mid-bay reads about
     * -20 m. Left alone, every over-water sightline would be computed against
     * a surface 20 m below the one that actually blocks it, and every
     * occlusion result would be wrong.
     *
     * Clamping is an approximation, not a fix. It assumes nothing in the scene
     * is genuinely below the water surface, which holds for this shoreline but
     * not for diked baylands or polders. The real answer is a water mask from
     * a coastline dataset; until then this is recorded as an unverified
     * assumption in the bundle manifest.
     *
     * Omit to leave the DEM untouched.
     */
    clampBelowToLevel?: number;
  };
  buildings: {
    provider: 'overture';
    release: string;
    /** Only keep buildings at least this tall; they are the only ones that form a horizon. */
    minHeightMetres: number;
  };
  tide?: {
    provider: 'noaa-harcon';
    stationIds: string[];
  };
  observers: Observer[];
  targets: Target[];
}

export class SceneValidationError extends Error {
  constructor(readonly problems: string[]) {
    super(`Invalid scene config:\n  - ${problems.join('\n  - ')}`);
    this.name = 'SceneValidationError';
  }
}

/** Validate a parsed scene config, throwing with every problem at once. */
export function validateScene(scene: SceneConfig): void {
  const problems: string[] = [];
  const { bbox } = scene;

  if (!(bbox.latMin < bbox.latMax)) problems.push('bbox.latMin must be less than bbox.latMax');
  if (!(bbox.lonMin < bbox.lonMax)) {
    problems.push(
      'bbox.lonMin must be less than bbox.lonMax (antimeridian-crossing boxes must be split)',
    );
  }
  if (bbox.latMin < -90 || bbox.latMax > 90) problems.push('bbox latitudes out of range');
  if (bbox.lonMin < -180 || bbox.lonMax > 180) problems.push('bbox longitudes out of range');

  const inBox = (p: NamedPoint): boolean =>
    p.lat >= bbox.latMin && p.lat <= bbox.latMax && p.lon >= bbox.lonMin && p.lon <= bbox.lonMax;

  for (const o of scene.observers) {
    if (!inBox(o)) problems.push(`observer '${o.id}' lies outside the scene bbox`);
    if (o.eyeHeight <= 0) problems.push(`observer '${o.id}' has a non-positive eye height`);
  }
  for (const t of scene.targets) {
    if (!inBox(t)) problems.push(`target '${t.id}' lies outside the scene bbox`);
  }

  const ids = [...scene.observers, ...scene.targets].map((p) => p.id);
  const dupes = ids.filter((id, i) => ids.indexOf(id) !== i);
  if (dupes.length) problems.push(`duplicate point ids: ${[...new Set(dupes)].join(', ')}`);

  if (scene.terrain.cellSizeMetres <= 0) problems.push('terrain.cellSizeMetres must be positive');

  const sep = scene.datumSeparations.separations[scene.verticalDatum];
  if (scene.verticalDatum !== 'wgs84-ellipsoid' && sep === undefined) {
    problems.push(
      `no datum separation given for the scene's own vertical datum '${scene.verticalDatum}'`,
    );
  }

  if (problems.length) throw new SceneValidationError(problems);
}

/** Collect everything in a scene that has not been checked against a source. */
export function unverifiedItems(scene: SceneConfig): string[] {
  const out: string[] = [];
  for (const p of [...scene.observers, ...scene.targets]) {
    if (!p.verified) out.push(`${p.id} (${p.name}): coordinates unverified`);
  }
  for (const [datum, source] of Object.entries(scene.datumSeparations.sources)) {
    if (typeof source === 'string' && source.startsWith('PLACEHOLDER')) {
      out.push(`datum separation for '${datum}': ${source}`);
    }
  }
  return out;
}

export async function loadScene(path: string): Promise<SceneConfig> {
  const { readFile } = await import('node:fs/promises');
  const scene = JSON.parse(await readFile(path, 'utf8')) as SceneConfig;
  validateScene(scene);
  return scene;
}
