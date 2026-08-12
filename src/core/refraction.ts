/**
 * Atmospheric refraction.
 *
 * Every claim this tool makes about what should or should not be visible
 * depends on this, and it is not a constant. The refraction coefficient k is
 * driven by the near-surface temperature gradient, which varies by climate,
 * season, time of day and — most sharply — by the difference between air and
 * water temperature over a sea surface.
 *
 * Ignoring that is how you build a strawman: real long-range photographs are
 * taken in conditions where k departs a long way from any textbook value, and
 * a simulator that hard-codes 0.13 will disagree with honest photographs and
 * prove nothing. k is a first-class input here, not a buried constant.
 */

/**
 * Refraction coefficient from the near-surface atmospheric state.
 *
 *   k = 503 * (P / T^2) * (0.0342 + dT/dh)
 *
 * @param pressureHPa    Station pressure, hPa (mbar).
 * @param temperatureK   Air temperature, kelvin.
 * @param lapseRateKPerM Temperature gradient dT/dh, K/m. Negative when
 *                       temperature falls with height (the usual case);
 *                       positive under an inversion.
 */
export function refractionCoefficient(
  pressureHPa: number,
  temperatureK: number,
  lapseRateKPerM: number,
): number {
  return 503 * (pressureHPa / (temperatureK * temperatureK)) * (0.0342 + lapseRateKPerM);
}

/**
 * Named reference conditions, with the k each implies.
 *
 * These are starting points for a slider, not authorities. `standard` is the
 * ICAO lapse rate; `surveying` is the daytime-over-warm-ground convention most
 * often quoted as "the" value; the marine cases matter here because cold
 * upwelled water under warm air — the normal summer state of San Francisco Bay
 * — produces surface inversions that lift distant objects well above where
 * geometry alone would put them.
 */
export const REFRACTION_PRESETS = {
  /** No atmosphere. Rays are straight; the geometric baseline. */
  vacuum: 0,
  /** ICAO standard atmosphere, dT/dh = -0.0065 K/m. */
  standard: 0.17,
  /** Daytime over sun-heated ground, dT/dh ~ -0.013 K/m. */
  surveying: 0.13,
  /** Strong daytime heating; inferior mirage territory. Objects sink faster than geometry predicts. */
  hotGround: -0.1,
  /** Mild marine inversion over cool water. */
  marineInversion: 0.3,
  /** Strong marine inversion; looming, stacked images. */
  strongInversion: 0.6,
  /** Ray curvature matches the surface. Sight range is unbounded and the round Earth renders flat. */
  ducting: 1.0,
} as const;

export type RefractionPreset = keyof typeof REFRACTION_PRESETS;

/**
 * Inverse effective radius, 1/metres — the quantity everything downstream
 * actually wants.
 *
 *   invR = (1 - k) / R
 *
 * Expressed this way the whole range is continuous and well behaved: k = 1
 * gives exactly zero (a round Earth that renders identically to a flat one,
 * which is a real and observable condition, not a degenerate case), and k > 1
 * gives a negative value that lifts distant objects into view.
 *
 * The alternative, R_eff = R/(1 - k), is singular at k = 1 and cannot express
 * any of that.
 *
 * @param radius Local radius of curvature, metres — normally the Euler radius
 *               for the sightline's latitude and azimuth.
 * @param k      Refraction coefficient.
 */
export function inverseEffectiveRadius(radius: number, k: number): number {
  return (1 - k) / radius;
}

/**
 * Effective radius R/(1 - k), metres. Provided for reporting and for comparison
 * with published figures; prefer {@link inverseEffectiveRadius} in computation.
 * Returns Infinity at k = 1 and a negative radius beyond it.
 */
export function effectiveRadius(radius: number, k: number): number {
  if (k === 1) return Infinity;
  return radius / (1 - k);
}

/** Inverse of {@link inverseEffectiveRadius}: recover k from an inverse radius. */
export function refractionCoefficientFromInvR(radius: number, invR: number): number {
  return 1 - invR * radius;
}
