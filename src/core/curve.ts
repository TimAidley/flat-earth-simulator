/**
 * The flat/round toggle, in one function.
 *
 * Given a point at surface distance `d` from the observer and height `h` above
 * the vertical datum, return where it sits in the observer's tangent frame
 * once the surface is allowed to curve away at inverse radius `invR`.
 *
 *   invR = 0  ->  flat: horiz = d, up = h. Falls out of the maths for free.
 *   invR > 0  ->  a sphere of radius 1/invR.
 *   invR < 0  ->  refraction ducting (k > 1): rays bend more than the surface
 *                 does, so distant objects are lifted rather than hidden.
 *
 * Working in inverse radius rather than radius is what makes that continuum
 * possible: R_eff = R/(1-k) blows up to infinity at k = 1 and flips sign
 * beyond it, whereas invR = (1-k)/R passes smoothly through zero.
 *
 * ## Why the formulation looks odd
 *
 * The textbook form is `up = (R + h)*cos(theta) - R`. That subtracts two
 * numbers of order 7.4e6 to produce one of order 11, which in float32 leaves
 * about 0.5 m of quantisation on an 11 m answer — 5% error, silently, in
 * exactly the quantity being measured. The versine form below never
 * materialises R at all:
 *
 *   horiz = d*sinc(theta)  + h*sin(theta)          sinc(t)       = sin(t)/t
 *   up    = h*cos(theta)   - d*versOverTh(theta)   versOverTh(t) = (1-cos t)/t
 *
 * Both series are computed directly from small quantities, so the float32
 * shader twin (see {@link CURVE_GLSL}) is as accurate as this float64 version.
 * Object tilt is handled implicitly — a tall building at range leans away from
 * the observer without any extra rotation term.
 */

/** Below this |theta| the flat-case limit is used directly. */
const THETA_EPS = 1e-9;

export interface CurvedPoint {
  /** Horizontal distance from the observer in the tangent frame, metres. */
  horiz: number;
  /** Height above the observer's tangent plane, metres. */
  up: number;
}

/**
 * Numerically stable `sin(t)/t`, exact in the limit t -> 0.
 */
export function sinc(t: number): number {
  if (Math.abs(t) < THETA_EPS) return 1;
  return Math.sin(t) / t;
}

/**
 * Numerically stable `(1 - cos t)/t`, exact in the limit t -> 0.
 * Computed via the half-angle identity 1 - cos t = 2 sin^2(t/2) so that no
 * cancellation occurs for small t.
 */
export function versineOverTheta(t: number): number {
  if (Math.abs(t) < THETA_EPS) return 0;
  const s = Math.sin(0.5 * t);
  return (2 * s * s) / t;
}

/**
 * Project a (surface distance, height) pair into the observer's tangent frame.
 *
 * @param d    Surface distance from the observer, metres (>= 0).
 * @param h    Height above the vertical datum, metres.
 * @param invR Inverse effective radius, 1/metres. Zero for a flat Earth.
 */
export function curve(d: number, h: number, invR: number): CurvedPoint {
  const theta = d * invR;
  if (Math.abs(theta) < THETA_EPS) return { horiz: d, up: h };
  return {
    horiz: d * sinc(theta) + h * Math.sin(theta),
    up: h * Math.cos(theta) - d * versineOverTheta(theta),
  };
}

/**
 * Reference implementation, for tests only.
 *
 * This is the naive `(R + h)*cos(theta) - R` form. In float64 it is accurate
 * and serves as an independent check on {@link curve}; in float32 it is not,
 * which is the whole reason {@link curve} exists.
 */
export function curveNaiveReference(d: number, h: number, invR: number): CurvedPoint {
  if (invR === 0) return { horiz: d, up: h };
  const R = 1 / invR;
  const theta = d * invR;
  return {
    horiz: (R + h) * Math.sin(theta),
    up: (R + h) * Math.cos(theta) - R,
  };
}

/**
 * GLSL twin of {@link curve}, for the renderer's ShaderMaterial.
 *
 * This must stay in step with the TypeScript above; `curve.test.ts` checks the
 * TypeScript against a float64 reference and against a simulated-float32 run,
 * which is the closest we can get to testing the shader without a GPU.
 *
 * `en` is (east, north) metres from the observer and `h` is height above the
 * vertical datum. Returns three.js-convention coordinates (y up).
 */
export const CURVE_GLSL = /* glsl */ `
uniform float uInvR;   // inverse effective radius, 1/m. 0.0 == flat earth.

vec3 curve(vec2 en, float h) {
  float d  = length(en);
  float th = d * uInvR;

  float sinc, versOverTh;
  if (abs(th) < 1e-9) {
    sinc       = 1.0;
    versOverTh = 0.0;
  } else {
    float s    = sin(0.5 * th);
    sinc       = sin(th) / th;
    versOverTh = (2.0 * s * s) / th;   // (1 - cos th) / th, no cancellation
  }

  float horiz = d * sinc + h * sin(th);
  float up    = h * cos(th) - d * versOverTh;

  vec2 dir = (d > 1e-6) ? en / d : vec2(0.0);
  return vec3(dir.x * horiz, up, dir.y * horiz);
}
`;
