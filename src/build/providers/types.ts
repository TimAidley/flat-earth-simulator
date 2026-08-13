/**
 * Data provider interfaces.
 *
 * v1 targets the Bay Area, but the shape here is deliberately not Bay Area
 * specific. Everything location-dependent — resolution, vertical datum,
 * licence, whether a source covers the box at all — is something a provider
 * declares rather than something the pipeline assumes. Adding a region later
 * should mean adding providers, not unpicking assumptions.
 *
 * Every provider must report provenance. A render whose data cannot be traced
 * is not evidence of anything, and "the render doesn't match my photo" means
 * something very different for surveyed LoD2 geometry than for an ML height
 * estimate.
 */

import type { VerticalDatum } from '../../core/datum.ts';

export interface BBox {
  latMin: number;
  latMax: number;
  lonMin: number;
  lonMax: number;
}

/** Where a layer's data came from, and how far it can be trusted. */
export interface Provenance {
  /** Human-readable source name. */
  source: string;
  /** Canonical URL for the dataset. */
  url?: string;
  /** Licence identifier or short description. */
  licence: string;
  /** ISO 8601 timestamp of retrieval. */
  retrievedAt: string;
  /** Native resolution, metres, where meaningful. */
  resolutionMetres?: number;
  /** Vertical datum of any heights in this layer. */
  datum?: VerticalDatum;
  /**
   * False when any part of this layer rests on an unverified assumption —
   * a guessed coordinate, an assumed datum, an approximated separation.
   * A scene with unverified layers may be rendered but must not be treated
   * as a measurement.
   */
  verified: boolean;
  /** Anything a reader needs in order to interpret the above honestly. */
  notes?: string[];
}

export interface Coverage {
  available: boolean;
  resolutionMetres?: number;
  datum?: VerticalDatum;
  notes?: string[];
}

/**
 * A regular latitude/longitude grid of heights.
 *
 * Row-major, with row 0 at `latMax` (north) and column 0 at `lonMin` (west) —
 * image convention, so it can be written straight out and sampled without a
 * flip. Cell centres are offset half a step from the edges.
 */
export interface TerrainGrid {
  bbox: BBox;
  width: number;
  height: number;
  datum: VerticalDatum;
  /** Height in metres above `datum`; `noDataValue` where unknown. */
  data: Float32Array;
  noDataValue: number;
}

export interface TerrainProvider {
  readonly id: string;
  coverage(bbox: BBox): Promise<Coverage>;
  fetch(
    bbox: BBox,
    cellSizeMetres: number,
  ): Promise<{ grid: TerrainGrid; provenance: Provenance }>;
}

/** How a building's height was arrived at. Drives both rendering and trust. */
export type HeightSource =
  /** Tagged height, in metres, from the source data. */
  | 'measured'
  /** Derived from a floor count. */
  | 'floors'
  /** Fallback constant — effectively unknown. */
  | 'default';

export interface Building {
  id: string;
  name?: string;
  /** Metres above local ground. */
  height: number;
  heightSource: HeightSource;
  numFloors?: number;
  /** Exterior ring as [lon, lat] pairs. Holes are dropped; they cannot occlude. */
  footprint: [number, number][];
}

export interface BuildingProvider {
  readonly id: string;
  coverage(bbox: BBox): Promise<Coverage>;
  fetch(
    bbox: BBox,
    minHeightMetres: number,
  ): Promise<{ buildings: Building[]; provenance: Provenance }>;
}

/**
 * Tidal harmonic constituents, so that water level can be predicted offline.
 *
 * Baking constituents rather than a fetched prediction series matters here:
 * the shoreline has patchy signal, and predictions expire while constituents
 * do not. Tide is a first-order term, not a detail — the Bay's diurnal range
 * is comparable to the entire curvature effect being measured.
 */
export interface TidalConstituent {
  name: string;
  /** Metres. */
  amplitude: number;
  /** Degrees. */
  phaseDeg: number;
  /** Degrees per hour. */
  speedDegPerHour: number;
}

export interface TideStation {
  id: string;
  name: string;
  lat: number;
  lon: number;
  datum: VerticalDatum;
  constituents: TidalConstituent[];
}

export interface TideProvider {
  readonly id: string;
  fetch(stationIds: string[]): Promise<{ stations: TideStation[]; provenance: Provenance }>;
}

/** Thrown when a provider cannot reach its upstream source. */
export class ProviderUnavailableError extends Error {
  constructor(
    readonly providerId: string,
    message: string,
    override readonly cause?: unknown,
  ) {
    super(`[${providerId}] ${message}`);
    this.name = 'ProviderUnavailableError';
  }
}
