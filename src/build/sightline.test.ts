import { describe, it, expect } from 'vitest';
import { analyseSightline, pointInRing } from './sightline.ts';
import type { LoadedBundle } from './bundle.ts';
import type { Building } from './providers/types.ts';

/** Flat sea-level scene, so the only thing acting is curvature. */
function seaBundle(buildings: Building[] = []): LoadedBundle {
  const width = 64;
  const height = 64;
  return {
    manifest: {
      formatVersion: 1,
      builtAt: '',
      unverified: [],
      scene: { terrain: { cellSizeMetres: 200 } },
    } as unknown as LoadedBundle['manifest'],
    terrain: {
      bbox: { latMin: 37.7, latMax: 38.0, lonMin: -122.6, lonMax: -122.2 },
      width,
      height,
      datum: 'egm2008',
      noDataValue: -32768,
      data: new Float32Array(width * height), // all zero: sea level
    },
    buildings,
  };
}

const observer = {
  position: { lat: 37.8895, lon: -122.3225 },
  groundElevation: 0,
  eyeHeight: 1.6,
};
const target = {
  position: { lat: 37.7897, lon: -122.3972 },
  baseElevation: 0,
  structureHeight: 326,
};

describe('analyseSightline over open water', () => {
  it('measures the expected distance and bearing', () => {
    const r = analyseSightline(seaBundle(), observer, target);
    expect(r.distance / 1000).toBeCloseTo(12.9, 0);
    expect(r.bearing).toBeGreaterThan(205);
    expect(r.bearing).toBeLessThan(215);
  });

  it('hides several metres on a round Earth and nothing on a flat one', () => {
    const r = analyseSightline(seaBundle(), observer, target);
    expect(r.round.lowestVisible).toBeGreaterThan(3);
    expect(r.round.lowestVisible).toBeLessThan(6);
    expect(r.flat.lowestVisible).toBeCloseTo(0, 6);
    expect(r.difference).toBeCloseTo(r.round.lowestVisible, 6);
  });

  it('reports no obstruction when there is genuinely nothing in the way', () => {
    const r = analyseSightline(seaBundle(), observer, target);
    expect(r.round.blockedByObstruction).toBe(false);
    expect(r.round.fullyHidden).toBe(false);
  });

  it('uses height above datum, not above ground, for the horizon', () => {
    // On a 10 m mound the horizon is ~12.8 km, not the ~4.8 km that
    // eye-above-ground would give — the difference this experiment turns on.
    const high = { ...observer, groundElevation: 10 };
    const r = analyseSightline(seaBundle(), high, target);
    expect(r.round.horizonDistance / 1000).toBeGreaterThan(12);
    expect(r.round.lowestVisible).toBeLessThan(r.round.hiddenByCurvature + 0.01);
    expect(r.round.lowestVisible).toBeLessThan(1);
  });

  it('recovers the waterline as the observer climbs through the critical height', () => {
    const low = analyseSightline(seaBundle(), { ...observer, groundElevation: 0 }, target);
    const high = analyseSightline(seaBundle(), { ...observer, groundElevation: 12 }, target);
    expect(low.round.lowestVisible).toBeGreaterThan(high.round.lowestVisible);
    expect(high.round.lowestVisible).toBeCloseTo(0, 1);
    // The flat model predicts no such change at any height.
    expect(low.flat.lowestVisible).toBeCloseTo(high.flat.lowestVisible, 6);
  });

  it('shrinks the difference as refraction increases, vanishing at k = 1', () => {
    const mild = analyseSightline(seaBundle(), observer, target, { k: 0 });
    const strong = analyseSightline(seaBundle(), observer, target, { k: 0.6 });
    const ducted = analyseSightline(seaBundle(), observer, target, { k: 1 });
    expect(strong.difference).toBeLessThan(mild.difference);
    expect(ducted.difference).toBeCloseTo(0, 6);
  });
});

describe('obstructions', () => {
  /** A tall block straddling the ray about a third of the way out. */
  function wall(): Building[] {
    return [
      {
        id: 'wall',
        height: 200,
        heightSource: 'measured',
        footprint: [
          [-122.35, 37.85],
          [-122.34, 37.85],
          [-122.34, 37.87],
          [-122.35, 37.87],
          [-122.35, 37.85],
        ],
      },
    ];
  }

  it('flags a building that genuinely hides part of the target', () => {
    const r = analyseSightline(seaBundle(wall()), observer, target, {
      includeBuildings: true,
    });
    expect(r.round.blockedByObstruction).toBe(true);
    expect(r.round.blocker?.kind).toBe('building');
    expect(r.round.lowestVisible).toBeGreaterThan(100);
  });

  it('blocks the flat model too — an obstruction is not a curvature effect', () => {
    const r = analyseSightline(seaBundle(wall()), observer, target, {
      includeBuildings: true,
    });
    expect(r.flat.blockedByObstruction).toBe(true);
  });

  it('ignores buildings when asked to', () => {
    const r = analyseSightline(seaBundle(wall()), observer, target, {
      includeBuildings: false,
    });
    expect(r.round.blockedByObstruction).toBe(false);
  });
});

describe('pointInRing', () => {
  const square: [number, number][] = [
    [0, 0],
    [2, 0],
    [2, 2],
    [0, 2],
    [0, 0],
  ];

  it('accepts interior points and rejects exterior ones', () => {
    expect(pointInRing(1, 1, square)).toBe(true);
    expect(pointInRing(3, 1, square)).toBe(false);
    expect(pointInRing(-1, 1, square)).toBe(false);
    expect(pointInRing(1, 3, square)).toBe(false);
  });
});
