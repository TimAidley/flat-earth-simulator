import { describe, it, expect } from 'vitest';
import {
  DatumRegistry,
  DatumMismatchError,
  assertSameDatum,
  height,
  type DatumSeparations,
} from './datum.ts';

/**
 * Placeholder separations. The EGM2008 value is the well-known approximate
 * geoid height for the central Bay Area; the NAVD88 value is a stand-in and
 * must be replaced with a sourced figure before any of this is used for
 * measurement. The tests below check the machinery, not these numbers.
 */
const bayArea: DatumSeparations = {
  separations: { egm2008: 32.3, navd88: 33.0, mllw: 34.0 },
  sources: {
    egm2008: 'PLACEHOLDER: approximate EGM2008 geoid height, central SF Bay',
    navd88: 'PLACEHOLDER: unsourced',
    mllw: 'PLACEHOLDER: unsourced',
  },
};

const registry = new DatumRegistry(bayArea);

describe('DatumRegistry', () => {
  it('leaves a height in its own datum alone', () => {
    const h = height(12, 'navd88');
    expect(registry.convert(h, 'navd88')).toBe(h);
  });

  it('converts an ellipsoidal height into an orthometric one', () => {
    const ellipsoidal = height(0, 'wgs84-ellipsoid');
    expect(registry.convert(ellipsoidal, 'egm2008').value).toBeCloseTo(32.3, 9);
  });

  it('round-trips through the ellipsoid hub', () => {
    const original = height(7.5, 'navd88');
    const there = registry.convert(original, 'mllw');
    const back = registry.convert(there, 'navd88');
    expect(back.value).toBeCloseTo(original.value, 9);
    expect(back.datum).toBe('navd88');
  });

  it('routes between two non-hub datums correctly', () => {
    // navd88 -> mllw should differ by the difference of their separations.
    const h = height(0, 'navd88');
    expect(registry.convert(h, 'mllw').value).toBeCloseTo(34.0 - 33.0, 9);
  });

  it('takes differences across datums', () => {
    const a = height(10, 'navd88');
    const b = height(10, 'mllw');
    expect(registry.difference(a, b)).toBeCloseTo(1.0, 9);
  });

  it('refuses to guess a separation it was not given', () => {
    const bare = new DatumRegistry({ separations: {}, sources: {} });
    expect(() => bare.convert(height(1, 'navd88'), 'wgs84-ellipsoid')).toThrow(
      /No separation defined/,
    );
  });
});

describe('assertSameDatum', () => {
  it('passes for matching datums', () => {
    expect(() => assertSameDatum(height(1, 'navd88'), height(2, 'navd88'))).not.toThrow();
  });

  it('throws rather than silently producing a 30 m error', () => {
    expect(() =>
      assertSameDatum(height(1, 'navd88'), height(2, 'wgs84-ellipsoid')),
    ).toThrow(DatumMismatchError);
  });
});
