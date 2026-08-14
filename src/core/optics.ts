/**
 * Lens geometry.
 *
 * The app takes focal length rather than field of view because that is what a
 * photograph records: EXIF carries `FocalLengthIn35mmFormat` directly, and the
 * point of the exercise is reproducing a real frame. It also matters more than
 * it looks — the curvature signal at these ranges is around one arcminute, so
 * at a default 60-degree field of view it lands on two or three pixels and is
 * indistinguishable from haze or DEM error. The same scene at 600 mm resolves
 * it across most of a hundred.
 */

/** Diagonal of the 35 mm frame (36 x 24 mm), in millimetres. */
export const DIAGONAL_35MM = Math.hypot(36, 24);

const RAD_TO_ARCMIN = (180 / Math.PI) * 60;

/**
 * Dimensions of the equivalent 35 mm frame for a given aspect ratio.
 *
 * 35 mm equivalence is defined on the diagonal, so reproducing a photograph
 * requires its aspect ratio: a phone's 4:3 and a DSLR's 3:2 at the same
 * "equivalent 300 mm" do not have the same vertical field of view.
 */
export function equivalentFrame(aspect: number): { width: number; height: number } {
  const height = DIAGONAL_35MM / Math.hypot(1, aspect);
  return { width: height * aspect, height };
}

/** Vertical field of view, degrees. This is the value three.js wants. */
export function verticalFovDeg(focalLength35mm: number, aspect: number): number {
  const { height } = equivalentFrame(aspect);
  return (2 * Math.atan(height / (2 * focalLength35mm)) * 180) / Math.PI;
}

/** Horizontal field of view, degrees. */
export function horizontalFovDeg(focalLength35mm: number, aspect: number): number {
  const { width } = equivalentFrame(aspect);
  return (2 * Math.atan(width / (2 * focalLength35mm)) * 180) / Math.PI;
}

/** Recover the 35 mm equivalent focal length from a known vertical field of view. */
export function focalLength35mmFromVerticalFov(fovDeg: number, aspect: number): number {
  const { height } = equivalentFrame(aspect);
  return height / (2 * Math.tan((fovDeg * Math.PI) / 360));
}

/**
 * The same from a horizontal field of view.
 *
 * This is the direction needed to answer "how wide can the render go before
 * the camera cannot follow", since a camera's field of view is a fixed angle
 * and the render's is whatever the focal slider says.
 */
export function focalLength35mmFromHorizontalFov(fovDeg: number, aspect: number): number {
  const { width } = equivalentFrame(aspect);
  return width / (2 * Math.tan((fovDeg * Math.PI) / 360));
}

/** Angular resolution in arcminutes per pixel, given a field of view and pixel count. */
export function arcminPerPixel(fovDeg: number, pixels: number): number {
  return (fovDeg * 60) / pixels;
}

/** Angular size of an object, in arcminutes. */
export function angularSizeArcmin(size: number, distance: number): number {
  return Math.atan2(size, distance) * RAD_TO_ARCMIN;
}

/** Radians to arcminutes. */
export function toArcmin(radians: number): number {
  return radians * RAD_TO_ARCMIN;
}

/**
 * How many pixels an object of a given size subtends at a given range, for a
 * given lens and sensor width. This is the number that decides whether an
 * observation is worth making at all.
 */
export function pixelsSubtended(
  size: number,
  distance: number,
  focalLength35mm: number,
  aspect: number,
  pixelsWide: number,
): number {
  const fov = horizontalFovDeg(focalLength35mm, aspect);
  return angularSizeArcmin(size, distance) / arcminPerPixel(fov, pixelsWide);
}
