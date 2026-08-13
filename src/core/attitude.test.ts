import { describe, it, expect } from 'vitest';
import { attitudeFromDeviceOrientation, bearingDelta, correctBearing } from './attitude.ts';

/**
 * These cases are all physical poses worked out by hand, because the sign
 * conventions here are exactly the sort that produced the left-to-right mirror
 * bug in the renderer: every one of alpha, the screen angle and the roll can be
 * inverted without anything looking obviously wrong until you are standing on
 * the shore holding the phone.
 */
describe('attitudeFromDeviceOrientation', () => {
  it('points north and level when the phone is held upright at alpha zero', () => {
    const a = attitudeFromDeviceOrientation({ alpha: 0, beta: 90, gamma: 0, screenAngle: 0 });
    expect(a.bearingDeg).toBeCloseTo(0, 6);
    expect(a.elevationDeg).toBeCloseTo(0, 6);
    expect(a.rollDeg).toBeCloseTo(0, 6);
  });

  it('turns the compass the opposite way from alpha', () => {
    // Alpha increases counterclockwise seen from above; bearings increase
    // clockwise. The familiar consequence is heading = 360 - alpha.
    const a = attitudeFromDeviceOrientation({ alpha: 90, beta: 90, gamma: 0, screenAngle: 0 });
    expect(a.bearingDeg).toBeCloseTo(270, 6);
    expect(a.elevationDeg).toBeCloseTo(0, 6);
  });

  it('treats gamma as heading too when the phone is upright', () => {
    // With beta at 90 the device's own Y axis is world up, so gamma — which
    // turns about that axis — is another way of changing the heading.
    const a = attitudeFromDeviceOrientation({ alpha: 0, beta: 90, gamma: 30, screenAngle: 0 });
    expect(a.bearingDeg).toBeCloseTo(330, 6);
    expect(a.elevationDeg).toBeCloseTo(0, 6);
    expect(a.rollDeg).toBeCloseTo(0, 6);
  });

  it('looks straight down when the phone lies flat, screen up', () => {
    const a = attitudeFromDeviceOrientation({ alpha: 0, beta: 0, gamma: 0, screenAngle: 0 });
    expect(a.elevationDeg).toBeCloseTo(-90, 6);
    // Level has no meaning looking down the world up axis.
    expect(a.rollDeg).toBe(0);
  });

  it('looks up when the phone lies flat, screen down', () => {
    const a = attitudeFromDeviceOrientation({ alpha: 0, beta: 180, gamma: 0, screenAngle: 0 });
    expect(a.elevationDeg).toBeCloseTo(90, 6);
  });

  it('tilts up with beta past ninety', () => {
    const a = attitudeFromDeviceOrientation({ alpha: 0, beta: 100, gamma: 0, screenAngle: 0 });
    expect(a.bearingDeg).toBeCloseTo(0, 6);
    expect(a.elevationDeg).toBeCloseTo(10, 6);
  });

  it('rolls the picture when the screen rotates but the device does not', () => {
    const a = attitudeFromDeviceOrientation({ alpha: 0, beta: 90, gamma: 0, screenAngle: 90 });
    expect(a.bearingDeg).toBeCloseTo(0, 6);
    expect(a.elevationDeg).toBeCloseTo(0, 6);
    expect(a.rollDeg).toBeCloseTo(90, 6);
  });

  /**
   * The case that actually happens. Turned to landscape with the top edge to
   * the right, the device is rolled 90 degrees about the view axis and the
   * operating system reports a screen angle of 270 to compensate. The two must
   * cancel exactly, or every landscape frame — the orientation the split view
   * exists for — comes out on its side.
   */
  it('cancels the device roll against the screen rotation in landscape', () => {
    const a = attitudeFromDeviceOrientation({
      alpha: 270,
      beta: 0,
      gamma: 90,
      screenAngle: 270,
    });
    expect(a.bearingDeg).toBeCloseTo(0, 6);
    expect(a.elevationDeg).toBeCloseTo(0, 6);
    expect(a.rollDeg).toBeCloseTo(0, 6);
  });

  it('leaves the camera axis alone whatever the screen does', () => {
    const angles = { alpha: 37, beta: 68, gamma: -14 };
    const base = attitudeFromDeviceOrientation({ ...angles, screenAngle: 0 });
    for (const screenAngle of [90, 180, 270]) {
      const rotated = attitudeFromDeviceOrientation({ ...angles, screenAngle });
      expect(rotated.bearingDeg).toBeCloseTo(base.bearingDeg, 9);
      expect(rotated.elevationDeg).toBeCloseTo(base.elevationDeg, 9);
    }
  });

  it('always returns a bearing in [0, 360)', () => {
    for (let alpha = -720; alpha <= 720; alpha += 37) {
      const { bearingDeg } = attitudeFromDeviceOrientation({
        alpha,
        beta: 85,
        gamma: 5,
        screenAngle: 0,
      });
      expect(bearingDeg).toBeGreaterThanOrEqual(0);
      expect(bearingDeg).toBeLessThan(360);
    }
  });
});

describe('bearingDelta', () => {
  it('takes the short way round the wrap', () => {
    expect(bearingDelta(350, 10)).toBeCloseTo(20, 9);
    expect(bearingDelta(10, 350)).toBeCloseTo(-20, 9);
  });

  it('is zero for the same bearing', () => {
    expect(bearingDelta(123.4, 123.4)).toBe(0);
  });
});

describe('correctBearing', () => {
  it('wraps into [0, 360)', () => {
    expect(correctBearing(355, 13)).toBeCloseTo(8, 9);
    expect(correctBearing(5, -13)).toBeCloseTo(352, 9);
  });
});
