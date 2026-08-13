import { describe, it, expect } from 'vitest';
import { SceneFrame } from './scene-frame.ts';
import { geodesicDirect } from '../core/index.ts';

const origin = { lat: 37.85, lon: -122.4 };
const frame = new SceneFrame(origin);

describe('SceneFrame.toEN', () => {
  it('puts north and east positive', () => {
    const n = geodesicDirect(origin, 0, 5000);
    const e = geodesicDirect(origin, 90, 5000);
    expect(frame.toEN(n.lat, n.lon).north).toBeGreaterThan(0);
    expect(frame.toEN(e.lat, e.lon).east).toBeGreaterThan(0);
  });

  /**
   * Pins the size of the equirectangular approximation rather than pretending
   * it is exact: about 13 m radial at 10 km. Documented in the module header
   * with the full range; if this tightens or loosens, the header is stale.
   */
  it('is within about 15 m of the geodesic distance at 10 km', () => {
    for (const bearing of [0, 45, 90, 200, 315]) {
      const p = geodesicDirect(origin, bearing, 10_000);
      const { east, north } = frame.toEN(p.lat, p.lon);
      expect(Math.abs(Math.hypot(east, north) - 10_000)).toBeLessThan(15);
    }
  });

  it('round-trips through toLatLon', () => {
    const p = geodesicDirect(origin, 205, 12_000);
    const { east, north } = frame.toEN(p.lat, p.lon);
    const back = frame.toLatLon(east, north);
    expect(back.lat).toBeCloseTo(p.lat, 6);
    expect(back.lon).toBeCloseTo(p.lon, 6);
  });
});

/**
 * three.js is right-handed with y up, so x cross y must equal z. East cross Up
 * is *minus* North, which makes (east, up, north) left-handed: it renders the
 * whole world mirrored left-to-right, with nothing erroring and every bearing
 * reflected about the view axis. North must therefore be -z.
 */
describe('SceneFrame.toWorldXZ handedness', () => {
  it('puts north at negative z', () => {
    const n = geodesicDirect(origin, 0, 5000);
    expect(frame.toWorldXZ(n.lat, n.lon).z).toBeLessThan(0);
  });

  it('puts south at positive z', () => {
    const s = geodesicDirect(origin, 180, 5000);
    expect(frame.toWorldXZ(s.lat, s.lon).z).toBeGreaterThan(0);
  });

  it('puts east at positive x and very little z', () => {
    const e = geodesicDirect(origin, 90, 5000);
    const { x, z } = frame.toWorldXZ(e.lat, e.lon);
    expect(x).toBeGreaterThan(4900);
    // Not exactly zero: a geodesic launched due east drifts equatorward, so
    // 5 km of it lands a metre or two south of the parallel.
    expect(Math.abs(z)).toBeLessThan(5);
  });

  it('keeps the basis right-handed: x cross y equals z', () => {
    // Unit east and unit south, taken from the frame itself rather than assumed.
    const e = frame.toWorldXZ(...(() => {
      const p = geodesicDirect(origin, 90, 1000);
      return [p.lat, p.lon] as const;
    })());
    const s = frame.toWorldXZ(...(() => {
      const p = geodesicDirect(origin, 180, 1000);
      return [p.lat, p.lon] as const;
    })());

    const east = [e.x, 0, e.z].map((v) => v / Math.hypot(e.x, e.z));
    const south = [s.x, 0, s.z].map((v) => v / Math.hypot(s.x, s.z));
    const up = [0, 1, 0];

    // east x up should land on south (the +z axis), not on north.
    const cross = [
      east[1]! * up[2]! - east[2]! * up[1]!,
      east[2]! * up[0]! - east[0]! * up[2]!,
      east[0]! * up[1]! - east[1]! * up[0]!,
    ];
    expect(cross[0]).toBeCloseTo(south[0]!, 3);
    expect(cross[2]).toBeCloseTo(south[2]!, 3);
    expect(cross[2]).toBeGreaterThan(0.99);
  });

  it('preserves distance from the geographic frame', () => {
    const p = geodesicDirect(origin, 240, 16_000);
    const { east, north } = frame.toEN(p.lat, p.lon);
    const { x, z } = frame.toWorldXZ(p.lat, p.lon);
    expect(Math.hypot(x, z)).toBeCloseTo(Math.hypot(east, north), 6);
  });

  /**
   * The bearing convention the camera uses: clockwise from north, with north
   * at -z. A target clockwise of another must sit further along +x when both
   * are ahead, which is what puts it on the right of the frame.
   */
  it('orders bearings clockwise when viewed from the origin', () => {
    const a = frame.toWorldXZ(...(() => {
      const p = geodesicDirect(origin, 240, 16_000);
      return [p.lat, p.lon] as const;
    })());
    const b = frame.toWorldXZ(...(() => {
      const p = geodesicDirect(origin, 244, 16_000);
      return [p.lat, p.lon] as const;
    })());
    // Facing roughly 242 degrees, the 244 target is clockwise of the 240 one.
    // Cross product of (a) into (b) about +y must be negative for clockwise.
    const cross = a.z * b.x - a.x * b.z;
    expect(cross).toBeLessThan(0);
  });
});
