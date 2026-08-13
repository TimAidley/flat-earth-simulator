/**
 * Parametric structures that no data source will give us.
 *
 * The Golden Gate towers carry the best sightlines on the Bay Trail and are
 * absent from every layer we load: they are not buildings, not summits, and
 * Overture's transportation theme has the roadway but not the towers holding
 * it up. So they are described here from published dimensions instead.
 *
 * A structure expands into ordinary {@link Building} records at build time,
 * which means the renderer and the sightline calculator both handle it through
 * the code paths they already have. No new geometry pipeline, no second
 * occlusion path to keep in step with the first.
 */

import { geodesicInverse, geodesicDirect } from '../core/index.ts';
import type { LatLon } from '../core/index.ts';
import type { Building } from './providers/types.ts';

/**
 * A suspension bridge, described by its two towers and the deck between them.
 *
 * Heights are metres above the scene's vertical datum, so for a scene whose
 * datum is mean sea level these are the published above-water figures.
 */
export interface SuspensionBridge {
  kind: 'suspension-bridge';
  id: string;
  name: string;
  towers: [LatLon, LatLon];
  /** Tower top above datum. */
  towerHeight: number;
  /** Tower plan dimensions: across the bridge axis, then along it. */
  towerAcross: number;
  towerAlong: number;
  /** Underside of the deck above datum — the published clearance. */
  deckClearance: number;
  /** Structural depth of the deck. */
  deckDepth: number;
  /** Deck width. */
  deckWidth: number;
  /** How far the deck continues beyond each tower. */
  sideSpan: number;
  /** Whether the tower positions have been checked against a source. */
  verified: boolean;
  /** Where the dimensions and positions came from. */
  source: string;
}

export type Structure = SuspensionBridge;

/** Rectangle centred on `centre`, `along` metres by `across` metres, rotated to `bearing`. */
function orientedRectangle(
  centre: LatLon,
  bearing: number,
  along: number,
  across: number,
): [number, number][] {
  const corners: [number, number][] = [];
  for (const [a, c] of [
    [+along / 2, +across / 2],
    [+along / 2, -across / 2],
    [-along / 2, -across / 2],
    [-along / 2, +across / 2],
  ] as const) {
    // Step along the axis, then perpendicular to it.
    const mid = geodesicDirect(centre, bearing, a);
    const p = geodesicDirect(mid, bearing + 90, c);
    corners.push([p.lon, p.lat]);
  }
  corners.push(corners[0]!);
  return corners;
}

/**
 * Expand a structure into buildings.
 *
 * The deck is emitted in segments rather than as one long prism: a prism is
 * flat, and over 2 km the curvature the renderer applies per-vertex needs
 * intermediate vertices to bend through. One box would stay rigid and poke
 * through the water at its ends.
 */
export function expandStructure(structure: Structure, deckSegments = 24): Building[] {
  const [a, b] = structure.towers;
  const { distance, initialBearing } = geodesicInverse(a, b);
  const out: Building[] = [];

  for (const [i, tower] of structure.towers.entries()) {
    out.push({
      id: `${structure.id}:tower-${i === 0 ? 'a' : 'b'}`,
      name: `${structure.name} tower ${i === 0 ? 'A' : 'B'}`,
      height: structure.towerHeight,
      heightSource: 'measured',
      baseElevation: 0,
      footprint: orientedRectangle(
        tower,
        initialBearing,
        structure.towerAlong,
        structure.towerAcross,
      ),
    });
  }

  const totalLength = distance + 2 * structure.sideSpan;
  const start = geodesicDirect(a, initialBearing + 180, structure.sideSpan);
  const segment = totalLength / deckSegments;

  for (let i = 0; i < deckSegments; i++) {
    const centre = geodesicDirect(start, initialBearing, (i + 0.5) * segment);
    out.push({
      id: `${structure.id}:deck-${i}`,
      height: structure.deckDepth,
      heightSource: 'measured',
      baseElevation: structure.deckClearance,
      footprint: orientedRectangle(centre, initialBearing, segment, structure.deckWidth),
    });
  }

  return out;
}

/** Distance between a bridge's towers, for reporting. */
export function towerSpan(bridge: SuspensionBridge): number {
  return geodesicInverse(bridge.towers[0], bridge.towers[1]).distance;
}
