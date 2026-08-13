import { describe, it, expect } from 'vitest';
import { sampleTerrain } from './bundle.ts';
import type { TerrainGrid } from './providers/types.ts';

const NO_DATA = -32768;

/**
 * 3x3 grid over a 3-degree box. Row 0 is the north edge, column 0 the west,
 * so cell centres sit at 0.5, 1.5, 2.5 of the way across each axis.
 */
function grid(values: number[]): TerrainGrid {
  return {
    bbox: { latMin: 0, latMax: 3, lonMin: 0, lonMax: 3 },
    width: 3,
    height: 3,
    datum: 'egm2008',
    data: Float32Array.from(values),
    noDataValue: NO_DATA,
  };
}

describe('sampleTerrain', () => {
  const flat = grid([10, 10, 10, 10, 10, 10, 10, 10, 10]);

  it('returns the constant value anywhere on a flat grid', () => {
    expect(sampleTerrain(flat, 1.5, 1.5)).toBeCloseTo(10, 9);
    expect(sampleTerrain(flat, 0.1, 2.9)).toBeCloseTo(10, 9);
  });

  it('returns null outside the box', () => {
    expect(sampleTerrain(flat, -0.1, 1.5)).toBeNull();
    expect(sampleTerrain(flat, 1.5, 3.1)).toBeNull();
  });

  it('reads cell centres exactly', () => {
    // Row 0 is the northernmost, i.e. nearest latMax.
    const g = grid([1, 2, 3, 4, 5, 6, 7, 8, 9]);
    expect(sampleTerrain(g, 2.5, 0.5)).toBeCloseTo(1, 6); // north-west
    expect(sampleTerrain(g, 2.5, 2.5)).toBeCloseTo(3, 6); // north-east
    expect(sampleTerrain(g, 0.5, 0.5)).toBeCloseTo(7, 6); // south-west
    expect(sampleTerrain(g, 0.5, 2.5)).toBeCloseTo(9, 6); // south-east
  });

  it('interpolates between cell centres', () => {
    const g = grid([0, 10, 20, 0, 10, 20, 0, 10, 20]);
    expect(sampleTerrain(g, 1.5, 1.0)).toBeCloseTo(5, 6);
  });

  it('clamps rather than extrapolating outside the cell-centre envelope', () => {
    const g = grid([0, 10, 20, 0, 10, 20, 0, 10, 20]);
    expect(sampleTerrain(g, 1.5, 0.0)).toBeCloseTo(0, 6);
    expect(sampleTerrain(g, 1.5, 3.0)).toBeCloseTo(20, 6);
  });

  it('propagates no-data rather than averaging the sentinel into the terrain', () => {
    const g = grid([10, 10, 10, 10, NO_DATA, 10, 10, 10, 10]);
    expect(sampleTerrain(g, 1.5, 1.5)).toBeNull();
    // Far corner is unaffected by the hole.
    expect(sampleTerrain(g, 2.5, 2.5)).toBeCloseTo(10, 6);
  });
});
