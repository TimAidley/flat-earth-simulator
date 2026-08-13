import { describe, it, expect } from 'vitest';
import {
  geodesicInverse,
  geodesicDirect,
  wrapLonDelta,
  toLocal,
  fromLocal,
} from './geodesy.ts';
import { WGS84 } from './ellipsoid.ts';

describe('wrapLonDelta', () => {
  it('takes the short way across the antimeridian', () => {
    expect(wrapLonDelta(-179 - 179)).toBeCloseTo(2, 9);
    expect(wrapLonDelta(179 - -179)).toBeCloseTo(-2, 9);
  });

  it('leaves ordinary deltas alone', () => {
    expect(wrapLonDelta(-0.0747)).toBeCloseTo(-0.0747, 12);
  });
});

describe('geodesicInverse', () => {
  it('measures one degree along the equator as the equatorial radius arc', () => {
    const { distance } = geodesicInverse({ lat: 0, lon: 0 }, { lat: 0, lon: 1 });
    expect(distance).toBeCloseTo((WGS84.a * Math.PI) / 180, 3);
  });

  it('heads due east along the equator', () => {
    const { initialBearing } = geodesicInverse({ lat: 0, lon: 0 }, { lat: 0, lon: 1 });
    expect(initialBearing).toBeCloseTo(90, 9);
  });

  it('heads due north along a meridian', () => {
    const { initialBearing, distance } = geodesicInverse(
      { lat: 10, lon: 5 },
      { lat: 11, lon: 5 },
    );
    expect(initialBearing).toBeCloseTo(0, 9);
    // A degree of latitude near the equator is about 110.6 km.
    expect(distance / 1000).toBeCloseTo(110.6, 0);
  });

  it('returns zero for coincident points', () => {
    const r = geodesicInverse({ lat: 37.9, lon: -122.3 }, { lat: 37.9, lon: -122.3 });
    expect(r.distance).toBe(0);
  });

  it('works across the antimeridian', () => {
    const { distance } = geodesicInverse({ lat: -17, lon: 179.5 }, { lat: -17, lon: -179.5 });
    // One degree of longitude at 17 degrees south, not 359 degrees the long way.
    expect(distance / 1000).toBeGreaterThan(100);
    expect(distance / 1000).toBeLessThan(115);
  });
});

describe('geodesicDirect', () => {
  it('inverts geodesicInverse', () => {
    const from = { lat: 37.8895, lon: -122.3225 };
    const to = { lat: 37.7897, lon: -122.3972 };
    const { distance, initialBearing, finalBearing } = geodesicInverse(from, to);
    const back = geodesicDirect(from, initialBearing, distance);
    expect(back.lat).toBeCloseTo(to.lat, 9);
    expect(back.lon).toBeCloseTo(to.lon, 9);
    expect(back.finalBearing).toBeCloseTo(finalBearing, 6);
  });

  it('round-trips over a long distance', () => {
    const from = { lat: 51.5, lon: -0.12 };
    const to = { lat: -33.87, lon: 151.21 };
    const { distance, initialBearing } = geodesicInverse(from, to);
    const back = geodesicDirect(from, initialBearing, distance);
    expect(back.lat).toBeCloseTo(to.lat, 6);
    expect(back.lon).toBeCloseTo(to.lon, 6);
  });
});

describe('local surface frame', () => {
  const origin = { lat: 37.8895, lon: -122.3225 };

  // Tolerances here are tens of micrometres over 5 km: that is Vincenty's
  // round-trip residual, not a modelling error.
  it('puts a point due north on the north axis', () => {
    const north = geodesicDirect(origin, 0, 5000);
    const local = toLocal(origin, north, 0);
    expect(local.east).toBeCloseTo(0, 4);
    expect(local.north).toBeCloseTo(5000, 4);
  });

  it('puts a point due east on the east axis', () => {
    const east = geodesicDirect(origin, 90, 5000);
    const local = toLocal(origin, east, 0);
    expect(local.east).toBeCloseTo(5000, 4);
    expect(local.north).toBeCloseTo(0, 4);
  });

  it('round-trips through fromLocal', () => {
    const target = { lat: 37.7897, lon: -122.3972 };
    const local = toLocal(origin, target, 326);
    const back = fromLocal(origin, local);
    expect(back.lat).toBeCloseTo(target.lat, 9);
    expect(back.lon).toBeCloseTo(target.lon, 9);
  });

  it('preserves geodesic distance as the planar radius', () => {
    const target = { lat: 37.7897, lon: -122.3972 };
    const local = toLocal(origin, target, 0);
    expect(Math.hypot(local.east, local.north)).toBeCloseTo(local.distance, 9);
  });
});
