import { describe, it, expect } from 'vitest';
import {
  resolveHeight,
  wkbExteriorRing,
  toBytes,
  METRES_PER_FLOOR,
  DEFAULT_BUILDING_HEIGHT,
} from './buildings-overture.ts';

describe('resolveHeight', () => {
  it('prefers a tagged height and says so', () => {
    expect(resolveHeight(326, 61)).toEqual({ height: 326, heightSource: 'measured' });
  });

  it('falls back to floors when height is missing', () => {
    expect(resolveHeight(null, 10)).toEqual({
      height: 10 * METRES_PER_FLOOR,
      heightSource: 'floors',
    });
  });

  it('falls back to a default when both are missing', () => {
    expect(resolveHeight(null, null)).toEqual({
      height: DEFAULT_BUILDING_HEIGHT,
      heightSource: 'default',
    });
  });

  it('treats non-positive and non-finite values as missing', () => {
    expect(resolveHeight(0, null).heightSource).toBe('default');
    expect(resolveHeight(-5, null).heightSource).toBe('default');
    expect(resolveHeight(NaN, 4).heightSource).toBe('floors');
  });
});

/**
 * Database drivers disagree about how a BLOB comes back. Getting this wrong
 * once caused every building to be dropped while the height counters still
 * reported thousands of successes, so each shape is pinned.
 */
describe('toBytes', () => {
  const bytes = new Uint8Array([1, 2, 3, 4]);

  it('passes a Uint8Array through', () => {
    expect(toBytes(bytes)).toBe(bytes);
  });

  it('accepts a Node Buffer', () => {
    expect(Array.from(toBytes(Buffer.from([1, 2, 3, 4])))).toEqual([1, 2, 3, 4]);
  });

  it('accepts a raw ArrayBuffer', () => {
    expect(Array.from(toBytes(bytes.buffer.slice(0)))).toEqual([1, 2, 3, 4]);
  });

  it('accepts a typed-array view with a non-zero offset', () => {
    const backing = new Uint8Array([9, 9, 1, 2, 3, 4]);
    const view = new Uint8Array(backing.buffer, 2, 4);
    expect(Array.from(toBytes(view))).toEqual([1, 2, 3, 4]);
  });

  it('unwraps a driver wrapper object', () => {
    expect(Array.from(toBytes({ bytes }))).toEqual([1, 2, 3, 4]);
    expect(Array.from(toBytes({ data: bytes }))).toEqual([1, 2, 3, 4]);
  });

  it('names what it actually got when it cannot cope', () => {
    expect(() => toBytes({ nope: 1 })).toThrow(/got Object\{nope\}/);
    expect(() => toBytes(null)).toThrow(/got null/);
    expect(() => toBytes(42)).toThrow(/got number/);
  });
});

/** Build little-endian WKB by hand so the decoder is tested independently. */
function wkbPolygon(rings: [number, number][][]): Uint8Array {
  const points = rings.reduce((n, r) => n + r.length, 0);
  const bytes = 1 + 4 + 4 + rings.length * 4 + points * 16;
  const buf = new ArrayBuffer(bytes);
  const view = new DataView(buf);
  let o = 0;
  view.setUint8(o, 1); o += 1;
  view.setUint32(o, 3, true); o += 4;
  view.setUint32(o, rings.length, true); o += 4;
  for (const ring of rings) {
    view.setUint32(o, ring.length, true); o += 4;
    for (const [x, y] of ring) {
      view.setFloat64(o, x, true);
      view.setFloat64(o + 8, y, true);
      o += 16;
    }
  }
  return new Uint8Array(buf);
}

function wkbMultiPolygon(polys: [number, number][][][]): Uint8Array {
  const parts = polys.map((p) => wkbPolygon(p));
  const total = 1 + 4 + 4 + parts.reduce((n, p) => n + p.length, 0);
  const out = new Uint8Array(total);
  const view = new DataView(out.buffer);
  let o = 0;
  view.setUint8(o, 1); o += 1;
  view.setUint32(o, 6, true); o += 4;
  view.setUint32(o, polys.length, true); o += 4;
  for (const part of parts) {
    out.set(part, o);
    o += part.length;
  }
  return out;
}

const square: [number, number][] = [
  [-122.4, 37.79],
  [-122.399, 37.79],
  [-122.399, 37.791],
  [-122.4, 37.791],
  [-122.4, 37.79],
];

describe('wkbExteriorRing', () => {
  it('reads a simple polygon', () => {
    expect(wkbExteriorRing(wkbPolygon([square]))).toEqual(square);
  });

  it('drops interior rings — a hole cannot occlude anything', () => {
    const hole: [number, number][] = [
      [-122.3995, 37.7905],
      [-122.3993, 37.7905],
      [-122.3993, 37.7907],
      [-122.3995, 37.7905],
    ];
    expect(wkbExteriorRing(wkbPolygon([square, hole]))).toEqual(square);
  });

  it('takes the largest ring of a multipolygon', () => {
    const small: [number, number][] = [
      [-122.41, 37.79],
      [-122.409, 37.79],
      [-122.409, 37.791],
    ];
    const wkb = wkbMultiPolygon([[small], [square]]);
    expect(wkbExteriorRing(wkb)).toEqual(square);
  });

  it('rejects geometry types it cannot represent rather than guessing', () => {
    const point = new Uint8Array(1 + 4 + 16);
    const view = new DataView(point.buffer);
    view.setUint8(0, 1);
    view.setUint32(1, 1, true); // wkbPoint
    expect(() => wkbExteriorRing(point)).toThrow(/Unsupported WKB geometry type/);
  });
});
