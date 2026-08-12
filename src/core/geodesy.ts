/**
 * Geodesic distance/bearing on the WGS84 ellipsoid, and the local surface
 * frame the renderer and sightline calculator both work in.
 *
 * Uses Vincenty rather than Karney. Vincenty is accurate to well under a
 * millimetre and is a fraction of the code; its known weakness is failure to
 * converge for near-antipodal point pairs, which cannot arise for the
 * sightlines this tool deals with (tens of kilometres, occasionally a few
 * hundred). {@link geodesicInverse} throws rather than returning a wrong
 * answer if it ever does fail to converge.
 */

import { WGS84, WGS84_B } from './ellipsoid.ts';

const DEG = Math.PI / 180;
const RAD = 180 / Math.PI;

export interface LatLon {
  /** Degrees north, positive. */
  lat: number;
  /** Degrees east, positive. */
  lon: number;
}

export interface GeodesicResult {
  /** Geodesic (surface) distance, metres. */
  distance: number;
  /** Initial bearing at the origin, degrees clockwise from true north, [0,360). */
  initialBearing: number;
  /** Final bearing at the destination, degrees clockwise from true north, [0,360). */
  finalBearing: number;
}

function normaliseBearing(radians: number): number {
  return ((radians * RAD) % 360 + 360) % 360;
}

/**
 * Normalise a longitude difference into (-180, 180]. Without this, any
 * bounding box or sightline crossing the antimeridian silently produces a
 * distance the long way round the planet.
 */
export function wrapLonDelta(deltaDeg: number): number {
  let d = ((deltaDeg + 180) % 360 + 360) % 360 - 180;
  if (d === -180) d = 180;
  return d;
}

/**
 * Vincenty inverse: distance and bearings between two geodetic points.
 * @throws if the iteration fails to converge (near-antipodal points).
 */
export function geodesicInverse(from: LatLon, to: LatLon): GeodesicResult {
  const { a, f } = WGS84;
  const b = WGS84_B;

  const L = wrapLonDelta(to.lon - from.lon) * DEG;
  const U1 = Math.atan((1 - f) * Math.tan(from.lat * DEG));
  const U2 = Math.atan((1 - f) * Math.tan(to.lat * DEG));
  const sinU1 = Math.sin(U1);
  const cosU1 = Math.cos(U1);
  const sinU2 = Math.sin(U2);
  const cosU2 = Math.cos(U2);

  let lambda = L;
  let sinSigma = 0;
  let cosSigma = 0;
  let sigma = 0;
  let cos2Alpha = 0;
  let cos2SigmaM = 0;
  let converged = false;

  for (let i = 0; i < 200; i++) {
    const sinLambda = Math.sin(lambda);
    const cosLambda = Math.cos(lambda);

    const t1 = cosU2 * sinLambda;
    const t2 = cosU1 * sinU2 - sinU1 * cosU2 * cosLambda;
    sinSigma = Math.hypot(t1, t2);

    // Coincident points.
    if (sinSigma === 0) {
      return { distance: 0, initialBearing: 0, finalBearing: 0 };
    }

    cosSigma = sinU1 * sinU2 + cosU1 * cosU2 * cosLambda;
    sigma = Math.atan2(sinSigma, cosSigma);

    const sinAlpha = (cosU1 * cosU2 * sinLambda) / sinSigma;
    cos2Alpha = 1 - sinAlpha * sinAlpha;

    // On an exactly equatorial line cos2Alpha is 0 and cos2SigmaM is undefined;
    // the series below is well behaved with it set to zero.
    cos2SigmaM = cos2Alpha !== 0 ? cosSigma - (2 * sinU1 * sinU2) / cos2Alpha : 0;

    const C = (f / 16) * cos2Alpha * (4 + f * (4 - 3 * cos2Alpha));
    const lambdaPrev = lambda;
    lambda =
      L +
      (1 - C) *
        f *
        sinAlpha *
        (sigma +
          C * sinSigma * (cos2SigmaM + C * cosSigma * (-1 + 2 * cos2SigmaM * cos2SigmaM)));

    if (Math.abs(lambda - lambdaPrev) < 1e-12) {
      converged = true;
      break;
    }
  }

  if (!converged) {
    throw new Error(
      `geodesicInverse failed to converge for (${from.lat},${from.lon}) -> (${to.lat},${to.lon}); ` +
        'points may be near-antipodal, which is outside this tool\'s intended range.',
    );
  }

  const uSq = (cos2Alpha * (a * a - b * b)) / (b * b);
  const A = 1 + (uSq / 16384) * (4096 + uSq * (-768 + uSq * (320 - 175 * uSq)));
  const B = (uSq / 1024) * (256 + uSq * (-128 + uSq * (74 - 47 * uSq)));
  const deltaSigma =
    B *
    sinSigma *
    (cos2SigmaM +
      (B / 4) *
        (cosSigma * (-1 + 2 * cos2SigmaM * cos2SigmaM) -
          (B / 6) *
            cos2SigmaM *
            (-3 + 4 * sinSigma * sinSigma) *
            (-3 + 4 * cos2SigmaM * cos2SigmaM)));

  const distance = b * A * (sigma - deltaSigma);

  const sinLambda = Math.sin(lambda);
  const cosLambda = Math.cos(lambda);
  const initialBearing = Math.atan2(
    cosU2 * sinLambda,
    cosU1 * sinU2 - sinU1 * cosU2 * cosLambda,
  );
  const finalBearing = Math.atan2(
    cosU1 * sinLambda,
    -sinU1 * cosU2 + cosU1 * sinU2 * cosLambda,
  );

  return {
    distance,
    initialBearing: normaliseBearing(initialBearing),
    finalBearing: normaliseBearing(finalBearing),
  };
}

/**
 * Vincenty direct: the point reached by travelling `distance` metres from
 * `from` along initial bearing `bearingDeg`.
 */
export function geodesicDirect(
  from: LatLon,
  bearingDeg: number,
  distance: number,
): LatLon & { finalBearing: number } {
  const { a, f } = WGS84;
  const b = WGS84_B;

  const alpha1 = bearingDeg * DEG;
  const sinAlpha1 = Math.sin(alpha1);
  const cosAlpha1 = Math.cos(alpha1);

  const tanU1 = (1 - f) * Math.tan(from.lat * DEG);
  const cosU1 = 1 / Math.sqrt(1 + tanU1 * tanU1);
  const sinU1 = tanU1 * cosU1;

  const sigma1 = Math.atan2(tanU1, cosAlpha1);
  const sinAlpha = cosU1 * sinAlpha1;
  const cos2Alpha = 1 - sinAlpha * sinAlpha;
  const uSq = (cos2Alpha * (a * a - b * b)) / (b * b);
  const A = 1 + (uSq / 16384) * (4096 + uSq * (-768 + uSq * (320 - 175 * uSq)));
  const B = (uSq / 1024) * (256 + uSq * (-128 + uSq * (74 - 47 * uSq)));

  let sigma = distance / (b * A);
  let sinSigma = 0;
  let cosSigma = 0;
  let cos2SigmaM = 0;

  for (let i = 0; i < 200; i++) {
    cos2SigmaM = Math.cos(2 * sigma1 + sigma);
    sinSigma = Math.sin(sigma);
    cosSigma = Math.cos(sigma);
    const deltaSigma =
      B *
      sinSigma *
      (cos2SigmaM +
        (B / 4) *
          (cosSigma * (-1 + 2 * cos2SigmaM * cos2SigmaM) -
            (B / 6) *
              cos2SigmaM *
              (-3 + 4 * sinSigma * sinSigma) *
              (-3 + 4 * cos2SigmaM * cos2SigmaM)));
    const sigmaPrev = sigma;
    sigma = distance / (b * A) + deltaSigma;
    if (Math.abs(sigma - sigmaPrev) < 1e-12) break;
  }

  const tmp = sinU1 * sinSigma - cosU1 * cosSigma * cosAlpha1;
  const lat2 = Math.atan2(
    sinU1 * cosSigma + cosU1 * sinSigma * cosAlpha1,
    (1 - f) * Math.hypot(sinAlpha, tmp),
  );
  const lambda = Math.atan2(
    sinSigma * sinAlpha1,
    cosU1 * cosSigma - sinU1 * sinSigma * cosAlpha1,
  );
  const C = (f / 16) * cos2Alpha * (4 + f * (4 - 3 * cos2Alpha));
  const L =
    lambda -
    (1 - C) *
      f *
      sinAlpha *
      (sigma +
        C * sinSigma * (cos2SigmaM + C * cosSigma * (-1 + 2 * cos2SigmaM * cos2SigmaM)));

  const lon2 = from.lon + L * RAD;
  const finalBearing = Math.atan2(sinAlpha, -tmp);

  return {
    lat: lat2 * RAD,
    lon: wrapLonDelta(lon2),
    finalBearing: normaliseBearing(finalBearing),
  };
}

/**
 * A point expressed in the local surface frame of an observer.
 *
 * This is *not* an ECEF-derived ENU frame. `east` and `north` are the
 * components of the geodesic surface distance decomposed by initial bearing —
 * an azimuthal-equidistant projection centred on the observer — and `up` is
 * height above the scene's vertical datum, with no curvature applied.
 *
 * That is deliberate. Storing geometry with curvature already baked in would
 * make the flat/round toggle a geometry rebuild. Instead the renderer stores
 * these coordinates verbatim and applies curvature per-vertex in the shader
 * (see curve.ts), so switching models — or sweeping the radius continuously —
 * costs nothing.
 *
 * It also means the flat model rendered here is the "preserve locally measured
 * distances" variant: a plane tangent at the observer, extended. The other
 * option, an azimuthal-equidistant disc centred on the north pole, disagrees
 * with measured east-west distances by about 15% at Bay Area latitudes, and is
 * a separate mode rather than a different value of one parameter.
 */
export interface LocalPoint {
  /** Metres east of the observer, along the surface. */
  east: number;
  /** Metres north of the observer, along the surface. */
  north: number;
  /** Height above the scene vertical datum, metres. */
  up: number;
  /** Geodesic surface distance from the observer, metres. */
  distance: number;
  /** Initial bearing from the observer, degrees clockwise from true north. */
  bearing: number;
}

/** Project a geodetic point into the observer's local surface frame. */
export function toLocal(
  origin: LatLon,
  point: LatLon,
  heightAboveDatum: number,
): LocalPoint {
  const { distance, initialBearing } = geodesicInverse(origin, point);
  const az = initialBearing * DEG;
  return {
    east: distance * Math.sin(az),
    north: distance * Math.cos(az),
    up: heightAboveDatum,
    distance,
    bearing: initialBearing,
  };
}

/** Inverse of {@link toLocal}: recover geodetic coordinates from the local frame. */
export function fromLocal(origin: LatLon, local: Pick<LocalPoint, 'east' | 'north'>): LatLon {
  const distance = Math.hypot(local.east, local.north);
  if (distance === 0) return { lat: origin.lat, lon: origin.lon };
  const bearing = normaliseBearing(Math.atan2(local.east, local.north));
  const { lat, lon } = geodesicDirect(origin, bearing, distance);
  return { lat, lon };
}
