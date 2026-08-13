import * as THREE from 'three';
import {
  eulerRadius,
  inverseEffectiveRadius,
  geodesicInverse,
  hiddenHeight,
  apparentElevation,
  criticalObserverHeight,
  verticalFovDeg,
  horizontalFovDeg,
  arcminPerPixel,
  type LatLon,
} from '../core/index.ts';
import type { BundleManifest } from '../build/bundle.ts';
import type { TerrainGrid, Building } from '../build/providers/types.ts';
import { SceneFrame } from './scene-frame.ts';
import { buildTerrainGeometry, buildBuildingsGeometry } from './meshes.ts';
import {
  makeCurveUniforms,
  createTerrainMaterial,
  createBuildingMaterial,
  createSkyMaterial,
} from './curve-material.ts';

const BUNDLE = new URLSearchParams(location.search).get('bundle') ?? 'bay-area';
/** Trailing slash guaranteed by Vite; '/' when served from the web root. */
const BASE = import.meta.env.BASE_URL;

/**
 * Read a bundle inlined into the page, if one is present.
 *
 * The standalone build embeds the whole scene so the page works with no
 * network at all — which is what a strict content-security policy, an offline
 * phone on the shoreline, and a single shareable file all need.
 */
function embedded(id: string): string | null {
  return document.getElementById(id)?.textContent?.trim() ?? null;
}

function decodeBase64(b64: string): ArrayBuffer {
  const bin = atob(b64);
  const bytes = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i);
  return bytes.buffer;
}

async function loadBundle(): Promise<{
  manifest: BundleManifest;
  terrain: TerrainGrid;
  buildings: Building[];
}> {
  const inlineManifest = embedded('embedded-manifest');
  let manifest: BundleManifest;
  let raw: ArrayBuffer;
  let buildings: Building[];

  if (inlineManifest) {
    manifest = JSON.parse(inlineManifest) as BundleManifest;
    raw = decodeBase64(embedded('embedded-terrain') ?? '');
    buildings = JSON.parse(embedded('embedded-buildings') ?? '[]') as Building[];
  } else {
    manifest = (await (await fetch(`${BASE}${BUNDLE}/manifest.json`)).json()) as BundleManifest;
    raw = await (await fetch(`${BASE}${BUNDLE}/${manifest.terrain.file}`)).arrayBuffer();
    buildings = (await (
      await fetch(`${BASE}${BUNDLE}/${manifest.buildings.file}`)
    ).json()) as Building[];
  }

  return {
    manifest,
    terrain: {
      bbox: manifest.terrain.bbox,
      width: manifest.terrain.width,
      height: manifest.terrain.height,
      datum: manifest.terrain.datum as TerrainGrid['datum'],
      noDataValue: manifest.terrain.noDataValue,
      data: new Float32Array(raw),
    },
    buildings,
  };
}

function sample(grid: TerrainGrid, lat: number, lon: number): number {
  const { bbox, width, height, data } = grid;
  const i = Math.round(((lon - bbox.lonMin) / (bbox.lonMax - bbox.lonMin)) * width - 0.5);
  const j = Math.round(((bbox.latMax - lat) / (bbox.latMax - bbox.latMin)) * height - 0.5);
  if (i < 0 || j < 0 || i >= width || j >= height) return 0;
  const v = data[j * width + i]!;
  return v === grid.noDataValue ? 0 : v;
}

const el = <T extends HTMLElement>(id: string): T => document.getElementById(id) as T;

async function main(): Promise<void> {
  const { manifest, terrain, buildings } = await loadBundle();
  const scene0 = manifest.scene;

  const origin: LatLon = {
    lat: (terrain.bbox.latMin + terrain.bbox.latMax) / 2,
    lon: (terrain.bbox.lonMin + terrain.bbox.lonMax) / 2,
  };
  const frame = new SceneFrame(origin);

  // --- renderer -----------------------------------------------------------
  const canvas = el<HTMLCanvasElement>('view');
  const renderer = new THREE.WebGLRenderer({
    canvas,
    antialias: true,
    // The scene spans metres to hundreds of kilometres. Without this the far
    // field z-fights itself apart.
    logarithmicDepthBuffer: true,
  });
  renderer.setPixelRatio(Math.min(devicePixelRatio, 2));

  const scene = new THREE.Scene();
  const camera = new THREE.PerspectiveCamera(30, 1, 1, 400_000);

  const uniforms = makeCurveUniforms();

  const sky = new THREE.Mesh(new THREE.SphereGeometry(300_000, 32, 16), createSkyMaterial(uniforms));
  sky.frustumCulled = false;
  scene.add(sky);

  const terrainMesh = new THREE.Mesh(
    buildTerrainGeometry(terrain, frame),
    createTerrainMaterial(uniforms),
  );
  terrainMesh.frustumCulled = false;
  scene.add(terrainMesh);

  const buildingMesh = new THREE.Mesh(
    buildBuildingsGeometry(buildings, frame, (lat, lon) => sample(terrain, lat, lon)),
    createBuildingMaterial(uniforms),
  );
  buildingMesh.frustumCulled = false;
  scene.add(buildingMesh);

  // --- state --------------------------------------------------------------
  let observerIndex = 0;
  let targetIndex = 0;
  let bearing = 240;
  let elevation = 0;
  let focal = 300;
  let k = 0.13;
  let flat = false;
  let eyeHeight = 1.6;

  const observer = () => scene0.observers[observerIndex]!;
  const target = () => scene0.targets[targetIndex]!;

  function observerPos(): LatLon {
    const o = observer();
    return { lat: o.lat, lon: o.lon };
  }

  function eyeAboveDatum(): number {
    const o = observer();
    return (o.groundElevation ?? sample(terrain, o.lat, o.lon)) + eyeHeight;
  }

  function update(): void {
    const o = observer();
    const { x, z } = frame.toWorldXZ(o.lat, o.lon);
    uniforms.uObserverXZ.value.set(x, z);

    const radius = eulerRadius(o.lat, bearing);
    uniforms.uInvR.value = flat ? 0 : inverseEffectiveRadius(radius, k);

    camera.position.set(0, eyeAboveDatum(), 0);
    // Bearing is clockwise from true north, and north is -z in world axes.
    const cosEl = Math.cos((elevation * Math.PI) / 180);
    const dir = new THREE.Vector3(
      Math.sin((bearing * Math.PI) / 180) * cosEl,
      Math.sin((elevation * Math.PI) / 180),
      -Math.cos((bearing * Math.PI) / 180) * cosEl,
    );
    camera.lookAt(camera.position.clone().add(dir));

    const aspect = canvas.clientWidth / canvas.clientHeight;
    camera.fov = verticalFovDeg(focal, aspect);
    camera.aspect = aspect;
    camera.updateProjectionMatrix();

    readout();
  }

  function readout(): void {
    const o = observer();
    const t = target();
    const { distance, initialBearing } = geodesicInverse(observerPos(), { lat: t.lat, lon: t.lon });
    const radius = eulerRadius(o.lat, initialBearing);
    const invR = inverseEffectiveRadius(radius, k);
    const eye = eyeAboveDatum();
    const hidden = hiddenHeight(eye, distance, invR);
    const hCrit = criticalObserverHeight(distance, invR);
    const hfov = horizontalFovDeg(focal, canvas.clientWidth / canvas.clientHeight);
    const perPx = arcminPerPixel(hfov, canvas.clientWidth * Math.min(devicePixelRatio, 2));

    el('readout').innerHTML = [
      `<b>${o.name}</b> &rarr; ${t.name}`,
      `${(distance / 1000).toFixed(2)} km, bearing ${initialBearing.toFixed(1)}&deg;`,
      `eye ${eye.toFixed(2)} m above datum`,
      `hidden by curvature <b>${hidden.toFixed(2)} m</b>${flat ? ' (flat: 0.00 m)' : ''}`,
      `critical eye height ${hCrit.toFixed(2)} m`,
      `${hfov.toFixed(2)}&deg; horizontal, ${perPx.toFixed(3)}&prime;/px`,
    ].join('<br>');
  }

  // --- controls -----------------------------------------------------------
  const obsSel = el<HTMLSelectElement>('observer');
  scene0.observers.forEach((o, i) => obsSel.add(new Option(o.name, String(i))));
  obsSel.onchange = () => {
    observerIndex = Number(obsSel.value);
    update();
  };

  const tgtSel = el<HTMLSelectElement>('target');
  scene0.targets.forEach((t, i) => tgtSel.add(new Option(t.name, String(i))));
  tgtSel.onchange = () => {
    targetIndex = Number(tgtSel.value);
    aimAtTarget();
  };

  /**
   * Point at the target, not merely along its bearing.
   *
   * Elevation zero looks level, which is fine at 50 mm and useless at 600 mm:
   * the Marin headlands sit about 1.1 degrees above the horizon from the
   * Albany shore, and a 600 mm frame is only 2 degrees tall, so aiming level
   * puts the thing you asked for just outside the top of the picture.
   */
  function aimAtTarget(): void {
    const t = target();
    const to = { lat: t.lat, lon: t.lon };
    const { distance } = geodesicInverse(observerPos(), to);

    // Aim through the same projection the geometry is built in, not through
    // the geodesic bearing. The scene frame sits a near-constant ~5 arcmin off
    // true across this scene, so aiming at the true bearing lands the target
    // about fifty pixels off centre at 600 mm. The readout still reports the
    // geodesic bearing, which is the honest number.
    const o = frame.toWorldXZ(observerPos().lat, observerPos().lon);
    const w = frame.toWorldXZ(t.lat, t.lon);
    bearing = ((Math.atan2(w.x - o.x, -(w.z - o.z)) * 180) / Math.PI + 360) % 360;

    const invR = flat ? 0 : inverseEffectiveRadius(eulerRadius(observer().lat, bearing), k);
    const mid = (t.baseElevation ?? 0) + (t.structureHeight ?? 0) / 2;
    elevation = (apparentElevation(eyeAboveDatum(), distance, mid, invR) * 180) / Math.PI;
    update();
  }
  el<HTMLButtonElement>('aim').onclick = aimAtTarget;

  const bind = (id: string, onInput: (v: number) => void): HTMLInputElement => {
    const input = el<HTMLInputElement>(id);
    const label = el(`${id}-value`);
    const apply = (): void => {
      onInput(Number(input.value));
      label.textContent = input.value;
      update();
    };
    input.oninput = apply;
    apply();
    return input;
  };

  bind('focal', (v) => { focal = v; });
  bind('k', (v) => { k = v; });
  bind('eye', (v) => { eyeHeight = v; });
  bind('visibility', (v) => { uniforms.uVisibility.value = v * 1000; });

  const flatToggle = el<HTMLInputElement>('flat');
  flatToggle.onchange = () => {
    flat = flatToggle.checked;
    document.body.classList.toggle('is-flat', flat);
    update();
  };

  // --- look controls ------------------------------------------------------
  let dragging = false;
  let lastX = 0;
  let lastY = 0;
  canvas.addEventListener('pointerdown', (e) => {
    dragging = true;
    lastX = e.clientX;
    lastY = e.clientY;
    canvas.setPointerCapture(e.pointerId);
  });
  canvas.addEventListener('pointerup', (e) => {
    dragging = false;
    canvas.releasePointerCapture(e.pointerId);
  });
  canvas.addEventListener('pointermove', (e) => {
    if (!dragging) return;
    // Drag sensitivity follows the field of view: at 600 mm a pixel is worth a
    // fraction of the angle it is worth at 24 mm, and a fixed rate makes long
    // lenses unusable.
    const perPx = horizontalFovDeg(focal, canvas.clientWidth / canvas.clientHeight) / canvas.clientWidth;
    bearing = (bearing - (e.clientX - lastX) * perPx + 360) % 360;
    elevation = Math.max(-20, Math.min(20, elevation + (e.clientY - lastY) * perPx));
    lastX = e.clientX;
    lastY = e.clientY;
    update();
  });

  function resize(): void {
    renderer.setSize(canvas.clientWidth, canvas.clientHeight, false);
    update();
  }
  addEventListener('resize', resize);

  el('provenance').textContent =
    // Kept ASCII: the standalone build is emitted as page content, so the host
    // owns <head> and there is no charset declaration we control.
    `${manifest.unverified.length} unverified assumptions in this bundle. ` +
    'This is a picture, not a measurement.';

  aimAtTarget();
  resize();
  renderer.setAnimationLoop(() => renderer.render(scene, camera));
}

main().catch((err: unknown) => {
  el('readout').textContent = `Failed to start: ${err instanceof Error ? err.message : String(err)}`;
});
