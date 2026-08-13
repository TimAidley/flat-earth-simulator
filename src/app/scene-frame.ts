/**
 * The scene-local frame the renderer builds geometry in.
 *
 * Geometry is expressed as metres east/north of a fixed scene origin, so it is
 * built once and the observer becomes a shader uniform. Positions use a local
 * equirectangular projection with the longitude scale taken at each point's own
 * latitude, which over a 30 km box is a sub-metre approximation to the geodesic
 * frame.
 *
 * That approximation is fine for a picture and is *not* used for measurement:
 * the sightline calculator works in proper geodesics. Anything quoted as a
 * number comes from there, not from here.
 */

import type { LatLon } from '../core/index.ts';

const METRES_PER_DEG_LAT = 111_132.92;

export class SceneFrame {
  constructor(readonly origin: LatLon) {}

  /** Metres of longitude per degree at a given latitude. */
  private lonScale(lat: number): number {
    return 111_412.84 * Math.cos((lat * Math.PI) / 180);
  }

  /** Project to metres east/north of the scene origin. */
  toEN(lat: number, lon: number): { east: number; north: number } {
    return {
      east: (lon - this.origin.lon) * this.lonScale(lat),
      north: (lat - this.origin.lat) * METRES_PER_DEG_LAT,
    };
  }

  /** Inverse of {@link toEN}. */
  toLatLon(east: number, north: number): LatLon {
    const lat = this.origin.lat + north / METRES_PER_DEG_LAT;
    return { lat, lon: this.origin.lon + east / this.lonScale(lat) };
  }
}
