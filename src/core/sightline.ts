/**
 * What an observer at a given eye height can and cannot see.
 *
 * All of these take `invR` (inverse effective radius, 1/m) rather than a
 * radius, so the flat case is invR = 0 rather than a special branch, and
 * ducting (invR < 0) is expressible.
 */

import { curve } from './curve.ts';

/**
 * Distance to the visible horizon, metres.
 *
 *   d_h = sqrt(2h / invR)
 *
 * Infinite on a flat Earth or under ducting, which is the correct answer: with
 * no curvature there is no geometric horizon at all, only whatever the
 * atmosphere's extinction eventually hides. That the flat model cannot produce
 * a sharp horizon line is one of its more visible consequences.
 */
export function horizonDistance(eyeHeight: number, invR: number): number {
  if (invR <= 0 || eyeHeight <= 0) return Infinity;
  return Math.sqrt((2 * eyeHeight) / invR);
}

/**
 * Angle of the visible horizon below true horizontal, radians.
 *
 *   dip = sqrt(2 * h * invR)
 *
 * Zero on a flat Earth. Measuring this directly is a clean test but needs a
 * levelled instrument — a phone's accelerometer resolves gravity to something
 * like 0.1-0.5 degrees, and the dip from standing height is about 0.04
 * degrees, so it is roughly an order of magnitude out of reach on a handset.
 */
export function horizonDip(eyeHeight: number, invR: number): number {
  if (invR <= 0 || eyeHeight <= 0) return 0;
  return Math.sqrt(2 * eyeHeight * invR);
}

/**
 * Height of a distant object concealed below the horizon, metres.
 *
 *   hidden = (d - d_h)^2 * invR / 2      for d > d_h
 *
 * Zero on a flat Earth, and zero for anything closer than the horizon.
 */
export function hiddenHeight(eyeHeight: number, distance: number, invR: number): number {
  if (invR <= 0) return 0;
  const dh = horizonDistance(eyeHeight, invR);
  if (!Number.isFinite(dh) || distance <= dh) return 0;
  const beyond = distance - dh;
  return (beyond * beyond * invR) / 2;
}

/**
 * The eye height at which a target at `distance` stops being hidden at all —
 * the point where the observer's horizon reaches the target's base.
 *
 *   h_crit = d^2 * invR / 2
 *
 * This is the sharpest test available at short range. Below h_crit the
 * target's waterline is cut; above it, fully exposed. The flat model predicts
 * no such transition at any height, so walking the observer up through it and
 * watching the waterline reappear is a far more robust experiment than any
 * single frame — it is a differential measurement, so tide, building-model
 * error, lens calibration and atmospheric conditions all cancel.
 *
 * The gap between the geometric and refracted values of h_crit is itself
 * informative: observing which one the transition actually happens at
 * measures k.
 */
export function criticalObserverHeight(distance: number, invR: number): number {
  if (invR <= 0) return 0;
  return (distance * distance * invR) / 2;
}

/**
 * Apparent elevation of a target above true horizontal, radians.
 *
 * Positive is above the horizontal through the observer's eye. Compare against
 * `-horizonDip(...)` to see whether the point falls above or below the visible
 * horizon.
 */
export function apparentElevation(
  eyeHeight: number,
  distance: number,
  targetHeight: number,
  invR: number,
): number {
  const { horiz, up } = curve(distance, targetHeight, invR);
  return Math.atan2(up - eyeHeight, horiz);
}

/**
 * The lowest point of a target that remains visible, as a height above the
 * vertical datum. Equivalent to `targetBase + hiddenHeight(...)` but expressed
 * against the datum so it can be compared directly with a tide level or a
 * building's base elevation.
 */
export function lowestVisibleHeight(
  eyeHeight: number,
  distance: number,
  targetBaseHeight: number,
  invR: number,
): number {
  return targetBaseHeight + hiddenHeight(eyeHeight, distance, invR);
}
