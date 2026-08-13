/**
 * Geometry construction: terrain grid to mesh, building footprints to prisms.
 *
 * Positions are scene-local (x east, y height above datum, z north) with no
 * curvature applied — that happens per-vertex in the shader, so the flat/round
 * toggle stays free and can be swept continuously.
 *
 * Normals are computed in the flat frame. Curvature tilts a surface by at most
 * the ray angle — about 0.14 degrees over 15 km — which is far below anything
 * visible in shading, so recomputing them per model would cost a rebuild for
 * no benefit.
 */

import * as THREE from 'three';
import type { SceneFrame } from './scene-frame.ts';
import type { TerrainGrid, Building } from '../build/providers/types.ts';

export interface TerrainMeshOptions {
  /** Take every Nth cell. 1 is full resolution. */
  stride?: number;
}

export function buildTerrainGeometry(
  grid: TerrainGrid,
  frame: SceneFrame,
  opts: TerrainMeshOptions = {},
): THREE.BufferGeometry {
  const stride = Math.max(1, Math.floor(opts.stride ?? 1));
  const cols = Math.floor((grid.width - 1) / stride) + 1;
  const rows = Math.floor((grid.height - 1) / stride) + 1;

  const positions = new Float32Array(cols * rows * 3);
  const { bbox } = grid;
  const latSpan = bbox.latMax - bbox.latMin;
  const lonSpan = bbox.lonMax - bbox.lonMin;

  for (let r = 0; r < rows; r++) {
    const j = r * stride;
    const lat = bbox.latMax - ((j + 0.5) / grid.height) * latSpan;
    for (let c = 0; c < cols; c++) {
      const i = c * stride;
      const lon = bbox.lonMin + ((i + 0.5) / grid.width) * lonSpan;
      const v = grid.data[j * grid.width + i]!;
      const { east, north } = frame.toEN(lat, lon);
      const o = (r * cols + c) * 3;
      positions[o] = east;
      positions[o + 1] = v === grid.noDataValue ? 0 : v;
      positions[o + 2] = north;
    }
  }

  // Two triangles per quad. Row 0 is the northernmost, so winding is set to
  // keep front faces upward.
  const quads = (cols - 1) * (rows - 1);
  const indices = quads * 6 > 65535 ? new Uint32Array(quads * 6) : new Uint16Array(quads * 6);
  let k = 0;
  for (let r = 0; r < rows - 1; r++) {
    for (let c = 0; c < cols - 1; c++) {
      const a = r * cols + c;
      const b = a + 1;
      const d = (r + 1) * cols + c;
      const e = d + 1;
      indices[k++] = a;
      indices[k++] = d;
      indices[k++] = b;
      indices[k++] = b;
      indices[k++] = d;
      indices[k++] = e;
    }
  }

  const geometry = new THREE.BufferGeometry();
  geometry.setAttribute('position', new THREE.BufferAttribute(positions, 3));
  geometry.setIndex(new THREE.BufferAttribute(indices, 1));
  geometry.computeVertexNormals();
  return geometry;
}

/**
 * Extrude building footprints into prisms.
 *
 * Walls carry the silhouette, which is the whole point at these ranges; roofs
 * are closed with a triangle fan, which is exact for convex footprints and
 * imperceptibly wrong for concave ones several kilometres away.
 */
export function buildBuildingsGeometry(
  buildings: Building[],
  frame: SceneFrame,
  groundAt: (lat: number, lon: number) => number,
): THREE.BufferGeometry {
  const positions: number[] = [];

  const pushTri = (
    ax: number, ay: number, az: number,
    bx: number, by: number, bz: number,
    cx: number, cy: number, cz: number,
  ): void => {
    positions.push(ax, ay, az, bx, by, bz, cx, cy, cz);
  };

  for (const b of buildings) {
    const ring = b.footprint;
    if (ring.length < 3) continue;

    // One ground height for the whole footprint: a building does not follow
    // the terrain, and sampling per-vertex would shear it. An explicit base
    // elevation wins outright — an elevated deck is not on the ground at all.
    const [lon0, lat0] = ring[0]!;
    const base = b.baseElevation ?? groundAt(lat0, lon0);
    const top = base + b.height;

    const pts = ring.map(([lon, lat]) => frame.toEN(lat, lon));

    for (let i = 0; i < pts.length; i++) {
      const p = pts[i]!;
      const q = pts[(i + 1) % pts.length]!;
      pushTri(p.east, base, p.north, q.east, base, q.north, q.east, top, q.north);
      pushTri(p.east, base, p.north, q.east, top, q.north, p.east, top, p.north);
    }

    const first = pts[0]!;
    for (let i = 1; i < pts.length - 1; i++) {
      const p = pts[i]!;
      const q = pts[i + 1]!;
      pushTri(first.east, top, first.north, p.east, top, p.north, q.east, top, q.north);
    }
  }

  const geometry = new THREE.BufferGeometry();
  geometry.setAttribute('position', new THREE.Float32BufferAttribute(positions, 3));
  geometry.computeVertexNormals();
  return geometry;
}
