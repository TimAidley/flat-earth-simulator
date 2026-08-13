/**
 * The scene-local frame the renderer builds geometry in.
 *
 * Geometry is expressed as metres east/north of a fixed scene origin, so it is
 * built once and the observer becomes a shader uniform. Positions use a local
 * equirectangular projection with the longitude scale taken at each point's own
 * latitude.
 *
 * ## How wrong that is
 *
 * Measured against our own geodesics over this scene:
 *
 *   5 km    6.3 m radial,  3.3 arcmin of bearing
 *   10 km  12.6 m radial,  3.9 arcmin
 *   16 km  20.3 m radial,  4.7 arcmin
 *   25 km  31.9 m radial,  6.2 arcmin
 *
 * At 600 mm that bearing error is tens of pixels, so this is not negligible
 * for matching a photograph. From a given observer most of it is a near-
 * constant rotation — about 5 arcmin across every target in this scene — which
 * cancels if the camera aims through the same projection the geometry uses
 * (see the aiming code in main.ts). The residual, the part that actually
 * distorts, is the spread: under 2 arcmin here.
 *
 * None of it reaches the numbers. The sightline calculator works in proper
 * geodesics and anything quoted as a figure comes from there, not from here.
 * Removing the approximation means projecting geometry azimuthal-equidistant
 * about the observer, which costs a geometry rebuild whenever the observer
 * moves — the trade this frame exists to avoid.
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

  /**
   * Project to three.js world axes: x east, y up, z **south**.
   *
   * North is negative z, and that is not a matter of taste. three.js is
   * right-handed with y up, which requires x cross y = z. East cross Up is
   * *minus* North, so (east, up, north) is left-handed and renders the world
   * mirrored left-to-right — everything appears, nothing errors, and the
   * bearings are all reflected about the view axis.
   *
   * Every conversion from geography into render space goes through here so
   * the convention is stated once.
   */
  toWorldXZ(lat: number, lon: number): { x: number; z: number } {
    const { east, north } = this.toEN(lat, lon);
    return { x: east, z: -north };
  }
}
