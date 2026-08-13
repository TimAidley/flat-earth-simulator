import { describe, it, expect } from 'vitest';
import {
  WGS84,
  WGS84_E2,
  meridionalRadius,
  primeVerticalRadius,
  eulerRadius,
} from './ellipsoid.ts';

describe('radii of curvature', () => {
  it('are a(1-e^2) and a at the equator', () => {
    expect(meridionalRadius(0)).toBeCloseTo(WGS84.a * (1 - WGS84_E2), 3);
    expect(primeVerticalRadius(0)).toBeCloseTo(WGS84.a, 9);
  });

  it('converge at the pole', () => {
    const m = meridionalRadius(90);
    const n = primeVerticalRadius(90);
    expect(m).toBeCloseTo(n, 3);
    expect(m).toBeCloseTo(WGS84.a / Math.sqrt(1 - WGS84_E2), 3);
  });

  it('put the meridional radius below the prime vertical away from the pole', () => {
    for (const lat of [0, 20, 37.89, 60, 80]) {
      expect(meridionalRadius(lat)).toBeLessThan(primeVerticalRadius(lat));
    }
  });

  it('span about 1 percent from equator to pole', () => {
    const min = meridionalRadius(0);
    const max = primeVerticalRadius(90);
    expect((max - min) / min).toBeGreaterThan(0.009);
    expect((max - min) / min).toBeLessThan(0.011);
  });
});

describe('eulerRadius', () => {
  const lat = 37.8895;

  it('reduces to the meridional radius due north and south', () => {
    expect(eulerRadius(lat, 0)).toBeCloseTo(meridionalRadius(lat), 6);
    expect(eulerRadius(lat, 180)).toBeCloseTo(meridionalRadius(lat), 6);
  });

  it('reduces to the prime vertical radius due east and west', () => {
    expect(eulerRadius(lat, 90)).toBeCloseTo(primeVerticalRadius(lat), 6);
    expect(eulerRadius(lat, 270)).toBeCloseTo(primeVerticalRadius(lat), 6);
  });

  it('lies between the two at intermediate azimuths', () => {
    const r = eulerRadius(lat, 211);
    expect(r).toBeGreaterThan(meridionalRadius(lat));
    expect(r).toBeLessThan(primeVerticalRadius(lat));
  });

  it('varies by about 0.2 percent across the Bay Area sightlines', () => {
    const toDowntown = eulerRadius(lat, 211);
    const toGoldenGate = eulerRadius(lat, 240);
    const spread = Math.abs(toGoldenGate - toDowntown) / toDowntown;
    expect(spread).toBeGreaterThan(0.001);
    expect(spread).toBeLessThan(0.004);
  });
});
