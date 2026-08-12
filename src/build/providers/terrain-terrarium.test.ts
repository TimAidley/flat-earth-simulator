import { describe, it, expect } from 'vitest';
import { PNG } from 'pngjs';
import {
  lonToTileX,
  latToTileY,
  tileXToLon,
  tileYToLat,
  decodeTerrarium,
  TerrariumTerrainProvider,
} from './terrain-terrarium.ts';

describe('slippy tile maths', () => {
  it('puts the antimeridian and prime meridian where expected', () => {
    expect(lonToTileX(-180, 0)).toBeCloseTo(0, 9);
    expect(lonToTileX(0, 1)).toBeCloseTo(1, 9);
    expect(lonToTileX(180, 0)).toBeCloseTo(1, 9);
  });

  it('puts the equator at the vertical midpoint', () => {
    expect(latToTileY(0, 1)).toBeCloseTo(1, 9);
  });

  it('round-trips longitude and latitude', () => {
    for (const z of [0, 5, 13]) {
      for (const lon of [-180, -122.3225, 0, 151.2]) {
        expect(tileXToLon(lonToTileX(lon, z), z)).toBeCloseTo(lon, 9);
      }
      for (const lat of [-60, -33.87, 0, 37.8895, 70]) {
        expect(tileYToLat(latToTileY(lat, z), z)).toBeCloseTo(lat, 9);
      }
    }
  });

  it('increases y southwards', () => {
    expect(latToTileY(38, 13)).toBeLessThan(latToTileY(37, 13));
  });
});

describe('decodeTerrarium', () => {
  function tileWith(r: number, g: number, b: number): PNG {
    const png = new PNG({ width: 2, height: 2 });
    for (let i = 0; i < 4; i++) {
      png.data[i * 4] = r;
      png.data[i * 4 + 1] = g;
      png.data[i * 4 + 2] = b;
      png.data[i * 4 + 3] = 255;
    }
    return png;
  }

  it('decodes the zero offset to zero metres', () => {
    // 32768 = 128 * 256, so R=128 G=0 B=0 is exactly sea level.
    expect(decodeTerrarium(tileWith(128, 0, 0))[0]).toBeCloseTo(0, 9);
  });

  it('decodes positive elevations', () => {
    expect(decodeTerrarium(tileWith(128, 100, 0))[0]).toBeCloseTo(100, 9);
  });

  it('decodes bathymetry as negative', () => {
    expect(decodeTerrarium(tileWith(127, 236, 0))[0]).toBeCloseTo(-20, 9);
  });

  it('uses the blue channel as a fractional metre', () => {
    expect(decodeTerrarium(tileWith(128, 0, 128))[0]).toBeCloseTo(0.5, 9);
  });
});

describe('coverage', () => {
  it('refuses polar boxes rather than silently returning a hole', async () => {
    const p = new TerrariumTerrainProvider();
    const c = await p.coverage({ latMin: 86, latMax: 89, lonMin: 0, lonMax: 10 });
    expect(c.available).toBe(false);
    expect(c.notes?.join(' ')).toMatch(/85\.05/);
  });

  it('reports about 15 m per pixel at zoom 13 in the Bay Area', async () => {
    const p = new TerrariumTerrainProvider({ zoom: 13 });
    const c = await p.coverage({ latMin: 37.75, latMax: 37.95, lonMin: -122.55, lonMax: -122.25 });
    expect(c.available).toBe(true);
    expect(c.resolutionMetres).toBeGreaterThan(14);
    expect(c.resolutionMetres).toBeLessThan(16);
  });
});
