import { describe, it, expect } from 'vitest';
import {
  verticalFovDeg,
  horizontalFovDeg,
  focalLength35mmFromVerticalFov,
  focalLength35mmFromHorizontalFov,
  arcminPerPixel,
  angularSizeArcmin,
  pixelsSubtended,
  equivalentFrame,
} from './optics.ts';

const THREE_TWO = 3 / 2;
const FOUR_THREE = 4 / 3;

describe('equivalentFrame', () => {
  it('recovers the 36 x 24 mm frame at 3:2', () => {
    const { width, height } = equivalentFrame(THREE_TWO);
    expect(width).toBeCloseTo(36, 6);
    expect(height).toBeCloseTo(24, 6);
  });

  it('keeps the diagonal fixed across aspect ratios', () => {
    for (const aspect of [THREE_TWO, FOUR_THREE, 16 / 9, 1]) {
      const { width, height } = equivalentFrame(aspect);
      expect(Math.hypot(width, height)).toBeCloseTo(Math.hypot(36, 24), 9);
    }
  });
});

describe('field of view', () => {
  it('gives the textbook 50 mm figures on a 3:2 frame', () => {
    expect(horizontalFovDeg(50, THREE_TWO)).toBeCloseTo(39.6, 1);
    expect(verticalFovDeg(50, THREE_TWO)).toBeCloseTo(26.99, 1);
  });

  it('gives 3.44 degrees horizontally at 600 mm', () => {
    expect(horizontalFovDeg(600, THREE_TWO)).toBeCloseTo(3.44, 2);
  });

  it('differs between phone 4:3 and camera 3:2 at the same equivalent focal length', () => {
    const a = verticalFovDeg(300, THREE_TWO);
    const b = verticalFovDeg(300, FOUR_THREE);
    expect(Math.abs(a - b)).toBeGreaterThan(0.2);
  });

  it('round-trips through focalLength35mmFromVerticalFov', () => {
    for (const f of [24, 50, 120, 300, 600, 1200]) {
      const fov = verticalFovDeg(f, THREE_TWO);
      expect(focalLength35mmFromVerticalFov(fov, THREE_TWO)).toBeCloseTo(f, 6);
    }
  });

  it('round-trips through focalLength35mmFromHorizontalFov', () => {
    for (const aspect of [THREE_TWO, FOUR_THREE, 16 / 9, 0.6]) {
      for (const f of [16, 50, 300, 1200]) {
        const fov = horizontalFovDeg(f, aspect);
        expect(focalLength35mmFromHorizontalFov(fov, aspect)).toBeCloseTo(f, 6);
      }
    }
  });

  /**
   * The number the camera match needs: given a lens of fixed angle, this is
   * the widest the render may go before the two frames stop agreeing.
   */
  it('turns a phone camera field of view into a focal length', () => {
    const f = focalLength35mmFromHorizontalFov(62, 4 / 3);
    expect(f).toBeGreaterThan(25);
    expect(f).toBeLessThan(32);
  });
});

describe('angular resolution', () => {
  it('is 0.107 arcmin per pixel at 600 mm across 1920 px', () => {
    const fov = horizontalFovDeg(600, THREE_TWO);
    expect(arcminPerPixel(fov, 1920)).toBeCloseTo(0.107, 3);
  });

  it('makes the Salesforce Tower half a degree tall at 12.9 km', () => {
    expect(angularSizeArcmin(326, 12_900) / 60).toBeCloseTo(1.45, 1);
  });
});

/**
 * The reason the app takes focal length at all: the same scene is either
 * unmeasurable or obvious depending on the lens.
 */
describe('why the lens decides whether an observation is worth making', () => {
  const hidden = 4.43; // metres of waterfront concealed at 12.9 km from 1.6 m

  it('renders the effect on a couple of pixels at a phone-typical 120 mm', () => {
    const px = pixelsSubtended(hidden, 12_900, 120, FOUR_THREE, 1920);
    expect(px).toBeLessThan(4);
  });

  it('spreads it across tens of pixels on a superzoom at 1200 mm', () => {
    const px = pixelsSubtended(hidden, 12_900, 1200, THREE_TWO, 1920);
    expect(px).toBeGreaterThan(20);
  });
});
