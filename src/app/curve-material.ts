/**
 * The shader side of the flat/round toggle.
 *
 * Geometry arrives in three.js world axes — x east, y height above datum,
 * z south, all relative to the scene origin — with no curvature baked in.
 * The vertex shader subtracts the observer's position and applies curvature
 * from a single uniform, so moving the observer or sweeping the radius is a
 * uniform update rather than a geometry rebuild.
 *
 * `curve()` here must mirror `src/core/curve.ts`, which is unit-tested against
 * a float64 reference and against a simulated-float32 run. That is as close as
 * we can get to testing this without a GPU.
 */

import * as THREE from 'three';
import { CURVE_GLSL } from '../core/curve.ts';

export interface CurveUniforms {
  /** Inverse effective radius, 1/m. Zero is a flat Earth. */
  uInvR: { value: number };
  /**
   * Observer position in three.js world axes (x east, z south), metres from
   * the scene origin. curve() is rotationally symmetric about the observer's
   * vertical, so it works in this basis unchanged.
   */
  uObserverXZ: { value: THREE.Vector2 };
  /**
   * Water surface height above the scene datum, metres. Terrain cells below it
   * are lifted to it, so the sea rises and falls with the tide instead of
   * sitting at a fixed zero.
   */
  uWaterLevel: { value: number };
  /** e-folding distance for atmospheric extinction, metres. */
  uVisibility: { value: number };
  uSkyColor: { value: THREE.Color };
  uSunDir: { value: THREE.Vector3 };
}

export function makeCurveUniforms(): CurveUniforms {
  return {
    uInvR: { value: 0 },
    uObserverXZ: { value: new THREE.Vector2() },
    uWaterLevel: { value: 0 },
    uVisibility: { value: 60_000 },
    uSkyColor: { value: new THREE.Color(0xa8c4dc) },
    uSunDir: { value: new THREE.Vector3(0.4, 0.55, -0.7).normalize() },
  };
}

const COMMON_VERTEX_HEAD = /* glsl */ `
#include <common>
#include <logdepthbuf_pars_vertex>
${CURVE_GLSL}

uniform vec2  uObserverXZ;
uniform float uWaterLevel;
varying float vDistance;
varying float vHeight;
varying float vIsWater;
varying vec3  vNormalW;

vec3 placeVertex(vec3 local, out float dist) {
  // local: three.js world axes relative to the scene origin — x east, y height
  // above datum, z south.
  vec2 xz = vec2(local.x, local.z) - uObserverXZ;
  dist = length(xz);
  return curve(xz, local.y);
}
`;

const COMMON_FRAGMENT_HEAD = /* glsl */ `
#include <common>
#include <logdepthbuf_pars_fragment>
uniform float uVisibility;
uniform vec3  uSkyColor;
uniform vec3  uSunDir;
varying float vDistance;
varying float vHeight;
varying float vIsWater;
varying vec3  vNormalW;

/**
 * Atmospheric extinction is not decoration here. Without it the far field
 * reads as fake and neither render is believable — and it is substantive: a
 * round Earth produces a geometrically sharp horizon at a computable distance,
 * while a flat Earth can only ever fade out. Rendering both is the clearest
 * difference the two models produce.
 */
vec3 applyExtinction(vec3 color, float dist) {
  float t = 1.0 - exp(-dist / uVisibility);
  return mix(color, uSkyColor, t);
}

vec3 shade(vec3 albedo) {
  float lambert = max(dot(normalize(vNormalW), uSunDir), 0.0);
  return albedo * (0.45 + 0.55 * lambert);
}
`;

/** Terrain: coloured by height, with water flat at the clamp level. */
export function createTerrainMaterial(uniforms: CurveUniforms): THREE.ShaderMaterial {
  return new THREE.ShaderMaterial({
    uniforms: uniforms as unknown as Record<string, THREE.IUniform>,
    vertexShader: /* glsl */ `
      ${COMMON_VERTEX_HEAD}
      void main() {
        float dist;
        // Sub-datum cells are clamped flat in the bundle, so lifting them to
        // the water level floods them and the sea moves with the tide.
        vec3 flooded = vec3(position.x, max(position.y, uWaterLevel), position.z);
        vec3 p = placeVertex(flooded, dist);
        vDistance = dist;
        vHeight = flooded.y;
        vIsWater = position.y <= uWaterLevel + 0.001 ? 1.0 : 0.0;
        vNormalW = normal;
        gl_Position = projectionMatrix * modelViewMatrix * vec4(p, 1.0);
        #include <logdepthbuf_vertex>
      }
    `,
    fragmentShader: /* glsl */ `
      ${COMMON_FRAGMENT_HEAD}
      void main() {
        #include <logdepthbuf_fragment>
        vec3 albedo;
        if (vIsWater > 0.5) {
          albedo = vec3(0.09, 0.16, 0.24);
        } else {
          float t = clamp(vHeight / 300.0, 0.0, 1.0);
          albedo = mix(vec3(0.20, 0.27, 0.16), vec3(0.42, 0.39, 0.30), t);
        }
        gl_FragColor = vec4(applyExtinction(shade(albedo), vDistance), 1.0);
      }
    `,
  });
}

/** Buildings: plain grey, silhouette is what matters at these ranges. */
export function createBuildingMaterial(uniforms: CurveUniforms): THREE.ShaderMaterial {
  return new THREE.ShaderMaterial({
    // Overture footprint rings may wind either way, so culling on winding
    // would drop walls unpredictably depending on the source.
    side: THREE.DoubleSide,
    uniforms: uniforms as unknown as Record<string, THREE.IUniform>,
    vertexShader: /* glsl */ `
      ${COMMON_VERTEX_HEAD}
      void main() {
        float dist;
        vec3 p = placeVertex(position, dist);
        vDistance = dist;
        vHeight = position.y;
        vIsWater = 0.0;
        vNormalW = normal;
        gl_Position = projectionMatrix * modelViewMatrix * vec4(p, 1.0);
        #include <logdepthbuf_vertex>
      }
    `,
    fragmentShader: /* glsl */ `
      ${COMMON_FRAGMENT_HEAD}
      void main() {
        #include <logdepthbuf_fragment>
        gl_FragColor = vec4(applyExtinction(shade(vec3(0.62, 0.61, 0.60)), vDistance), 1.0);
      }
    `,
  });
}

/** Sky dome. Not curved — it is the backdrop, not part of the world. */
export function createSkyMaterial(uniforms: CurveUniforms): THREE.ShaderMaterial {
  return new THREE.ShaderMaterial({
    side: THREE.BackSide,
    depthWrite: false,
    uniforms: uniforms as unknown as Record<string, THREE.IUniform>,
    vertexShader: /* glsl */ `
      #include <common>
      #include <logdepthbuf_pars_vertex>
      varying float vY;
      void main() {
        vY = normalize(position).y;
        gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0);
        #include <logdepthbuf_vertex>
      }
    `,
    fragmentShader: /* glsl */ `
      #include <common>
      #include <logdepthbuf_pars_fragment>
      uniform vec3 uSkyColor;
      varying float vY;
      void main() {
        #include <logdepthbuf_fragment>
        float t = clamp(vY * 2.5, 0.0, 1.0);
        gl_FragColor = vec4(mix(uSkyColor, uSkyColor * 0.62 + vec3(0.0, 0.05, 0.18), t), 1.0);
      }
    `,
  });
}
