import { describe, it, expect } from 'vitest';
import {
  refractionCoefficient,
  inverseEffectiveRadius,
  effectiveRadius,
  refractionCoefficientFromInvR,
  REFRACTION_PRESETS,
} from './refraction.ts';
import { R_MEAN } from './ellipsoid.ts';

describe('refractionCoefficient', () => {
  it('gives k ~ 0.17 for the ICAO standard lapse rate', () => {
    expect(refractionCoefficient(1013.25, 288.15, -0.0065)).toBeCloseTo(0.17, 2);
  });

  it('gives k ~ 0.13 for a sun-heated surface', () => {
    expect(refractionCoefficient(1013.25, 288.15, -0.013)).toBeCloseTo(0.13, 2);
  });

  it('goes negative over strongly heated ground — inferior mirage', () => {
    expect(refractionCoefficient(1013.25, 313, -0.05)).toBeLessThan(0);
  });

  it('exceeds 1 under a strong surface inversion — ducting', () => {
    expect(refractionCoefficient(1013.25, 283, 0.13)).toBeGreaterThan(1);
  });
});

describe('inverseEffectiveRadius', () => {
  it('is exactly zero at k = 1, where a round Earth renders flat', () => {
    expect(inverseEffectiveRadius(R_MEAN, 1)).toBe(0);
  });

  it('passes smoothly through zero rather than blowing up', () => {
    const below = inverseEffectiveRadius(R_MEAN, 0.99);
    const above = inverseEffectiveRadius(R_MEAN, 1.01);
    expect(below).toBeGreaterThan(0);
    expect(above).toBeLessThan(0);
    expect(Math.abs(below + above)).toBeLessThan(1e-12);
  });

  it('shrinks with increasing refraction, flattening the world', () => {
    const k0 = inverseEffectiveRadius(R_MEAN, 0);
    const k13 = inverseEffectiveRadius(R_MEAN, 0.13);
    const k30 = inverseEffectiveRadius(R_MEAN, 0.3);
    expect(k13).toBeLessThan(k0);
    expect(k30).toBeLessThan(k13);
  });

  it('round-trips back to k', () => {
    for (const k of [0, 0.13, 0.17, 0.6, 1, 1.4, -0.1]) {
      const invR = inverseEffectiveRadius(R_MEAN, k);
      expect(refractionCoefficientFromInvR(R_MEAN, invR)).toBeCloseTo(k, 12);
    }
  });
});

describe('effectiveRadius', () => {
  it('is 7323 km at k = 0.13', () => {
    expect(effectiveRadius(R_MEAN, 0.13) / 1000).toBeCloseTo(7323, 0);
  });

  it('is singular at k = 1, which is why invR is the primary quantity', () => {
    expect(effectiveRadius(R_MEAN, 1)).toBe(Infinity);
  });

  it('agrees with the 7/6 rule at the k it actually implies', () => {
    expect(effectiveRadius(R_MEAN, 1 - 6 / 7) / R_MEAN).toBeCloseTo(7 / 6, 9);
  });
});

describe('presets', () => {
  it('are ordered from mirage through standard to ducting', () => {
    expect(REFRACTION_PRESETS.hotGround).toBeLessThan(REFRACTION_PRESETS.vacuum);
    expect(REFRACTION_PRESETS.vacuum).toBeLessThan(REFRACTION_PRESETS.surveying);
    expect(REFRACTION_PRESETS.surveying).toBeLessThan(REFRACTION_PRESETS.standard);
    expect(REFRACTION_PRESETS.standard).toBeLessThan(REFRACTION_PRESETS.marineInversion);
    expect(REFRACTION_PRESETS.marineInversion).toBeLessThan(REFRACTION_PRESETS.ducting);
  });
});
