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
  focalLength35mmFromHorizontalFov,
  arcminPerPixel,
  type LatLon,
} from '../core/index.ts';
import {
  displayedHorizontalFovDeg,
  cropScaleForFov,
  elementPointToSourcePixel,
  angularSeparation,
  focalPixelsFromTwoPoints,
  horizontalFovFromFocalPixels,
  guessHorizontalFovDeg,
  CalibrationError,
  type Aim,
} from '../core/framing.ts';
import { bearingDelta } from '../core/attitude.ts';
import { predictWaterLevel } from '../core/tide.ts';
import type { TideStation } from '../build/providers/types.ts';
import { listCameras, openCamera, stopCamera, CameraUnavailableError } from './camera.ts';
import { watchLocation, insideBBox, GeolocationUnavailableError, type Fix } from './geolocate.ts';
import { startOrientation, OrientationUnavailableError, type OrientationReading } from './orientation.ts';
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

/** Widest the focal slider goes with no camera constraining it. */
const FOCAL_MIN = 16;

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
  tide: TideStation[];
}> {
  const inlineManifest = embedded('embedded-manifest');
  let manifest: BundleManifest;
  let raw: ArrayBuffer;
  let buildings: Building[];
  let tide: TideStation[] = [];

  if (inlineManifest) {
    manifest = JSON.parse(inlineManifest) as BundleManifest;
    raw = decodeBase64(embedded('embedded-terrain') ?? '');
    buildings = JSON.parse(embedded('embedded-buildings') ?? '[]') as Building[];
    tide = JSON.parse(embedded('embedded-tide') ?? '[]') as TideStation[];
  } else {
    manifest = (await (await fetch(`${BASE}${BUNDLE}/manifest.json`)).json()) as BundleManifest;
    raw = await (await fetch(`${BASE}${BUNDLE}/${manifest.terrain.file}`)).arrayBuffer();
    buildings = (await (
      await fetch(`${BASE}${BUNDLE}/${manifest.buildings.file}`)
    ).json()) as Building[];
    if (manifest.tide) {
      tide = (await (
        await fetch(`${BASE}${BUNDLE}/${manifest.tide.file}`)
      ).json()) as TideStation[];
    }
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
    tide,
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

/** localStorage, but never fatal: Safari in private mode throws on write. */
function remember(key: string, value: string): void {
  try {
    localStorage.setItem(key, value);
  } catch {
    /* not worth telling anyone about */
  }
}

function recall(key: string): string | null {
  try {
    return localStorage.getItem(key);
  } catch {
    return null;
  }
}

/** A place to stand: a scene observer, or wherever the satellites say. */
interface ActiveObserver {
  name: string;
  lat: number;
  lon: number;
  groundElevation?: number;
}

async function main(): Promise<void> {
  const { manifest, terrain, buildings, tide } = await loadBundle();
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
  let roll = 0;
  let focal = 300;
  let k = 0.13;
  let flat = false;
  let eyeHeight = 1.6;
  let when = new Date();
  let mode: 'render' | 'split' | 'blend' = 'render';
  let stream: MediaStream | null = null;

  // Camera framing. `cameraFovDeg` is the horizontal angle of the whole source
  // frame, which is the one thing the platform will not tell us.
  let cameraFovDeg = 62;
  let cameraFovSource = 'assumed';
  let currentLensLabel = '';
  /** Magnification currently applied to the video to match the render. */
  let cropScale = 1;
  /** Set when the render is wider than the lens and the two cannot agree. */
  let widestMatchable = 0;

  // GPS.
  let gpsFix: Fix | null = null;
  let useGps = false;
  let stopGps: (() => void) | null = null;

  // Orientation.
  let gyroOn = false;
  let stopGyro: (() => void) | null = null;
  let lastReading: OrientationReading | null = null;
  let gyroOffsetBearing = 0;
  let gyroOffsetElevation = 0;

  const observerOf = (): ActiveObserver => {
    if (useGps && gpsFix) {
      return { name: `My location (±${Math.round(gpsFix.accuracyM)} m)`, lat: gpsFix.lat, lon: gpsFix.lon };
    }
    return scene0.observers[observerIndex]!;
  };
  const target = () => scene0.targets[targetIndex]!;

  function observerPos(): LatLon {
    const o = observerOf();
    return { lat: o.lat, lon: o.lon };
  }

  /**
   * Water level in the scene datum at the chosen time.
   *
   * Nearest station wins. The Bay's range is comparable to the whole curvature
   * effect at these distances, so a fixed zero would be a first-order error in
   * every over-water sightline — and zero is not even mean sea level, it is
   * mean lower low water, about a metre down.
   */
  function waterLevel(): number {
    if (tide.length === 0) return 0;
    const o = observerPos();
    let best = tide[0]!;
    let bestD = Infinity;
    for (const st of tide) {
      const d = geodesicInverse(o, { lat: st.lat, lon: st.lon }).distance;
      if (d < bestD) {
        bestD = d;
        best = st;
      }
    }
    return predictWaterLevel(best.constituents, best.datums, when);
  }

  function eyeAboveDatum(): number {
    const o = observerOf();
    // Ground, not water: the observer stands on the shore, so the tide moves
    // the sea beneath them rather than lifting them with it.
    //
    // Sampled from the terrain grid for a GPS fix, never taken from the
    // satellite's own altitude — that carries ten to twenty metres of error,
    // several times the effect this whole app exists to show.
    return (o.groundElevation ?? sample(terrain, o.lat, o.lon)) + eyeHeight;
  }

  // Deferred so the sensors, which fire at 60 Hz, do not rewrite the readout
  // sixty times a second for no one's benefit.
  let pending = true;
  const requestUpdate = (): void => {
    pending = true;
  };

  function update(): void {
    const o = observerOf();
    const { x, z } = frame.toWorldXZ(o.lat, o.lon);
    uniforms.uObserverXZ.value.set(x, z);

    const radius = eulerRadius(o.lat, bearing);
    uniforms.uInvR.value = flat ? 0 : inverseEffectiveRadius(radius, k);
    uniforms.uWaterLevel.value = waterLevel();

    camera.position.set(0, eyeAboveDatum(), 0);
    // Bearing is clockwise from true north, and north is -z in world axes.
    const cosEl = Math.cos((elevation * Math.PI) / 180);
    const dir = new THREE.Vector3(
      Math.sin((bearing * Math.PI) / 180) * cosEl,
      Math.sin((elevation * Math.PI) / 180),
      -Math.cos((bearing * Math.PI) / 180) * cosEl,
    );

    // Roll the camera's up vector about the view axis, so a phone held at an
    // angle produces a render tilted the same way instead of a level one that
    // cannot be matched to it.
    const up = new THREE.Vector3(0, 1, 0);
    up.addScaledVector(dir, -up.dot(dir));
    if (up.lengthSq() < 1e-12) up.set(0, 0, -1);
    up.normalize().applyAxisAngle(dir, (roll * Math.PI) / 180);
    camera.up.copy(up);
    camera.lookAt(camera.position.clone().add(dir));

    const aspect = canvas.clientWidth / canvas.clientHeight;
    camera.fov = verticalFovDeg(focal, aspect);
    camera.aspect = aspect;
    camera.updateProjectionMatrix();

    matchCameraZoom();
    readout();
  }

  function readout(): void {
    const o = observerOf();
    const t = target();
    const { distance, initialBearing } = geodesicInverse(observerPos(), { lat: t.lat, lon: t.lon });
    const radius = eulerRadius(o.lat, initialBearing);
    const invR = inverseEffectiveRadius(radius, k);
    const eye = eyeAboveDatum();
    const hidden = hiddenHeight(eye, distance, invR);
    const hCrit = criticalObserverHeight(distance, invR);
    const hfov = horizontalFovDeg(focal, canvas.clientWidth / canvas.clientHeight);
    const perPx = arcminPerPixel(hfov, canvas.clientWidth * Math.min(devicePixelRatio, 2));

    const lines = [
      `<b>${o.name}</b> &rarr; ${t.name}`,
      `${(distance / 1000).toFixed(2)} km, bearing ${initialBearing.toFixed(1)}&deg;`,
      // Where the camera is actually pointed, as against where the target is.
      // With the gyro running these two are the whole game: the gap between
      // them is how far the phone still has to turn.
      `looking ${bearing.toFixed(1)}&deg;, elev ${elevation >= 0 ? '+' : ''}${elevation.toFixed(2)}&deg;` +
        (Math.abs(roll) > 0.5 ? `, roll ${roll >= 0 ? '+' : ''}${roll.toFixed(1)}&deg;` : ''),
      `eye ${eye.toFixed(2)} m above datum`,
      `hidden by curvature <b>${hidden.toFixed(2)} m</b>${flat ? ' (flat: 0.00 m)' : ''}`,
      `critical eye height ${hCrit.toFixed(2)} m`,
      tide.length
        ? `tide ${waterLevel() >= 0 ? '+' : ''}${waterLevel().toFixed(2)} m on the datum`
        : 'tide unavailable in this bundle',
      `${hfov.toFixed(2)}&deg; horizontal, ${perPx.toFixed(3)}&prime;/px`,
    ];
    if (stream) {
      lines.push(
        widestMatchable > 0
          ? `<span style="color:var(--warn)">camera cannot go wider than ${Math.round(widestMatchable)} mm</span>`
          : `camera cropped &times;${cropScale.toFixed(2)} to match (${cameraFovSource})`,
      );
    }
    if (gyroOn && lastReading) {
      lines.push(
        `gyro ${lastReading.headingReference}, offset ${gyroOffsetBearing >= 0 ? '+' : ''}${gyroOffsetBearing.toFixed(1)}&deg;`,
      );
    }
    el('readout').innerHTML = lines.join('<br>');
  }

  // --- controls -----------------------------------------------------------
  const obsSel = el<HTMLSelectElement>('observer');
  scene0.observers.forEach((o, i) => obsSel.add(new Option(o.name, String(i))));
  // Never disabled. A greyed-out entry sitting where someone would look for
  // the feature reads as "not supported here", when all it meant was "no fix
  // yet" — so picking it is what asks for one.
  const gpsOption = new Option('My location (GPS)', 'gps');
  obsSel.add(gpsOption);
  obsSel.onchange = () => {
    if (obsSel.value === 'gps') {
      setGpsOn(true);
      return;
    }
    observerIndex = Number(obsSel.value);
    // Choosing a named place means you are not standing where you are, so the
    // watch is released rather than left running behind a button that still
    // says it is on — the receiver costs battery, and a control that lies
    // about its own state is worse than one that is merely inconvenient.
    if (stopGps) {
      setGpsOn(false);
      return;
    }
    useGps = false;
    requestUpdate();
  };

  const tgtSel = el<HTMLSelectElement>('target');
  scene0.targets.forEach((t, i) => tgtSel.add(new Option(t.name, String(i))));
  tgtSel.onchange = () => {
    targetIndex = Number(tgtSel.value);
    aimAtTarget();
  };

  /**
   * Where a target sits in the sky from where the observer stands.
   *
   * Aimed through the same projection the geometry is built in, not through
   * the geodesic bearing. The scene frame sits a near-constant ~5 arcmin off
   * true across this scene, so aiming at the true bearing lands the target
   * about fifty pixels off centre at 600 mm. The readout still reports the
   * geodesic bearing, which is the honest number.
   *
   * Elevation matters as much: the Marin headlands sit about 1.1 degrees above
   * the horizon from the Albany shore, and a 600 mm frame is only 2 degrees
   * tall, so aiming level puts the thing you asked for outside the picture.
   */
  function aimFor(t: { lat: number; lon: number; baseElevation?: number; structureHeight?: number }): Aim {
    const from = observerPos();
    const { distance } = geodesicInverse(from, { lat: t.lat, lon: t.lon });
    const o = frame.toWorldXZ(from.lat, from.lon);
    const w = frame.toWorldXZ(t.lat, t.lon);
    const bearingDeg = ((Math.atan2(w.x - o.x, -(w.z - o.z)) * 180) / Math.PI + 360) % 360;
    const invR = flat ? 0 : inverseEffectiveRadius(eulerRadius(from.lat, bearingDeg), k);
    const mid = (t.baseElevation ?? 0) + (t.structureHeight ?? 0) / 2;
    return {
      bearingDeg,
      elevationDeg: (apparentElevation(eyeAboveDatum(), distance, mid, invR) * 180) / Math.PI,
    };
  }

  /**
   * Point the view somewhere, keeping the gyro consistent with it.
   *
   * With the gyro running the view is the sensor's attitude plus an offset, so
   * moving the view means moving the offset — otherwise the next reading, a
   * sixtieth of a second later, snaps it straight back.
   */
  function setView(b: number, e: number): void {
    bearing = ((b % 360) + 360) % 360;
    elevation = Math.max(-20, Math.min(20, e));
    if (gyroOn && lastReading) {
      gyroOffsetBearing = bearingDelta(lastReading.bearingDeg, bearing);
      gyroOffsetElevation = elevation - lastReading.elevationDeg;
    }
    requestUpdate();
  }

  function aimAtTarget(): void {
    const aim = aimFor(target());
    setView(aim.bearingDeg, aim.elevationDeg);
  }
  el<HTMLButtonElement>('aim').onclick = aimAtTarget;

  const bind = (id: string, onInput: (v: number) => void): HTMLInputElement => {
    const input = el<HTMLInputElement>(id);
    const label = el(`${id}-value`);
    const apply = (): void => {
      onInput(Number(input.value));
      label.textContent = input.value;
      requestUpdate();
    };
    input.oninput = apply;
    apply();
    return input;
  };

  // Local wall-clock in the input, UTC in the maths.
  const whenInput = el<HTMLInputElement>('when');
  const toLocalInput = (d: Date): string => {
    const pad = (n: number): string => String(n).padStart(2, '0');
    return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}` +
      `T${pad(d.getHours())}:${pad(d.getMinutes())}`;
  };
  whenInput.value = toLocalInput(when);
  whenInput.onchange = () => {
    const parsed = new Date(whenInput.value);
    if (!Number.isNaN(parsed.getTime())) {
      when = parsed;
      requestUpdate();
    }
  };

  const focalInput = bind('focal', (v) => { focal = v; });
  bind('k', (v) => { k = v; });
  bind('eye', (v) => { eyeHeight = v; });
  bind('visibility', (v) => { uniforms.uVisibility.value = v * 1000; });
  bind('blend', (v) => { canvas.style.opacity = String(v / 100); });

  const flatToggle = el<HTMLInputElement>('flat');
  flatToggle.onchange = () => {
    flat = flatToggle.checked;
    document.body.classList.toggle('is-flat', flat);
    requestUpdate();
  };

  function setFocal(v: number): void {
    focal = Math.max(Number(focalInput.min), Math.min(Number(focalInput.max), v));
    focalInput.value = String(focal);
    el('focal-value').textContent = focalInput.value;
    requestUpdate();
  }

  // --- panels, camera and display mode -------------------------------------
  const tuckBtn = el<HTMLButtonElement>('tuck');
  const camBtn = el<HTMLButtonElement>('camera');
  const modeBtn = el<HTMLButtonElement>('mode');
  const gpsBtn = el<HTMLButtonElement>('gps');
  const gyroBtn = el<HTMLButtonElement>('gyro');
  const video = el<HTMLVideoElement>('cam');
  const camWrap = el('cam-wrap');
  const stage = el('stage');
  const note = el('cam-note');
  const status = el('bar-status');
  const lensSel = el<HTMLSelectElement>('lens');
  const camFovInput = el<HTMLInputElement>('camfov');

  function say(message: string): void {
    note.className = 'show';
    note.textContent = message;
    // The note lives in the panel, so it is no use while tucked away.
    tucked = false;
    applyTuck();
  }

  // Tucked by default on a small screen: on a phone the panels cover most of
  // the picture, which is the one thing you are there to look at.
  //
  // Both dimensions matter. A phone held landscape — the orientation the split
  // view is for — is wide but only a few hundred pixels tall, so a width-only
  // test leaves the panels covering the whole frame in exactly the case this
  // exists for.
  let tucked = innerWidth < 700 || innerHeight < 560;
  function applyTuck(): void {
    document.body.classList.toggle('tucked', tucked);
    tuckBtn.setAttribute('aria-pressed', String(tucked));
    tuckBtn.title = tucked ? 'Show the panels' : 'Hide the panels';
  }
  tuckBtn.onclick = () => {
    tucked = !tucked;
    applyTuck();
  };
  applyTuck();

  function applyMode(): void {
    document.body.classList.remove('mode-render', 'mode-split', 'mode-blend');
    document.body.classList.add(`mode-${mode}`);
    modeBtn.textContent = mode === 'render' ? 'Split' : mode === 'split' ? 'Blend' : 'Render';
    canvas.style.opacity = mode === 'blend' ? String(Number(el<HTMLInputElement>('blend').value) / 100) : '1';
    resize();
  }
  modeBtn.onclick = () => {
    mode = mode === 'render' ? 'split' : mode === 'split' ? 'blend' : 'render';
    applyMode();
  };

  // --- camera zoom matching -------------------------------------------------
  //
  // The browser will not say what angle the camera frame covers, so the angle
  // is carried here and cropped to. Two crops are in play: `object-fit: cover`
  // filling a wrapper of a different shape, then a magnification to reach the
  // render's field of view. Beyond the lens's own reach the magnification adds
  // no detail — but it is the only way to have both halves of the screen mean
  // the same thing, which matters more.
  const fovKey = (): string =>
    `fe.camfov:${currentLensLabel}@${video.videoWidth}x${video.videoHeight}`;

  function setCameraFov(deg: number, source: string, persist: boolean): void {
    cameraFovDeg = Math.max(1, Math.min(170, deg));
    cameraFovSource = source;
    camFovInput.value = cameraFovDeg.toFixed(1);
    el('camfov-value').textContent = cameraFovDeg.toFixed(1);
    el('camfov-hint').textContent =
      source === 'calibrated'
        ? 'Calibrated on two landmarks.'
        : `Assumed from the lens name (${source}). Calibrate for a real match.`;
    if (persist && video.videoWidth) remember(fovKey(), String(cameraFovDeg));
    requestUpdate();
  }

  camFovInput.oninput = () => setCameraFov(Number(camFovInput.value), 'set by hand', true);

  function matchCameraZoom(): void {
    widestMatchable = 0;
    cropScale = 1;
    if (!stream || !video.videoWidth || !video.videoHeight) {
      video.style.transform = '';
      focalInput.min = String(FOCAL_MIN);
      return;
    }

    const wrapAspect = camWrap.clientWidth / Math.max(1, camWrap.clientHeight);
    const displayed = displayedHorizontalFovDeg(
      cameraFovDeg,
      video.videoWidth / video.videoHeight,
      wrapAspect,
    );

    // The lens's own limit, in the units the focal slider speaks. Below this
    // the camera simply does not see as much as the render draws, and no crop
    // can invent it — so the slider is stopped there rather than quietly
    // showing two different angles side by side.
    const minFocal = focalLength35mmFromHorizontalFov(displayed, wrapAspect);
    focalInput.min = String(Math.ceil(minFocal));
    if (focal < minFocal) {
      widestMatchable = minFocal;
      focal = Math.ceil(minFocal);
      focalInput.value = String(focal);
      el('focal-value').textContent = focalInput.value;
      const aspect = canvas.clientWidth / canvas.clientHeight;
      camera.fov = verticalFovDeg(focal, aspect);
      camera.updateProjectionMatrix();
    }

    const targetFov = horizontalFovDeg(focal, canvas.clientWidth / canvas.clientHeight);
    cropScale = Math.max(1, cropScaleForFov(displayed, targetFov));
    video.style.transform = `scale(${cropScale.toFixed(4)})`;
  }

  async function populateLenses(selected: string): Promise<void> {
    const cameras = await listCameras();
    lensSel.textContent = '';
    for (const c of cameras) {
      lensSel.add(new Option(c.label || `Camera ${lensSel.length + 1}`, c.deviceId));
    }
    lensSel.value = selected;
    lensSel.disabled = cameras.length === 0;
    el('lens-hint').textContent =
      cameras.length > 1
        ? `${cameras.length} cameras. Each lens has its own field of view, so calibrate each one you use.`
        : 'Only one camera is exposed here.';
  }

  async function startStream(deviceId?: string): Promise<void> {
    const opened = await openCamera(deviceId);
    stopCamera(stream);
    stream = opened.stream;
    video.srcObject = stream;
    currentLensLabel = opened.label;
    camBtn.setAttribute('aria-pressed', 'true');
    status.textContent = opened.label || 'camera on';
    note.className = opened.notes.length ? 'show' : '';
    note.textContent = opened.notes.join(' ');

    await populateLenses(opened.deviceId);
    el<HTMLButtonElement>('calibrate-start').disabled = false;

    // Video dimensions are not known until metadata lands, and the stored
    // calibration is keyed on them because the same lens delivers different
    // crops at different capture sizes.
    const applyFov = (): void => {
      const stored = recall(fovKey());
      if (stored !== null && Number.isFinite(Number(stored))) {
        setCameraFov(Number(stored), 'calibrated', false);
      } else {
        const guess = guessHorizontalFovDeg(opened.label);
        setCameraFov(guess.fovDeg, guess.guessedFrom, false);
      }
      requestUpdate();
    };
    if (video.videoWidth) applyFov();
    else video.addEventListener('loadedmetadata', applyFov, { once: true });

    if (mode === 'render') {
      mode = 'split';
      applyMode();
    }
  }

  function stopStream(): void {
    stopCamera(stream);
    stream = null;
    video.srcObject = null;
    video.style.transform = '';
    camBtn.setAttribute('aria-pressed', 'false');
    status.textContent = '';
    el<HTMLButtonElement>('calibrate-start').disabled = true;
    cancelCalibration();
    mode = 'render';
    applyMode();
  }

  camBtn.onclick = async () => {
    if (stream) {
      stopStream();
      return;
    }
    camBtn.disabled = true;
    try {
      await startStream();
    } catch (err) {
      say(
        err instanceof CameraUnavailableError
          ? `${err.message} ${err.remedy}`
          : err instanceof Error
            ? err.message
            : String(err),
      );
      status.textContent = 'camera unavailable';
    } finally {
      camBtn.disabled = false;
    }
  };

  lensSel.onchange = async () => {
    lensSel.disabled = true;
    try {
      await startStream(lensSel.value);
    } catch (err) {
      say(err instanceof CameraUnavailableError ? `${err.message} ${err.remedy}` : String(err));
    } finally {
      lensSel.disabled = false;
    }
  };

  // --- location -------------------------------------------------------------
  //
  // One switch, reachable two ways — the bar button and the observer menu —
  // because the menu is where someone looks for a place to stand and the
  // button is what they find once the panels are tucked away. Both go through
  // here so the two can never disagree about whether the watch is running.
  function setGpsOn(on: boolean): void {
    if (!on) {
      stopGps?.();
      stopGps = null;
      useGps = false;
      gpsFix = null;
      gpsOption.text = 'My location (GPS)';
      gpsBtn.setAttribute('aria-pressed', 'false');
      obsSel.value = String(observerIndex);
      status.textContent = stream ? currentLensLabel : '';
      requestUpdate();
      return;
    }
    if (stopGps) return;

    // Selected straight away, before any fix exists. The render keeps using
    // the last named observer until one arrives — a first fix can take a few
    // seconds outdoors and much longer indoors, and a menu that silently
    // refuses to change looks broken.
    useGps = true;
    obsSel.value = 'gps';
    gpsOption.text = 'My location (waiting for a fix…)';
    gpsBtn.setAttribute('aria-pressed', 'true');
    status.textContent = 'waiting for a fix…';

    stopGps = watchLocation(
      (fix) => {
        gpsFix = fix;
        gpsOption.text = `My location (±${Math.round(fix.accuracyM)} m)`;
        if (!insideBBox(fix, terrain.bbox)) {
          say(
            'You are outside this scene. There is no terrain here, so the render ' +
              'is empty ground at datum zero — build a bundle for this area to use it.',
          );
        }
        status.textContent = `${fix.lat.toFixed(5)}, ${fix.lon.toFixed(5)} ±${Math.round(fix.accuracyM)} m`;
        requestUpdate();
      },
      (err) => {
        setGpsOn(false);
        say(err instanceof GeolocationUnavailableError ? `${err.message} ${err.remedy}` : String(err));
        status.textContent = 'location unavailable';
      },
    );
  }

  gpsBtn.onclick = () => setGpsOn(!stopGps);

  // --- orientation ----------------------------------------------------------
  const gyroReset = el<HTMLButtonElement>('gyro-reset');

  function stopGyroTracking(): void {
    stopGyro?.();
    stopGyro = null;
    gyroOn = false;
    lastReading = null;
    gyroBtn.setAttribute('aria-pressed', 'false');
    gyroReset.hidden = true;
    requestUpdate();
  }

  gyroBtn.onclick = async () => {
    if (gyroOn) {
      stopGyroTracking();
      status.textContent = stream ? currentLensLabel : '';
      return;
    }
    gyroBtn.disabled = true;
    try {
      // Must be awaited straight out of the click: iOS only grants the motion
      // permission from inside a user gesture, and refuses silently otherwise.
      const handle = await startOrientation(
        { declinationDeg: scene0.magneticDeclinationDeg ?? 0 },
        (reading) => {
          if (!gyroOn) {
            // First reading. An absolute reference is worth trusting for the
            // initial snap — that is the whole appeal of pointing the phone —
            // while a relative one would fling the view somewhere arbitrary,
            // so that case keeps whatever was on screen.
            gyroOffsetBearing = reading.headingReference === 'relative'
              ? bearingDelta(reading.bearingDeg, bearing)
              : 0;
            gyroOffsetElevation = reading.headingReference === 'relative'
              ? elevation - reading.elevationDeg
              : 0;
            gyroOn = true;
          }
          lastReading = reading;
          bearing = (((reading.bearingDeg + gyroOffsetBearing) % 360) + 360) % 360;
          elevation = Math.max(-20, Math.min(20, reading.elevationDeg + gyroOffsetElevation));
          roll = reading.rollDeg;
          requestUpdate();
        },
      );
      stopGyro = handle.stop;
      gyroOn = true;
      gyroBtn.setAttribute('aria-pressed', 'true');
      gyroReset.hidden = false;
      el('gyro-hint').textContent = handle.notes.join(' ');
    } catch (err) {
      stopGyroTracking();
      roll = 0;
      say(
        err instanceof OrientationUnavailableError
          ? `${err.message} ${err.remedy}`
          : err instanceof Error
            ? err.message
            : String(err),
      );
    } finally {
      gyroBtn.disabled = false;
    }
  };

  gyroReset.onclick = () => {
    gyroOffsetBearing = 0;
    gyroOffsetElevation = 0;
    requestUpdate();
  };

  // --- look controls: drag to aim, pinch to zoom ----------------------------
  //
  // Both live on the stage rather than the canvas, so a gesture that begins
  // over the camera half still counts — on a phone in split view that is half
  // the screen.
  const pointers = new Map<number, { x: number; y: number }>();
  let pinchDistance = 0;

  const spread = (): number => {
    const [a, b] = [...pointers.values()];
    return a && b ? Math.hypot(a.x - b.x, a.y - b.y) : 0;
  };

  stage.addEventListener('pointerdown', (e) => {
    if (calibration && pointers.size === 0) {
      recordCalibrationTap(e);
      return;
    }
    pointers.set(e.pointerId, { x: e.clientX, y: e.clientY });
    if (pointers.size === 2) pinchDistance = spread();
    try {
      stage.setPointerCapture(e.pointerId);
    } catch {
      // Capture is a convenience — it keeps a drag alive past the element's
      // edge. Browsers throw here for pointers they no longer consider active,
      // and losing the capture is much better than losing the gesture.
    }
  });

  const release = (e: PointerEvent): void => {
    pointers.delete(e.pointerId);
    pinchDistance = pointers.size === 2 ? spread() : 0;
    if (stage.hasPointerCapture(e.pointerId)) stage.releasePointerCapture(e.pointerId);
  };
  stage.addEventListener('pointerup', release);
  stage.addEventListener('pointercancel', release);

  stage.addEventListener('pointermove', (e) => {
    const previous = pointers.get(e.pointerId);
    if (!previous) return;
    pointers.set(e.pointerId, { x: e.clientX, y: e.clientY });

    if (pointers.size >= 2) {
      // Pinch. Focal length is multiplied, not added to: the same finger
      // travel should mean the same proportional change at 24 mm and at
      // 1200 mm, which is how every other camera behaves.
      const now = spread();
      if (pinchDistance > 0 && now > 0) setFocal(focal * (now / pinchDistance));
      pinchDistance = now;
      return;
    }

    // Drag sensitivity follows the field of view: at 600 mm a pixel is worth a
    // fraction of the angle it is worth at 24 mm, and a fixed rate makes long
    // lenses unusable.
    const perPx = horizontalFovDeg(focal, canvas.clientWidth / canvas.clientHeight) / canvas.clientWidth;
    setView(bearing - (e.clientX - previous.x) * perPx, elevation + (e.clientY - previous.y) * perPx);
  });

  // Trackpad and mouse wheel, for the desktop case.
  stage.addEventListener(
    'wheel',
    (e) => {
      e.preventDefault();
      setFocal(focal * Math.exp(-e.deltaY / 400));
    },
    { passive: false },
  );

  // Safari on iOS fires its own pinch gestures at the page even where
  // touch-action should have stopped them, and a page zoom on top of the
  // render's zoom makes the angles meaningless.
  for (const type of ['gesturestart', 'gesturechange', 'gestureend']) {
    stage.addEventListener(type, (e) => e.preventDefault());
  }

  // --- calibration ----------------------------------------------------------
  //
  // The one thing the platform genuinely will not provide. With two landmarks
  // whose true separation the scene already knows, the lens solves for itself:
  // the taps give pixel offsets, the scene gives the angle between the rays,
  // and there is exactly one focal length that reconciles them.
  interface Pick {
    aim: Aim;
    point: { x: number; y: number };
  }
  let calibration: { picks: Pick[] } | null = null;
  const calTargetSel = el<HTMLSelectElement>('cal-target');
  scene0.targets.forEach((t, i) => calTargetSel.add(new Option(t.name, String(i))));

  function calibrationStep(): void {
    if (!calibration) return;
    const n = calibration.picks.length;
    el('calibrate-step').textContent =
      n === 0
        ? 'Pick a landmark, then tap it in the camera image.'
        : 'Now a second landmark, as far from the first as you can.';
  }

  function cancelCalibration(): void {
    calibration = null;
    document.body.classList.remove('calibrating');
  }

  el<HTMLButtonElement>('calibrate-start').onclick = () => {
    if (!stream) return;
    calibration = { picks: [] };
    document.body.classList.add('calibrating');
    // The panel this button lives in covers half the camera image on a phone,
    // and the next thing to do is tap that image. Its own bar stays up.
    tucked = true;
    applyTuck();
    calibrationStep();
  };
  el<HTMLButtonElement>('cal-cancel').onclick = cancelCalibration;

  function recordCalibrationTap(e: PointerEvent): void {
    if (!calibration) return;
    const rect = camWrap.getBoundingClientRect();
    const inside =
      e.clientX >= rect.left && e.clientX <= rect.right &&
      e.clientY >= rect.top && e.clientY <= rect.bottom;
    if (!inside) {
      el('calibrate-step').textContent = 'Tap inside the camera image, not the render.';
      return;
    }
    if (!video.videoWidth) {
      el('calibrate-step').textContent = 'The camera has not delivered a frame yet.';
      return;
    }

    // Undone against the crop in force at this instant, because the user is
    // free to pinch between the two taps.
    const point = elementPointToSourcePixel(
      { x: e.clientX - rect.left, y: e.clientY - rect.top },
      { width: rect.width, height: rect.height },
      { width: video.videoWidth, height: video.videoHeight },
      cropScale,
    );
    calibration.picks.push({ aim: aimFor(scene0.targets[Number(calTargetSel.value)]!), point });

    if (calibration.picks.length < 2) {
      calibrationStep();
      return;
    }

    const [a, b] = calibration.picks as [Pick, Pick];
    try {
      const focalPixels = focalPixelsFromTwoPoints(
        a.point,
        b.point,
        { x: video.videoWidth / 2, y: video.videoHeight / 2 },
        angularSeparation(a.aim, b.aim),
      );
      setCameraFov(horizontalFovFromFocalPixels(focalPixels, video.videoWidth), 'calibrated', true);
      cancelCalibration();
      status.textContent = `calibrated: ${cameraFovDeg.toFixed(1)}° across the frame`;
    } catch (err) {
      calibration = { picks: [] };
      el('calibrate-step').textContent =
        err instanceof CalibrationError ? err.message : 'Calibration failed. Try again.';
    }
  }

  // --- full screen ---------------------------------------------------------
  //
  // Worth its own control: on a phone the browser's own chrome takes a
  // meaningful slice of a view whose whole point is angular fidelity, and the
  // address bar moves as you scroll.
  //
  // iPhone Safari has no Fullscreen API for ordinary elements — only video
  // gets webkitEnterFullscreen — so the button is hidden there rather than
  // left to do nothing, and the route that does work is named instead.
  const fullBtn = el<HTMLButtonElement>('full');

  interface FullscreenCapable extends HTMLElement {
    webkitRequestFullscreen?: () => Promise<void> | void;
  }
  interface FullscreenDoc extends Document {
    webkitFullscreenElement?: Element | null;
    webkitExitFullscreen?: () => Promise<void> | void;
  }
  const doc = document as FullscreenDoc;
  const root = document.documentElement as FullscreenCapable;

  const canFullscreen = Boolean(root.requestFullscreen ?? root.webkitRequestFullscreen);
  const isFullscreen = (): boolean =>
    Boolean(doc.fullscreenElement ?? doc.webkitFullscreenElement);

  if (!canFullscreen) {
    fullBtn.hidden = true;
  } else {
    fullBtn.onclick = async () => {
      try {
        if (isFullscreen()) {
          await (doc.exitFullscreen?.() ?? doc.webkitExitFullscreen?.());
        } else {
          await (root.requestFullscreen?.() ?? root.webkitRequestFullscreen?.());
        }
      } catch {
        // Refusals happen (permissions policy in an embedded frame, for one),
        // and a dead button with no explanation is worse than a note.
        say(
          'Full screen was refused here. If this page is embedded in another site, ' +
            'open it directly instead.',
        );
      }
    };
    for (const ev of ['fullscreenchange', 'webkitfullscreenchange']) {
      document.addEventListener(ev, () => {
        fullBtn.setAttribute('aria-pressed', String(isFullscreen()));
        resize();
      });
    }
  }

  function resize(): void {
    renderer.setSize(canvas.clientWidth, canvas.clientHeight, false);
    update();
  }
  addEventListener('resize', resize);
  // Turning the phone changes both the layout and the screen angle the gyro
  // maths depends on, and the resize event alone can fire before the new
  // orientation is readable.
  screen.orientation?.addEventListener('change', () => requestAnimationFrame(resize));

  el('provenance').textContent =
    // Kept ASCII: the standalone build is emitted as page content, so the host
    // owns <head> and there is no charset declaration we control.
    `${manifest.unverified.length} unverified assumptions in this bundle. ` +
    'This is a picture, not a measurement.';

  if (!canFullscreen && /iPhone|iPod/.test(navigator.userAgent)) {
    say(
      'iPhone Safari has no full-screen control for a page. Use Share then ' +
        '"Add to Home Screen" and launch it from there — it opens without browser chrome.',
    );
  }

  applyMode();
  aimAtTarget();
  resize();
  renderer.setAnimationLoop(() => {
    if (pending) {
      pending = false;
      update();
    }
    renderer.render(scene, camera);
  });
}

main().catch((err: unknown) => {
  el('readout').textContent = `Failed to start: ${err instanceof Error ? err.message : String(err)}`;
});
