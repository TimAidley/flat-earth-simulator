/**
 * Vertical datums.
 *
 * This is the quietest way to get a badly wrong answer. Four sources feed this
 * tool and each speaks a different vertical language:
 *
 *   GPS          -> ellipsoidal height (WGS84)
 *   3DEP         -> NAVD88, orthometric
 *   Copernicus   -> EGM2008 geoid
 *   tide gauges  -> MLLW / chart datum
 *
 * Geoid-ellipsoid separation runs from about -106 m to +85 m worldwide, and is
 * around -32 m in the Bay Area. Mix two datums and you are tens of metres out
 * on an effect of a few metres — and the render still looks entirely
 * plausible, just wrong. There is no symptom to notice.
 *
 * So heights carry their datum in the type, and arithmetic on mismatched
 * heights is a compile-time or runtime error rather than a silent one. The
 * separations themselves are supplied by the scene, not hard-coded here: they
 * are location-specific and must be sourced, not guessed.
 */

import type { LatLon } from './geodesy.ts';

export type VerticalDatum =
  /** Height above the WGS84 ellipsoid. What raw GNSS reports. */
  | 'wgs84-ellipsoid'
  /** Orthometric height above the EGM2008 geoid. Copernicus DEM native. */
  | 'egm2008'
  /** North American Vertical Datum of 1988. USGS 3DEP native. */
  | 'navd88'
  /** Mean Lower Low Water. NOAA tidal datum; station-specific. */
  | 'mllw';

/** A height that knows what it is measured from. */
export interface Height {
  readonly value: number;
  readonly datum: VerticalDatum;
}

export function height(value: number, datum: VerticalDatum): Height {
  return { value, datum };
}

/**
 * Offsets from the WGS84 ellipsoid to each datum, in metres, valid for one
 * scene's extent.
 *
 * The convention is `h_datum = h_ellipsoid + separation[datum]`, so for the
 * Bay Area, where the geoid sits about 32 m below the ellipsoid, the EGM2008
 * separation is approximately +32.
 *
 * Every entry carries its provenance because these are exactly the numbers
 * that must not be invented. A scene with an unsourced separation should be
 * treated as unusable for measurement.
 */
export interface DatumSeparations {
  readonly separations: Partial<Record<VerticalDatum, number>>;
  /** Where each separation came from, keyed the same way. */
  readonly sources: Partial<Record<VerticalDatum, string>>;
  /** Scene extent these are valid for; separations vary spatially. */
  readonly validFor?: { latMin: number; latMax: number; lonMin: number; lonMax: number };
}

export class DatumMismatchError extends Error {
  constructor(
    readonly a: VerticalDatum,
    readonly b: VerticalDatum,
  ) {
    super(
      `Cannot combine heights in different vertical datums (${a} vs ${b}). ` +
        'Convert explicitly via DatumRegistry.convert() — an implicit mix here would be ' +
        'a silent error of up to tens of metres.',
    );
    this.name = 'DatumMismatchError';
  }
}

/**
 * Converts heights between datums using a scene's separation table.
 *
 * Conversions route through the ellipsoid as a hub, so the table needs one
 * entry per datum rather than one per pair.
 */
export class DatumRegistry {
  constructor(private readonly table: DatumSeparations) {}

  private separation(datum: VerticalDatum): number {
    if (datum === 'wgs84-ellipsoid') return 0;
    const sep = this.table.separations[datum];
    if (sep === undefined) {
      throw new Error(
        `No separation defined for vertical datum '${datum}' in this scene. ` +
          'Add it to the scene config with a cited source rather than assuming a value.',
      );
    }
    return sep;
  }

  /**
   * Convert a height to another datum.
   *
   * `at` is accepted (and required for correctness in general) because geoid
   * separation varies spatially. For a v1 scene covering tens of kilometres a
   * single constant is adequate; the parameter keeps the call sites honest so
   * that swapping in a real geoid grid later is a change of implementation
   * rather than of every caller.
   */
  convert(h: Height, to: VerticalDatum, _at?: LatLon): Height {
    if (h.datum === to) return h;
    const value = h.value - this.separation(h.datum) + this.separation(to);
    return { value, datum: to };
  }

  /** Difference `a - b`, in metres, converting `b` into `a`'s datum first. */
  difference(a: Height, b: Height, at?: LatLon): number {
    return a.value - this.convert(b, a.datum, at).value;
  }
}

/**
 * Assert two heights share a datum, for arithmetic that has no registry to
 * hand. Throws {@link DatumMismatchError} on a mismatch.
 */
export function assertSameDatum(a: Height, b: Height): void {
  if (a.datum !== b.datum) throw new DatumMismatchError(a.datum, b.datum);
}
