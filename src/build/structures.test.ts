import { describe, it, expect } from 'vitest';
import { expandStructure, towerSpan } from './structures.ts';
import type { SuspensionBridge } from './structures.ts';
import { geodesicInverse } from '../core/index.ts';

/** The Golden Gate, as the scene describes it. */
const ggb: SuspensionBridge = {
  kind: 'suspension-bridge',
  id: 'ggb',
  name: 'Golden Gate Bridge',
  towers: [
    { lat: 37.814153, lon: -122.47753 },
    { lat: 37.825577, lon: -122.479535 },
  ],
  towerHeight: 227.4,
  towerAcross: 27.4,
  towerAlong: 15,
  deckClearance: 67.1,
  deckDepth: 7.6,
  deckWidth: 27.4,
  sideSpan: 343,
  verified: false,
  source: 'test',
};

describe('towerSpan', () => {
  it('matches the published 1280.2 m main span', () => {
    expect(towerSpan(ggb)).toBeCloseTo(1280.2, 0);
  });
});

describe('expandStructure', () => {
  const parts = expandStructure(ggb);
  const towers = parts.filter((p) => p.id.includes('tower'));
  const deck = parts.filter((p) => p.id.includes('deck'));

  it('emits both towers and a segmented deck', () => {
    expect(towers).toHaveLength(2);
    expect(deck.length).toBeGreaterThan(8);
  });

  it('stands the towers on the water, not on the terrain', () => {
    for (const t of towers) {
      expect(t.baseElevation).toBe(0);
      expect(t.height).toBeCloseTo(227.4, 6);
    }
  });

  it('suspends the deck at its published clearance', () => {
    for (const d of deck) {
      // A deck 67 m above the water must not be planted on the seabed.
      expect(d.baseElevation).toBeCloseTo(67.1, 6);
      expect(d.height).toBeCloseTo(7.6, 6);
    }
  });

  it('keeps the deck below the tower tops', () => {
    const deckTop = deck[0]!.baseElevation! + deck[0]!.height;
    expect(deckTop).toBeLessThan(ggb.towerHeight);
  });

  it('places tower footprints on their towers', () => {
    for (const [i, tower] of ggb.towers.entries()) {
      const ring = towers[i]!.footprint;
      const lon = ring.slice(0, 4).reduce((s, p) => s + p[0], 0) / 4;
      const lat = ring.slice(0, 4).reduce((s, p) => s + p[1], 0) / 4;
      expect(geodesicInverse(tower, { lat, lon }).distance).toBeLessThan(1);
    }
  });

  it('gives every footprint a closed ring', () => {
    for (const p of parts) {
      const ring = p.footprint;
      expect(ring.length).toBeGreaterThanOrEqual(4);
      expect(ring[0]).toEqual(ring[ring.length - 1]);
    }
  });

  it('sizes tower footprints to the given plan dimensions', () => {
    const ring = towers[0]!.footprint;
    // Corners are ordered along-axis first, so 0->1 spans the across dimension.
    const [aLon, aLat] = ring[0]!;
    const [bLon, bLat] = ring[1]!;
    const across = geodesicInverse({ lat: aLat, lon: aLon }, { lat: bLat, lon: bLon }).distance;
    expect(across).toBeCloseTo(ggb.towerAcross, 0);
  });

  /**
   * A single 2 km prism would stay rigid while the shader bends the world
   * around it, so the deck is segmented enough to follow the curve.
   */
  it('spans the full structure including side spans', () => {
    const centres = deck.map((d) => {
      const ring = d.footprint.slice(0, 4);
      return {
        lat: ring.reduce((s, p) => s + p[1], 0) / 4,
        lon: ring.reduce((s, p) => s + p[0], 0) / 4,
      };
    });
    const end = geodesicInverse(centres[0]!, centres[centres.length - 1]!).distance;
    const expected = towerSpan(ggb) + 2 * ggb.sideSpan;
    // Segment centres stop half a segment short at each end.
    expect(end).toBeGreaterThan(expected * 0.9);
    expect(end).toBeLessThan(expected);
  });

  it('lets the caller choose the segment count', () => {
    expect(expandStructure(ggb, 8).filter((p) => p.id.includes('deck'))).toHaveLength(8);
  });
});
