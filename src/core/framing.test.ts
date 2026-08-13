import { describe, it, expect } from 'vitest';
import {
  coverWidthFraction,
  coverHeightFraction,
  displayedHorizontalFovDeg,
  cropScaleForFov,
  fovAfterCropScale,
  elementPointToSourcePixel,
  angularSeparation,
  focalPixelsFromTwoPoints,
  horizontalFovFromFocalPixels,
  focalPixelsFromHorizontalFov,
  guessHorizontalFovDeg,
  CalibrationError,
} from './framing.ts';

const DEG = Math.PI / 180;

describe('object-fit: cover', () => {
  it('keeps the whole width when the element is wider than the video', () => {
    expect(coverWidthFraction(4 / 3, 16 / 9)).toBe(1);
    expect(coverHeightFraction(4 / 3, 16 / 9)).toBeCloseTo((4 / 3) / (16 / 9), 12);
  });

  it('crops the width when the element is narrower', () => {
    // A 4:3 feed in a portrait half-screen loses more than half its width, and
    // with it more than half its horizontal field of view.
    expect(coverWidthFraction(4 / 3, 9 / 16)).toBeCloseTo((9 / 16) / (4 / 3), 12);
    expect(coverHeightFraction(4 / 3, 9 / 16)).toBe(1);
  });

  it('crops nothing when the shapes match', () => {
    expect(coverWidthFraction(16 / 9, 16 / 9)).toBe(1);
    expect(coverHeightFraction(16 / 9, 16 / 9)).toBe(1);
  });
});

describe('displayedHorizontalFovDeg', () => {
  it('passes the source field of view through when nothing is cropped', () => {
    expect(displayedHorizontalFovDeg(62, 4 / 3, 4 / 3)).toBeCloseTo(62, 9);
  });

  it('narrows in a portrait element, in tangent not in angle', () => {
    // The cheap mistake is scaling the angle itself. A 62-degree feed cropped
    // to 60 percent of its width is 39.2 degrees, not 37.2.
    const got = displayedHorizontalFovDeg(62, 4 / 3, 0.8);
    const fraction = 0.8 / (4 / 3);
    const expected = (2 * Math.atan(Math.tan(31 * DEG) * fraction) * 180) / Math.PI;
    expect(got).toBeCloseTo(expected, 9);
    expect(got).toBeGreaterThan(62 * fraction);
  });
});

describe('cropScaleForFov', () => {
  it('is one when the two frames already agree', () => {
    expect(cropScaleForFov(40, 40)).toBeCloseTo(1, 12);
  });

  it('is greater than one when the render is the longer lens', () => {
    expect(cropScaleForFov(60, 20)).toBeGreaterThan(1);
  });

  /**
   * The case the caller has to notice. Below one there is nothing to crop —
   * the render sees more than the lens does — and showing the two side by side
   * anyway would put two different angles in one picture, which is the exact
   * error the whole exercise is trying to avoid.
   */
  it('is less than one when the render is wider than the lens can see', () => {
    expect(cropScaleForFov(20, 60)).toBeLessThan(1);
  });

  it('round-trips through fovAfterCropScale', () => {
    const scale = cropScaleForFov(62, 8);
    expect(fovAfterCropScale(62, scale)).toBeCloseTo(8, 9);
  });
});

describe('elementPointToSourcePixel', () => {
  const source = { width: 1280, height: 960 };

  it('maps the element centre to the source centre at any zoom', () => {
    for (const cropScale of [1, 2.5, 9]) {
      const p = elementPointToSourcePixel(
        { x: 200, y: 150 },
        { width: 400, height: 300 },
        source,
        cropScale,
      );
      expect(p.x).toBeCloseTo(640, 9);
      expect(p.y).toBeCloseTo(480, 9);
    }
  });

  it('undoes a plain scale when the shapes match', () => {
    const p = elementPointToSourcePixel(
      { x: 0, y: 0 },
      { width: 640, height: 480 },
      source,
      1,
    );
    expect(p.x).toBeCloseTo(0, 9);
    expect(p.y).toBeCloseTo(0, 9);
  });

  it('accounts for the crop when the element is narrower than the feed', () => {
    // 4:3 source in a 1:2 element: cover scales by height, so the element's
    // left edge is well inside the source frame rather than at pixel zero.
    const p = elementPointToSourcePixel(
      { x: 0, y: 0 },
      { width: 300, height: 600 },
      source,
      1,
    );
    const scale = Math.max(300 / 1280, 600 / 960);
    expect(p.x).toBeCloseTo(640 - 150 / scale, 9);
    expect(p.x).toBeGreaterThan(0);
  });

  it('narrows the visible window as the digital zoom goes up', () => {
    const at = (cropScale: number): number =>
      elementPointToSourcePixel({ x: 0, y: 240 }, { width: 640, height: 480 }, source, cropScale).x;
    expect(at(4)).toBeGreaterThan(at(1));
  });
});

describe('angularSeparation', () => {
  it('is the bearing difference along the horizon', () => {
    const sep = angularSeparation(
      { bearingDeg: 250, elevationDeg: 0 },
      { bearingDeg: 260, elevationDeg: 0 },
    );
    expect((sep * 180) / Math.PI).toBeCloseTo(10, 9);
  });

  it('is the elevation difference on the same bearing', () => {
    const sep = angularSeparation(
      { bearingDeg: 250, elevationDeg: -1 },
      { bearingDeg: 250, elevationDeg: 2 },
    );
    expect((sep * 180) / Math.PI).toBeCloseTo(3, 9);
  });

  it('stays accurate for the tiny separations that calibrate best', () => {
    const sep = angularSeparation(
      { bearingDeg: 250, elevationDeg: 0 },
      { bearingDeg: 250.001, elevationDeg: 0 },
    );
    expect((sep * 180) / Math.PI).toBeCloseTo(0.001, 12);
  });

  it('is symmetric', () => {
    const a = { bearingDeg: 12, elevationDeg: 3 };
    const b = { bearingDeg: 300, elevationDeg: -7 };
    expect(angularSeparation(a, b)).toBeCloseTo(angularSeparation(b, a), 12);
  });
});

describe('focalPixelsFromTwoPoints', () => {
  const centre = { x: 640, y: 480 };

  /**
   * Round-trip against a synthetic camera: place two rays at a known focal
   * length, project them, and check the solver recovers the focal length it
   * was given. This is the whole calibration path, and if it is wrong every
   * matched frame is wrong by the same factor.
   */
  function project(focal: number, azRad: number, elRad: number): { x: number; y: number } {
    return {
      x: centre.x + focal * Math.tan(azRad),
      y: centre.y - focal * Math.tan(elRad) / Math.cos(azRad),
    };
  }

  it('recovers a known focal length from two points on the same row', () => {
    const focal = 1100;
    const a = project(focal, -0.2, 0);
    const b = project(focal, 0.25, 0);
    const sep = 0.2 + 0.25;
    expect(focalPixelsFromTwoPoints(a, b, centre, sep)).toBeCloseTo(focal, 6);
  });

  it('recovers it from two points offset in both axes', () => {
    const focal = 830;
    const aAz = -0.18;
    const aEl = 0.04;
    const bAz = 0.21;
    const bEl = -0.02;
    const a = project(focal, aAz, aEl);
    const b = project(focal, bAz, bEl);
    // Angle between the two rays, computed independently of the solver.
    const ray = (az: number, el: number): [number, number, number] => {
      const v: [number, number, number] = [Math.tan(az), Math.tan(el) / Math.cos(az), 1];
      const n = Math.hypot(...v);
      return [v[0] / n, v[1] / n, v[2] / n];
    };
    const ra = ray(aAz, aEl);
    const rb = ray(bAz, bEl);
    const sep = Math.acos(ra[0] * rb[0] + ra[1] * rb[1] + ra[2] * rb[2]);
    expect(focalPixelsFromTwoPoints(a, b, centre, sep)).toBeCloseTo(focal, 5);
  });

  it('is insensitive to the order of the two taps', () => {
    const focal = 940;
    const a = project(focal, -0.15, 0.01);
    const b = project(focal, 0.22, -0.03);
    const sep = 0.37;
    expect(focalPixelsFromTwoPoints(a, b, centre, sep)).toBeCloseTo(
      focalPixelsFromTwoPoints(b, a, centre, sep),
      6,
    );
  });

  it('refuses a separation of zero rather than dividing by it', () => {
    expect(() => focalPixelsFromTwoPoints({ x: 100, y: 480 }, { x: 900, y: 480 }, centre, 0)).toThrow(
      CalibrationError,
    );
  });

  it('refuses two taps on the same pixel', () => {
    expect(() =>
      focalPixelsFromTwoPoints({ x: 700, y: 480 }, { x: 700.2, y: 480 }, centre, 0.3),
    ).toThrow(CalibrationError);
  });

  it('refuses a separation no single frame could contain', () => {
    expect(() =>
      focalPixelsFromTwoPoints({ x: 100, y: 480 }, { x: 900, y: 480 }, centre, Math.PI / 2),
    ).toThrow(CalibrationError);
  });

  it('rejects a separation no focal length could produce', () => {
    // Both taps on the same side of the centre, ten and twenty pixels out.
    // Widening the lens pushes them apart only to about 19.5 degrees before
    // bringing them back together, so 60 degrees fits no lens at all.
    expect(() =>
      focalPixelsFromTwoPoints({ x: 650, y: 480 }, { x: 660, y: 480 }, centre, 1.05),
    ).toThrow(CalibrationError);
  });

  it('takes the longer lens when two fit', () => {
    // Same-side taps are ambiguous by nature. Both answers reproduce the
    // separation; the long one is the real camera and the short one is a
    // fisheye with the landmarks far off-axis.
    const f = focalPixelsFromTwoPoints({ x: 650, y: 480 }, { x: 660, y: 480 }, centre, 0.1);
    const sep = Math.atan(20 / f) - Math.atan(10 / f);
    expect(sep).toBeCloseTo(0.1, 9);
    expect(f).toBeGreaterThan(Math.sqrt(200));
  });
});

describe('field of view and focal length in pixels', () => {
  it('round-trips', () => {
    const f = focalPixelsFromHorizontalFov(62, 1280);
    expect(horizontalFovFromFocalPixels(f, 1280)).toBeCloseTo(62, 9);
  });

  it('gives a longer focal length for a narrower field', () => {
    expect(focalPixelsFromHorizontalFov(20, 1280)).toBeGreaterThan(
      focalPixelsFromHorizontalFov(60, 1280),
    );
  });
});

describe('guessHorizontalFovDeg', () => {
  it('reads the iOS lens names', () => {
    expect(guessHorizontalFovDeg('Back Ultra Wide Camera').fovDeg).toBeGreaterThan(80);
    expect(guessHorizontalFovDeg('Back Telephoto Camera').fovDeg).toBeLessThan(30);
  });

  it('falls back to a main camera for an unhelpful label', () => {
    expect(guessHorizontalFovDeg('camera2 0, facing back').guessedFrom).toBe('main camera');
    expect(guessHorizontalFovDeg('').guessedFrom).toBe('main camera');
  });
});
