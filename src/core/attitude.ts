/**
 * Where the phone is pointing, from the device orientation sensors.
 *
 * `DeviceOrientationEvent` gives three intrinsic Euler angles — alpha about
 * the device's Z, then beta about the new X, then gamma about the new Y —
 * taking the device frame to an east-north-up world frame. What the app wants
 * instead is where the *rear camera* looks, which is the device's -Z, plus how
 * far the picture is rotated from level.
 *
 * Two things make this less trivial than the formula suggests.
 *
 * The screen may be rotated relative to the device, so the picture's "up" is
 * not the device's "up". That rotation is about the device's Z, which leaves
 * the camera axis alone but rolls the image — so it matters for roll and not
 * at all for bearing.
 *
 * And the accuracy is lopsided. Beta and gamma come from fusing the
 * accelerometer with the rate gyro and are good to about a degree. Alpha needs
 * the magnetometer for its absolute reference and is good to perhaps two to
 * five degrees, worse near a car or a railing. A 600 mm frame is 3.4 degrees
 * wide, so the heading this returns is a starting point to be corrected by
 * hand, never an aim. What the sensors *are* good at is relative motion, which
 * is why the app tracks with them from a user-set offset instead of trusting
 * the absolute value.
 */

const DEG = Math.PI / 180;
const RAD = 180 / Math.PI;

export interface DeviceAngles {
  /** Rotation about the device Z axis, degrees. */
  alpha: number;
  /** Rotation about the device X axis, degrees. */
  beta: number;
  /** Rotation about the device Y axis, degrees. */
  gamma: number;
  /** `screen.orientation.angle`: how far the picture is turned from natural. */
  screenAngle: number;
}

export interface Attitude {
  /** Where the rear camera points, degrees clockwise from north. */
  bearingDeg: number;
  /** How far above the horizontal it points, degrees. */
  elevationDeg: number;
  /**
   * Rotation of the picture about the view axis, degrees, right-handed about
   * the viewing direction. Zero means the screen's "up" is as close to world
   * up as the view direction allows.
   */
  rollDeg: number;
}

type Vec3 = [number, number, number];
/** Column-major: `m[i]` is the image of the i-th device axis. */
type Mat3 = [Vec3, Vec3, Vec3];

function apply(m: Mat3, v: Vec3): Vec3 {
  return [
    m[0][0] * v[0] + m[1][0] * v[1] + m[2][0] * v[2],
    m[0][1] * v[0] + m[1][1] * v[1] + m[2][1] * v[2],
    m[0][2] * v[0] + m[1][2] * v[1] + m[2][2] * v[2],
  ];
}

/**
 * Device-to-world rotation for the spec's intrinsic Z-X'-Y'' convention.
 *
 * Columns are where the device's own axes end up in east-north-up.
 */
function deviceToWorld(alphaDeg: number, betaDeg: number, gammaDeg: number): Mat3 {
  const ca = Math.cos(alphaDeg * DEG);
  const sa = Math.sin(alphaDeg * DEG);
  const cb = Math.cos(betaDeg * DEG);
  const sb = Math.sin(betaDeg * DEG);
  const cg = Math.cos(gammaDeg * DEG);
  const sg = Math.sin(gammaDeg * DEG);

  return [
    [ca * cg - sa * sb * sg, sa * cg + ca * sb * sg, -cb * sg],
    [-sa * cb, ca * cb, sb],
    [ca * sg + sa * sb * cg, sa * sg - ca * sb * cg, cb * cg],
  ];
}

function normalise(v: Vec3): Vec3 {
  const n = Math.hypot(v[0], v[1], v[2]);
  return n === 0 ? [0, 0, 0] : [v[0] / n, v[1] / n, v[2] / n];
}

function dot(a: Vec3, b: Vec3): number {
  return a[0] * b[0] + a[1] * b[1] + a[2] * b[2];
}

function cross(a: Vec3, b: Vec3): Vec3 {
  return [
    a[1] * b[2] - a[2] * b[1],
    a[2] * b[0] - a[0] * b[2],
    a[0] * b[1] - a[1] * b[0],
  ];
}

/**
 * The world direction the rear camera looks, and how far the picture is rolled.
 *
 * Bearing is relative to whatever alpha is referenced to, which is the caller's
 * problem to know: iOS reports a true-north compass heading separately, while
 * Chrome for Android leaves alpha on magnetic north and needs the local
 * declination added.
 */
export function attitudeFromDeviceOrientation({
  alpha,
  beta,
  gamma,
  screenAngle,
}: DeviceAngles): Attitude {
  const m = deviceToWorld(alpha, beta, gamma);

  // The camera looks out of the back of the device, along -Z. A screen
  // rotation is about that same Z, so it cannot move this.
  const view = normalise(apply(m, [0, 0, -1]));

  const bearingDeg = ((Math.atan2(view[0], view[1]) * RAD) % 360 + 360) % 360;
  const elevationDeg = Math.asin(Math.max(-1, Math.min(1, view[2]))) * RAD;

  // Screen axes are the device's, turned back by the screen rotation: the
  // picture's "up" is the device's "up" rotated by -screenAngle about Z.
  const t = screenAngle * DEG;
  const screenUpInDevice: Vec3 = [Math.sin(t), Math.cos(t), 0];
  const up = normalise(apply(m, screenUpInDevice));

  // Level reference: world up with the along-view part removed. Degenerate
  // when the phone points at its own feet or straight up, where "level" means
  // nothing; report zero rather than an arbitrary angle.
  const worldUp: Vec3 = [0, 0, 1];
  const along = dot(worldUp, view);
  const levelUp: Vec3 = [
    worldUp[0] - along * view[0],
    worldUp[1] - along * view[1],
    worldUp[2] - along * view[2],
  ];
  const levelLength = Math.hypot(levelUp[0], levelUp[1], levelUp[2]);
  if (levelLength < 1e-6) return { bearingDeg, elevationDeg, rollDeg: 0 };

  const ref = normalise(levelUp);
  const rollDeg = Math.atan2(dot(cross(ref, up), view), dot(ref, up)) * RAD;

  return { bearingDeg, elevationDeg, rollDeg };
}

/** Signed difference between two bearings, in (-180, 180]. */
export function bearingDelta(from: number, to: number): number {
  return ((((to - from) % 360) + 540) % 360) - 180;
}

/**
 * Apply a heading correction and wrap.
 *
 * Used for two separate corrections that both land here: magnetic declination,
 * which is a property of the place, and the offset the user establishes by
 * dragging a landmark into place, which absorbs everything else the compass
 * gets wrong.
 */
export function correctBearing(bearingDeg: number, offsetDeg: number): number {
  return (((bearingDeg + offsetDeg) % 360) + 360) % 360;
}
