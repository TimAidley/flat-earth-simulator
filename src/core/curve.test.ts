import { describe, it, expect } from 'vitest';
import { curve, curveNaiveReference, sinc, versineOverTheta } from './curve.ts';
import { R_MEAN } from './ellipsoid.ts';
import { inverseEffectiveRadius } from './refraction.ts';

const GEOMETRIC = 1 / R_MEAN;

describe('series helpers', () => {
  it('are exact in the limit', () => {
    expect(sinc(0)).toBe(1);
    expect(versineOverTheta(0)).toBe(0);
  });

  it('match their closed forms away from the limit', () => {
    for (const t of [1e-4, 1e-3, 0.01, 0.1, 0.5]) {
      expect(sinc(t)).toBeCloseTo(Math.sin(t) / t, 12);
      expect(versineOverTheta(t)).toBeCloseTo((1 - Math.cos(t)) / t, 12);
    }
  });
});

describe('curve', () => {
  it('is the identity on a flat Earth', () => {
    const { horiz, up } = curve(12900, 326, 0);
    expect(horiz).toBe(12900);
    expect(up).toBe(326);
  });

  it('reproduces the "eight inches per mile squared" rule of thumb', () => {
    const mile = 1609.344;
    const drop = -curve(mile, 0, GEOMETRIC).up;
    expect(drop).toBeCloseTo(8 * 0.0254, 3); // 8 inches
  });

  it('gives 13.06 m of drop at the 12.9 km Albany-to-San-Francisco range', () => {
    expect(-curve(12900, 0, GEOMETRIC).up).toBeCloseTo(13.06, 2);
  });

  it('agrees with the naive reference in float64', () => {
    for (const invR of [GEOMETRIC, inverseEffectiveRadius(R_MEAN, 0.13), -GEOMETRIC / 4]) {
      for (const d of [100, 5_000, 12_900, 50_000, 200_000]) {
        for (const h of [0, 50, 442]) {
          const a = curve(d, h, invR);
          const b = curveNaiveReference(d, h, invR);
          expect(a.horiz).toBeCloseTo(b.horiz, 6);
          expect(a.up).toBeCloseTo(b.up, 6);
        }
      }
    }
  });

  it('lifts distant objects when refraction ducts (invR < 0)', () => {
    const ducted = curve(50_000, 0, inverseEffectiveRadius(R_MEAN, 1.4));
    expect(ducted.up).toBeGreaterThan(0);
  });

  it('renders a round Earth flat at exactly k = 1', () => {
    const invR = inverseEffectiveRadius(R_MEAN, 1);
    expect(invR).toBe(0);
    expect(curve(50_000, 10, invR)).toEqual({ horiz: 50_000, up: 10 });
  });
});

/**
 * The shader twin runs in float32. Simulate that by rounding every
 * intermediate, and confirm the stable formulation survives it while the
 * textbook one does not — which is the entire reason curve() is written the
 * way it is.
 */
describe('float32 behaviour of the two formulations', () => {
  const f = Math.fround;

  function upStableF32(d: number, h: number, invR: number): number {
    const th = f(f(d) * f(invR));
    const s = f(Math.sin(f(0.5 * th)));
    const versOverTh = f(f(2 * f(s * s)) / th);
    return f(f(h * f(Math.cos(th))) - f(d * versOverTh));
  }

  function upNaiveF32(d: number, h: number, invR: number): number {
    const R = f(1 / f(invR));
    const th = f(f(d) * f(invR));
    return f(f(f(R + h) * f(Math.cos(th))) - R);
  }

  const invR = inverseEffectiveRadius(R_MEAN, 0.13);
  const d = 12_900;
  const h = 0;
  const exact = curve(d, h, invR).up;

  it('the textbook form loses metres to cancellation', () => {
    const err = Math.abs(upNaiveF32(d, h, invR) - exact);
    expect(err).toBeGreaterThan(0.1);
  });

  it('the versine form stays sub-millimetre', () => {
    const err = Math.abs(upStableF32(d, h, invR) - exact);
    expect(err).toBeLessThan(1e-3);
  });
});
