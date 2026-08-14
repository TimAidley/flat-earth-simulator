/**
 * Making a camera frame and a rendered frame subtend the same angle.
 *
 * The browser will not tell you what angle a camera frame covers. There is no
 * field of view in `MediaTrackSettings`, no focal length, and no EXIF on a
 * live track. `getCapabilities().zoom` exists in Chrome for Android but is
 * relative to an unknown base, and no iOS browser has it at all, because they
 * are all WKWebView. So the angle has to come from somewhere else: a guess
 * from the device label, a slider, or — best — solved from two landmarks whose
 * true separation the scene already knows.
 *
 * Everything here is expressed against the *source* frame, the pixels
 * `videoWidth`/`videoHeight` report. What reaches the screen is that frame
 * cropped twice: once by `object-fit: cover` filling an element of a different
 * shape, and again by whatever digital zoom is applied to reach the render's
 * focal length. Both crops move the angle, so both have to be in the sums.
 *
 * The pinhole model is assumed throughout: the image is a gnomonic projection,
 * so cropping by a factor divides the tangent of the half-angle, not the
 * half-angle itself. Phone cameras have real distortion, a few percent at the
 * corners of an ultra-wide, but at the centre of a long lens — which is where
 * this is used — it is far below the arcminute the exercise cares about.
 */

const DEG = Math.PI / 180;

/** Direction to a point in the sky, as the app carries it. */
export interface Aim {
  /** Degrees clockwise from north. */
  bearingDeg: number;
  /** Degrees above the horizontal. */
  elevationDeg: number;
}

/** A point in pixels, origin at the top-left. */
export interface Point {
  x: number;
  y: number;
}

/**
 * Fraction of the source frame's width that survives `object-fit: cover`.
 *
 * Cover scales the image until it fills the element and throws away the
 * overflow, so a 4:3 video in a tall phone-portrait half-screen loses most of
 * its width — and with it most of its horizontal field of view.
 */
export function coverWidthFraction(videoAspect: number, elementAspect: number): number {
  return elementAspect < videoAspect ? elementAspect / videoAspect : 1;
}

/** Fraction of the source frame's height that survives `object-fit: cover`. */
export function coverHeightFraction(videoAspect: number, elementAspect: number): number {
  return elementAspect > videoAspect ? videoAspect / elementAspect : 1;
}

/**
 * Horizontal field of view actually visible in the element, given the field of
 * view of the whole source frame.
 */
export function displayedHorizontalFovDeg(
  sourceHorizontalFovDeg: number,
  videoAspect: number,
  elementAspect: number,
): number {
  const halfTan =
    Math.tan((sourceHorizontalFovDeg * DEG) / 2) * coverWidthFraction(videoAspect, elementAspect);
  return (2 * Math.atan(halfTan) * 180) / Math.PI;
}

/**
 * How much to magnify the displayed video so it matches a target field of view.
 *
 * Greater than one means crop in — no new detail, but the geometry is right,
 * which is the whole point. Less than one would mean the render is wider than
 * the lens can see; that cannot be undone by cropping, and the caller has to
 * clamp and say so rather than quietly showing two different angles side by
 * side.
 */
export function cropScaleForFov(displayedHorizontalFovDeg: number, targetFovDeg: number): number {
  return Math.tan((displayedHorizontalFovDeg * DEG) / 2) / Math.tan((targetFovDeg * DEG) / 2);
}

/** Field of view left after magnifying a frame by a crop factor. */
export function fovAfterCropScale(fovDeg: number, scale: number): number {
  return (2 * Math.atan(Math.tan((fovDeg * DEG) / 2) / scale) * 180) / Math.PI;
}

/**
 * Where a tap on the video element lands in the source frame.
 *
 * The element shows a cover-cropped, centre-magnified window onto the source,
 * so both crops have to be undone to get back to the pixel the user meant.
 * Coordinates may fall outside the source frame if the tap was on padding.
 */
export function elementPointToSourcePixel(
  point: Point,
  element: { width: number; height: number },
  source: { width: number; height: number },
  cropScale: number,
): Point {
  // `cover` scales by whichever axis needs the most, then the digital zoom
  // magnifies about the centre. Both are centred, so the centres coincide.
  const scale =
    Math.max(element.width / source.width, element.height / source.height) * cropScale;
  return {
    x: source.width / 2 + (point.x - element.width / 2) / scale,
    y: source.height / 2 + (point.y - element.height / 2) / scale,
  };
}

/** Unit vector in east-north-up for a bearing and elevation. */
function toVector({ bearingDeg, elevationDeg }: Aim): [number, number, number] {
  const b = bearingDeg * DEG;
  const e = elevationDeg * DEG;
  const c = Math.cos(e);
  return [Math.sin(b) * c, Math.cos(b) * c, Math.sin(e)];
}

/**
 * Angle between two directions, radians.
 *
 * Computed from the cross and dot products rather than from `acos` alone,
 * which loses all its precision for the small separations calibration is most
 * accurate with.
 */
export function angularSeparation(a: Aim, b: Aim): number {
  const [ax, ay, az] = toVector(a);
  const [bx, by, bz] = toVector(b);
  const dot = ax * bx + ay * by + az * bz;
  const cross = Math.hypot(ay * bz - az * by, az * bx - ax * bz, ax * by - ay * bx);
  return Math.atan2(cross, dot);
}

export class CalibrationError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'CalibrationError';
  }
}

/**
 * Focal length in pixels, from two image points of known angular separation.
 *
 * This is the calibration that closes the gap the platform leaves. With the
 * principal point at the frame centre, the ray through a pixel offset `p` is
 * `(p.x, p.y, f)`, so for two points separated by `sep`:
 *
 *     cos sep = (p . q + f^2) / (sqrt(|p|^2 + f^2) sqrt(|q|^2 + f^2))
 *
 * Squaring turns that into a quadratic in `f^2`, so there is no iteration and
 * no starting guess to get wrong.
 *
 * Accuracy follows the separation: two landmarks a degree apart leave the
 * answer badly conditioned, so the caller should push the user towards points
 * near opposite edges of the frame.
 */
export function focalPixelsFromTwoPoints(
  a: Point,
  b: Point,
  centre: Point,
  separationRad: number,
): number {
  if (!(separationRad > 1e-6)) {
    throw new CalibrationError('The two landmarks are in the same direction; pick two further apart.');
  }
  if (separationRad >= Math.PI / 2) {
    throw new CalibrationError('The two landmarks are more than 90 degrees apart; no single frame sees both.');
  }

  const p = { x: a.x - centre.x, y: a.y - centre.y };
  const q = { x: b.x - centre.x, y: b.y - centre.y };
  if (Math.hypot(p.x - q.x, p.y - q.y) < 1) {
    throw new CalibrationError('Those taps landed on the same pixel; tap the two landmarks separately.');
  }

  const c = Math.cos(separationRad) ** 2;
  const d = p.x * q.x + p.y * q.y;
  const P = p.x * p.x + p.y * p.y;
  const Q = q.x * q.x + q.y * q.y;

  // (d + F)^2 = c (P + F)(Q + F), with F = f^2.
  const A = 1 - c;
  const B = 2 * d - c * (P + Q);
  const C = d * d - c * P * Q;

  let F: number;
  if (Math.abs(A) < 1e-12) {
    // Separation of exactly 90 degrees is excluded above, so A is only this
    // small through rounding; fall back to the linear form.
    if (Math.abs(B) < 1e-12) throw new CalibrationError('The calibration is degenerate; tap two clearly separated landmarks.');
    F = -C / B;
  } else {
    const disc = B * B - 4 * A * C;
    if (disc < 0) {
      throw new CalibrationError(
        'No lens fits those two taps. Check the landmarks were tapped in the right order.',
      );
    }
    const root = Math.sqrt(disc);
    // Squaring introduced a second solution at pi - sep, and two points on the
    // same side of the centre are genuinely ambiguous besides: the separation
    // rises then falls as the lens widens, so two focal lengths can fit. The
    // longer one is the physical answer in both cases, and landmarks tapped
    // near opposite edges — which is what the app asks for — are unambiguous.
    F = Math.max((-B + root) / (2 * A), (-B - root) / (2 * A));
  }

  if (!(F > 0) || !Number.isFinite(F)) {
    throw new CalibrationError('No lens fits those two taps; try again with the landmarks further apart.');
  }
  return Math.sqrt(F);
}

/** Horizontal field of view of a frame `widthPx` wide at a given focal length. */
export function horizontalFovFromFocalPixels(focalPixels: number, widthPx: number): number {
  return (2 * Math.atan(widthPx / (2 * focalPixels)) * 180) / Math.PI;
}

/** The inverse: focal length in pixels for a frame of known width and field of view. */
export function focalPixelsFromHorizontalFov(fovDeg: number, widthPx: number): number {
  return widthPx / (2 * Math.tan((fovDeg * DEG) / 2));
}

/**
 * A first guess at a lens's field of view from the name the platform gives it.
 *
 * Only a starting point, and marked as such in the UI: the same label covers
 * lenses of quite different angles across phone generations, and the video
 * track is often a crop of the still frame anyway. Calibration replaces it.
 */
export function guessHorizontalFovDeg(label: string): { fovDeg: number; guessedFrom: string } {
  if (/ultra.?wide/i.test(label)) return { fovDeg: 90, guessedFrom: 'ultra-wide' };
  if (/tele/i.test(label)) return { fovDeg: 24, guessedFrom: 'telephoto' };
  if (/front|face|user/i.test(label)) return { fovDeg: 60, guessedFrom: 'front camera' };
  return { fovDeg: 62, guessedFrom: 'main camera' };
}
