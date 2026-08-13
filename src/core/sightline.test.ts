import { describe, it, expect } from 'vitest';
import {
  horizonDistance,
  horizonDip,
  hiddenHeight,
  criticalObserverHeight,
  apparentElevation,
} from './sightline.ts';
import { R_MEAN, eulerRadius } from './ellipsoid.ts';
import { inverseEffectiveRadius } from './refraction.ts';
import { geodesicInverse } from './geodesy.ts';

const K = 0.13;
const INV_R = inverseEffectiveRadius(R_MEAN, K);
const GEOMETRIC = 1 / R_MEAN;

describe('horizon', () => {
  it('is 5.41 km from 2 m eye height at k = 0.13', () => {
    expect(horizonDistance(2, INV_R) / 1000).toBeCloseTo(5.41, 1);
  });

  it('is unbounded on a flat Earth', () => {
    expect(horizonDistance(2, 0)).toBe(Infinity);
    expect(horizonDip(2, 0)).toBe(0);
  });

  // 2.54 arcmin. A phone's accelerometer resolves gravity to something like
  // 0.1-0.5 degrees, i.e. 6-30 arcmin, so measuring dip directly needs a
  // levelled instrument rather than a handset.
  it('dips about 2.54 arcmin from 2 m eye height', () => {
    const arcmin = horizonDip(2, INV_R) * (180 / Math.PI) * 60;
    expect(arcmin).toBeCloseTo(2.54, 2);
  });

  it('sits further away and dips less under refraction than without it', () => {
    expect(horizonDistance(2, INV_R)).toBeGreaterThan(horizonDistance(2, GEOMETRIC));
    expect(horizonDip(2, INV_R)).toBeLessThan(horizonDip(2, GEOMETRIC));
  });
});

describe('hidden height', () => {
  it('is zero on a flat Earth at any range', () => {
    expect(hiddenHeight(1.6, 200_000, 0)).toBe(0);
  });

  it('is zero inside the horizon and positive beyond it', () => {
    const dh = horizonDistance(1.6, INV_R);
    expect(hiddenHeight(1.6, dh, INV_R)).toBeCloseTo(0, 6);
    expect(hiddenHeight(1.6, dh * 1.01, INV_R)).toBeGreaterThan(0);
  });

  it('hides 4.43 m of the San Francisco waterfront from 1.6 m at 12.9 km', () => {
    expect(hiddenHeight(1.6, 12_900, INV_R)).toBeCloseTo(4.43, 2);
  });

  it('hides 7.27 m of the Golden Gate towers from 2 m at 15.73 km', () => {
    expect(hiddenHeight(2.0, 15_730, INV_R)).toBeCloseTo(7.27, 2);
  });

  it('falls as the observer climbs', () => {
    const heights = [1, 1.6, 2, 5, 10];
    const hidden = heights.map((h) => hiddenHeight(h, 12_900, INV_R));
    for (let i = 1; i < hidden.length; i++) {
      expect(hidden[i]!).toBeLessThan(hidden[i - 1]!);
    }
  });
});

describe('critical observer height', () => {
  it('is 11.36 m refracted and 13.06 m geometric at 12.9 km', () => {
    expect(criticalObserverHeight(12_900, INV_R)).toBeCloseTo(11.36, 2);
    expect(criticalObserverHeight(12_900, GEOMETRIC)).toBeCloseTo(13.06, 2);
  });

  it('is the height at which nothing is hidden any more', () => {
    const d = 12_900;
    const hCrit = criticalObserverHeight(d, INV_R);
    expect(hiddenHeight(hCrit, d, INV_R)).toBeCloseTo(0, 6);
    expect(hiddenHeight(hCrit * 0.9, d, INV_R)).toBeGreaterThan(0);
  });

  it('does not exist on a flat Earth', () => {
    expect(criticalObserverHeight(12_900, 0)).toBe(0);
  });

  it('separates the two models by ~1.7 m, which is what makes it measure k', () => {
    const gap =
      criticalObserverHeight(12_900, GEOMETRIC) - criticalObserverHeight(12_900, INV_R);
    expect(gap).toBeGreaterThan(1.5);
    expect(gap).toBeLessThan(2.0);
  });
});

describe('apparent elevation', () => {
  it('is the plain triangle on a flat Earth', () => {
    const el = apparentElevation(1.6, 10_000, 101.6, 0);
    expect(el).toBeCloseTo(Math.atan2(100, 10_000), 12);
  });

  it('places a point at exactly the hidden height on the horizon line', () => {
    const d = 12_900;
    const hidden = hiddenHeight(1.6, d, INV_R);
    const el = apparentElevation(1.6, d, hidden, INV_R);
    expect(el).toBeCloseTo(-horizonDip(1.6, INV_R), 6);
  });
});

/**
 * Documents the v1 scenario end to end, through our own geodesy rather than
 * assumed distances. Landmark coordinates are approximate and are asserted
 * loosely; they are placeholders until the scene config carries surveyed
 * values.
 */
describe('Albany Bulb to downtown San Francisco', () => {
  const observer = { lat: 37.8895, lon: -122.3225 };
  const salesforceTower = { lat: 37.7897, lon: -122.3972 };

  it('is about 12.9 km on a bearing of about 211 degrees', () => {
    const { distance, initialBearing } = geodesicInverse(observer, salesforceTower);
    expect(distance / 1000).toBeCloseTo(12.9, 0);
    expect(initialBearing).toBeGreaterThan(205);
    expect(initialBearing).toBeLessThan(215);
  });

  it('hides only a few metres — marginal, as expected at this range', () => {
    const { distance, initialBearing } = geodesicInverse(observer, salesforceTower);
    const invR = inverseEffectiveRadius(eulerRadius(observer.lat, initialBearing), K);
    const hidden = hiddenHeight(1.6, distance, invR);
    expect(hidden).toBeGreaterThan(3);
    expect(hidden).toBeLessThan(6);
  });

  it('puts the transition height within reach of the Bulb', () => {
    const { distance, initialBearing } = geodesicInverse(observer, salesforceTower);
    const invR = inverseEffectiveRadius(eulerRadius(observer.lat, initialBearing), K);
    const hCrit = criticalObserverHeight(distance, invR);
    expect(hCrit).toBeGreaterThan(8);
    expect(hCrit).toBeLessThan(15);
  });
});
