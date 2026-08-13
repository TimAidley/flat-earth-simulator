/**
 * Tidal prediction from harmonic constituents.
 *
 * Tide is not a detail here. The Bay's diurnal range is around 1.8 m, against
 * a curvature effect of 4-8 m at the ranges this tool works at, so water level
 * is a first-order term in every over-water sightline. Rendering the sea at a
 * fixed zero throws that away.
 *
 * Constituents rather than a fetched prediction series, because constituents
 * do not expire and work with no network — which is what the shoreline needs.
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

/**
 * Vertical offsets between a station's tidal datums, metres.
 *
 * NOAA publishes harmonic constants referenced to MLLW, while the scene works
 * in a geoid-based datum. Without this the predicted level would be about a
 * metre out — the same order as the effect being measured.
 */
export interface StationDatums {
  /** Height of mean sea level above MLLW, metres. */
  mslAboveMllw: number;
  /** Where these came from. */
  source: string;
}

/** Epoch NOAA harmonic phases are referenced to: 1 January 1983, 00:00 GMT. */
export const TIDE_EPOCH_MS = Date.UTC(1983, 0, 1, 0, 0, 0);

/**
 * Water level above the station's MLLW datum at a given time, metres.
 *
 * A plain harmonic sum without nodal corrections, which are a sub-decimetre
 * effect on an 18.6-year cycle — below the noise floor of everything else
 * here, but an approximation, and recorded as one.
 */
export function predictTideAboveMllw(
  constituents: readonly TidalConstituent[],
  at: Date,
): number {
  const hours = (at.getTime() - TIDE_EPOCH_MS) / 3_600_000;
  let level = 0;
  for (const c of constituents) {
    const angle = ((c.speedDegPerHour * hours - c.phaseDeg) * Math.PI) / 180;
    level += c.amplitude * Math.cos(angle);
  }
  return level;
}

/**
 * Water level in the scene's vertical datum, metres.
 *
 * Mean sea level is taken as the scene datum. That is an approximation —
 * MSL departs from the geoid by ocean dynamic topography, of order a
 * decimetre or two locally — and is small next to the tide range it corrects
 * for, but it is an assumption and the bundle records it.
 */
export function predictWaterLevel(
  constituents: readonly TidalConstituent[],
  datums: StationDatums,
  at: Date,
): number {
  return predictTideAboveMllw(constituents, at) - datums.mslAboveMllw;
}

/** Peak-to-peak range over a window, by sampling. Used for reporting. */
export function tideRange(
  constituents: readonly TidalConstituent[],
  from: Date,
  hours = 24,
  stepMinutes = 10,
): { min: number; max: number } {
  let min = Infinity;
  let max = -Infinity;
  for (let m = 0; m <= hours * 60; m += stepMinutes) {
    const v = predictTideAboveMllw(constituents, new Date(from.getTime() + m * 60_000));
    if (v < min) min = v;
    if (v > max) max = v;
  }
  return { min, max };
}
