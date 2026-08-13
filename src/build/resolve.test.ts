import { describe, it, expect } from 'vitest';
import {
  ringCentroid,
  matchBuilding,
  findSummit,
  findNearestLand,
  resolveScene,
} from './resolve.ts';
import type { LoadedBundle } from './bundle.ts';
import type { Building, TerrainGrid } from './providers/types.ts';
import type { SceneConfig } from './scene.ts';

const bbox = { latMin: 37.8, latMax: 37.9, lonMin: -122.4, lonMax: -122.3 };

/** 20x20 grid, sea level everywhere except one hill near the north-west. */
function grid(): TerrainGrid {
  const width = 20;
  const height = 20;
  const data = new Float32Array(width * height);
  data[5 * width + 5] = 100; // the summit
  data[5 * width + 6] = 60;
  data[6 * width + 5] = 60;
  return { bbox, width, height, datum: 'egm2008', data, noDataValue: -32768 };
}

function bundle(buildings: Building[] = [], scene?: Partial<SceneConfig>): LoadedBundle {
  return {
    manifest: { scene: { terrain: { clampBelowToLevel: 0 }, ...scene } } as never,
    terrain: grid(),
    buildings,
  };
}

describe('ringCentroid', () => {
  it('finds the centre of a square', () => {
    const [lon, lat] = ringCentroid([
      [0, 0],
      [2, 0],
      [2, 2],
      [0, 2],
      [0, 0],
    ]);
    expect(lon).toBeCloseTo(1, 9);
    expect(lat).toBeCloseTo(1, 9);
  });

  it('falls back to the vertex mean for a degenerate ring', () => {
    const [lon, lat] = ringCentroid([
      [0, 0],
      [2, 2],
      [0, 0],
    ]);
    expect(Number.isFinite(lon)).toBe(true);
    expect(Number.isFinite(lat)).toBe(true);
  });
});

describe('matchBuilding', () => {
  const tower: Building = {
    id: 'a',
    name: 'Salesforce Tower',
    height: 326,
    heightSource: 'measured',
    footprint: [
      [-122.35, 37.85],
      [-122.349, 37.85],
      [-122.349, 37.851],
      [-122.35, 37.851],
      [-122.35, 37.85],
    ],
  };
  const near = { lat: 37.8505, lon: -122.3495 };

  it('matches on a normalised name', () => {
    expect(matchBuilding([tower], 'salesforce tower', near, 2000)?.id).toBe('a');
    expect(matchBuilding([tower], 'Salesforce  Tower!', near, 2000)?.id).toBe('a');
  });

  it('matches on a substring in either direction', () => {
    expect(matchBuilding([tower], 'Salesforce', near, 2000)?.id).toBe('a');
  });

  it('matches names that overlap without either containing the other', () => {
    // The real case: our 'Ferry Building clock tower' against Overture's
    // 'San Francisco Ferry Building'. A substring test rejects this pair.
    const ferry: Building = { ...tower, id: 'f', name: 'San Francisco Ferry Building' };
    expect(matchBuilding([ferry], 'Ferry Building clock tower', near, 2000)?.id).toBe('f');
  });

  it('still rejects names that merely share a common word', () => {
    const other: Building = { ...tower, id: 'o', name: 'Transamerica Pyramid' };
    expect(matchBuilding([other], 'Salesforce Tower', near, 2000)).toBeNull();
  });

  it('refuses a match outside the search radius', () => {
    // An unbounded name match can land in another city entirely.
    expect(matchBuilding([tower], 'Salesforce Tower', { lat: 37.6, lon: -122.0 }, 2000))
      .toBeNull();
  });

  it('ignores buildings with no name', () => {
    const anon = { ...tower, id: 'b' };
    delete (anon as Partial<Building>).name;
    expect(matchBuilding([anon], 'Salesforce Tower', near, 2000)).toBeNull();
  });

  it('prefers the nearest of several matches', () => {
    const far: Building = {
      ...tower,
      id: 'far',
      footprint: tower.footprint.map(([x, y]) => [x + 0.01, y + 0.01] as [number, number]),
    };
    expect(matchBuilding([far, tower], 'Salesforce Tower', near, 5000)?.id).toBe('a');
  });
});

describe('findSummit', () => {
  it('finds the high cell and its elevation', () => {
    const g = grid();
    const guessLat = bbox.latMax - (5.5 / 20) * (bbox.latMax - bbox.latMin);
    const guessLon = bbox.lonMin + (6.5 / 20) * (bbox.lonMax - bbox.lonMin);
    const summit = findSummit(g, { lat: guessLat, lon: guessLon }, 1500);
    expect(summit?.elevation).toBe(100);
  });

  it('returns sea level when there is no hill in range', () => {
    const g = grid();
    const summit = findSummit(g, { lat: 37.81, lon: -122.31 }, 500);
    expect(summit?.elevation).toBe(0);
  });
});

describe('findNearestLand', () => {
  it('finds land from a point on the water', () => {
    const g = grid();
    const lat = bbox.latMax - (5.5 / 20) * (bbox.latMax - bbox.latMin);
    const lon = bbox.lonMin + (7.5 / 20) * (bbox.lonMax - bbox.lonMin);
    const land = findNearestLand(g, { lat, lon }, 0, 2000);
    expect(land).not.toBeNull();
    expect(land!.elevation).toBeGreaterThan(0);
  });

  it('gives up rather than reaching across the whole grid', () => {
    const g = grid();
    expect(findNearestLand(g, { lat: 37.81, lon: -122.31 }, 0, 200)).toBeNull();
  });
});

describe('resolveScene target kinds', () => {
  const base = (kind: string | undefined) =>
    ({
      terrain: { clampBelowToLevel: 0 },
      observers: [],
      targets: [
        {
          id: 't',
          name: 'Salesforce Tower',
          lat: bbox.latMax - (5.5 / 20) * (bbox.latMax - bbox.latMin),
          lon: bbox.lonMin + (6.5 / 20) * (bbox.lonMax - bbox.lonMin),
          structureHeight: 326,
          verified: false,
          ...(kind ? { kind } : {}),
        },
      ],
    }) as unknown as SceneConfig;

  it('leaves a target with no declared kind alone', () => {
    // Guessing here once walked a skyscraper 1.5 km onto the nearest hill.
    const r = resolveScene(bundle(), {}, base(undefined));
    expect(r.changes).toHaveLength(0);
    expect(r.unchanged).toContain('t');
    expect(r.scene.targets[0]!.structureHeight).toBe(326);
  });

  it('leaves a fixed target alone', () => {
    const r = resolveScene(bundle(), {}, base('fixed'));
    expect(r.changes).toHaveLength(0);
  });

  it('does not summit-snap a building that failed to match', () => {
    const r = resolveScene(bundle([]), {}, base('building'));
    expect(r.changes).toHaveLength(0);
    expect(r.scene.targets[0]!.structureHeight).toBe(326);
  });

  it('snaps a summit target to the high cell', () => {
    const r = resolveScene(bundle(), {}, base('summit'));
    expect(r.changes).toHaveLength(1);
    expect(r.changes[0]!.kind).toBe('summit');
    expect(r.scene.targets[0]!.structureHeight).toBe(100);
    expect(r.changes[0]!.verified).toBe(false);
  });
});
