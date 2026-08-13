/**
 * WGS84 ellipsoid parameters and local radii of curvature.
 *
 * The Earth is not a sphere, and for a tool whose whole purpose is measuring
 * how curved it is, that matters. The local radius of curvature depends on
 * both latitude and the azimuth of the sightline: north-south sightlines see
 * the meridional radius M, east-west sightlines see the prime-vertical radius
 * N, and anything else sees a blend (the Euler radius).
 *
 * The spread is about 1% pole to equator, and ~0.2% between azimuths at Bay
 * Area latitudes. That is well below the uncertainty in atmospheric
 * refraction, so it will not change any single observation. But it is
 * systematic and varies with where you stand, so leaving it out would bake a
 * location-dependent bias into any attempt to *measure* the radius.
 */

export const WGS84 = {
  /** Semi-major axis (equatorial radius), metres. */
  a: 6378137.0,
  /** Flattening. */
  f: 1 / 298.257223563,
} as const;

/** Semi-minor axis (polar radius), metres. */
export const WGS84_B = WGS84.a * (1 - WGS84.f);

/** First eccentricity squared. */
export const WGS84_E2 = WGS84.f * (2 - WGS84.f);

/**
 * Mean Earth radius (IUGG), metres. Use only where a single scalar radius is
 * genuinely wanted — prefer {@link eulerRadius} for anything measured.
 */
export const R_MEAN = 6371008.8;

/**
 * Meridional radius of curvature at latitude `latDeg` (metres).
 * This is the radius seen by a north-south sightline.
 */
export function meridionalRadius(latDeg: number): number {
  const sinLat = Math.sin((latDeg * Math.PI) / 180);
  const w = 1 - WGS84_E2 * sinLat * sinLat;
  return (WGS84.a * (1 - WGS84_E2)) / Math.pow(w, 1.5);
}

/**
 * Prime-vertical (normal) radius of curvature at latitude `latDeg` (metres).
 * This is the radius seen by an east-west sightline.
 */
export function primeVerticalRadius(latDeg: number): number {
  const sinLat = Math.sin((latDeg * Math.PI) / 180);
  const w = 1 - WGS84_E2 * sinLat * sinLat;
  return WGS84.a / Math.sqrt(w);
}

/**
 * Euler radius of curvature: the radius of the normal section at latitude
 * `latDeg` in the direction `azimuthDeg` (degrees clockwise from true north).
 *
 *     1/R_a = cos^2(a)/M + sin^2(a)/N
 *
 * This is the radius a sightline along that azimuth actually curves over, and
 * is the correct value to feed into the refraction and hidden-height maths.
 */
export function eulerRadius(latDeg: number, azimuthDeg: number): number {
  const m = meridionalRadius(latDeg);
  const n = primeVerticalRadius(latDeg);
  const az = (azimuthDeg * Math.PI) / 180;
  const cosAz = Math.cos(az);
  const sinAz = Math.sin(az);
  return 1 / ((cosAz * cosAz) / m + (sinAz * sinAz) / n);
}
