/**
 * Headless check of the phone-facing features.
 *
 *   npm run build && npx vite preview --port 4173 &
 *   node scripts/phone-check.mjs
 *
 * Everything here exists because the features it covers are the ones that
 * cannot be tried from a desk: the camera, the satellites, the magnetometer.
 * Chromium's fake media device stands in for a lens, Playwright's geolocation
 * override for a fix, and a dispatched DeviceOrientationEvent for the sensors,
 * so a regression in any of them shows up without going to the shore.
 *
 * The zoom match is checked numerically rather than by eye, because "looks
 * about right" is exactly the failure this feature exists to eliminate: the
 * angle the camera shows after cropping must equal the angle the render draws,
 * and a factor of 1.1 between them is invisible and ruins the comparison.
 *
 * CHROMIUM_PATH overrides the browser binary.
 */

import { chromium, devices } from 'playwright';
import { mkdir } from 'node:fs/promises';

const URL_BASE = process.env.APP_URL ?? 'http://localhost:4173/';
const OUT = process.env.OUT_DIR ?? 'shots';
await mkdir(OUT, { recursive: true });

/**
 * Capture evidence, and never fail the run over it.
 *
 * A screenshot needs a frame out of the compositor, and on a GPU-less runner
 * drawing a WebGL scene beside a playing video that can take a while — the
 * 30-second default has timed out on a commit that passed minutes earlier.
 * These images are evidence, not assertions; the checks above them are what
 * decides whether the build is good, so a slow capture is a warning.
 */
const snap = async (name) => {
  try {
    await page.screenshot({ path: `${OUT}/${name}.png`, timeout: 120_000 });
  } catch (err) {
    console.log(`  note   ${name}.png not captured: ${err.message.split('\n')[0]}`);
  }
};
const problems = [];
const check = (name, ok, detail = '') => {
  console.log(`${ok ? '  ok  ' : ' FAIL '} ${name}${detail ? `  ${detail}` : ''}`);
  if (!ok) problems.push(name);
};

const browser = await chromium.launch({
  args: [
    '--use-gl=angle',
    '--use-angle=swiftshader',
    '--enable-unsafe-swiftshader',
    // A synthetic camera, so getUserMedia resolves with a real MediaStream.
    '--use-fake-device-for-media-stream',
    '--use-fake-ui-for-media-stream',
  ],
  ...(process.env.CHROMIUM_PATH ? { executablePath: process.env.CHROMIUM_PATH } : {}),
});

// A phone held landscape: the orientation the split view exists for, and the
// one where the panels and the bar are tightest.
const context = await browser.newContext({
  ...devices['iPhone 13'],
  isMobile: true,
  hasTouch: true,
  viewport: { width: 844, height: 390 },
  permissions: ['camera', 'geolocation'],
  geolocation: { latitude: 37.8896, longitude: -122.3106, accuracy: 8 },
});

const page = await context.newPage();
const errors = [];
page.on('console', (m) => {
  if (m.type() !== 'error') return;
  errors.push(m.text());
  console.error('  [console error]', m.text());
});
page.on('pageerror', (e) => {
  errors.push(String(e));
  console.error('  [page error]', String(e));
});

await page.goto(URL_BASE, { waitUntil: 'networkidle' });
await page.waitForTimeout(5000);

// --- the panels start out of the way on a phone ---------------------------
check('panels tucked on a landscape phone', await page.evaluate(() => document.body.classList.contains('tucked')));

/**
 * Range inputs are set through the DOM, not through Playwright's `fill`: the
 * focal slider's minimum moves with the attached lens, and `fill` refuses any
 * value outside the bounds of the moment rather than letting the app clamp it,
 * which is the behaviour under test.
 */
const setFocal = async (mm) => {
  await page.evaluate((mm) => {
    const input = document.getElementById('focal');
    input.value = String(mm);
    input.dispatchEvent(new Event('input', { bubbles: true }));
  }, mm);
  await settle();
};

/**
 * Wait for the app to actually redraw.
 *
 * The app defers its work to the render loop rather than doing it inline on
 * every slider event, and this runner has no GPU — SwiftShader manages a few
 * frames a second. A fixed delay therefore reads the previous frame about half
 * the time, which looks exactly like a broken zoom match.
 */
const settle = () =>
  page.evaluate(
    () => new Promise((r) => requestAnimationFrame(() => requestAnimationFrame(() => r(null)))),
  );

/** Buttons inside the controls panel are off-screen while it is tucked. */
const untuck = async () => {
  if (await page.evaluate(() => document.body.classList.contains('tucked'))) {
    await page.click('#tuck');
  }
};

// --- camera ---------------------------------------------------------------
// Deliberately at the wide end first, so the clamp to the lens's own limit is
// exercised by turning the camera on rather than only by moving the slider.
await setFocal(16);
await page.click('#camera');

// Waited for, not slept through: opening a camera takes as long as it takes,
// and a fixed delay turns a slow machine into a false failure.
let cameraUp = true;
try {
  await page.waitForFunction(
    () => document.getElementById('cam').videoWidth > 0 &&
      document.getElementById('camera').getAttribute('aria-pressed') === 'true',
    null,
    { timeout: 20_000 },
  );
} catch {
  cameraUp = false;
}
await page.waitForTimeout(300);

check(
  'camera reports on',
  cameraUp,
  (await page.textContent('#cam-note')) || (await page.textContent('#bar-status')),
);
check('split mode engaged', await page.evaluate(() => document.body.classList.contains('mode-split')));

const lenses = await page.evaluate(() => {
  const sel = document.getElementById('lens');
  return { count: sel.options.length, disabled: sel.disabled, first: sel.options[0]?.text ?? '' };
});
check('lens dropdown populated', lenses.count >= 1 && !lenses.disabled, JSON.stringify(lenses));

/**
 * The heart of it: after cropping, does the camera half subtend the same angle
 * as the render half? Recomputed here from the DOM rather than from the app's
 * own variables, so a bug in the app's arithmetic cannot hide inside its own
 * answer.
 */
async function fovAgreement() {
  return page.evaluate(() => {
    const video = document.getElementById('cam');
    const wrap = document.getElementById('cam-wrap');
    const canvas = document.getElementById('view');
    const camFov = Number(document.getElementById('camfov').value);
    const focal = Number(document.getElementById('focal').value);

    const scale = Number(/scale\(([\d.]+)\)/.exec(video.style.transform)?.[1] ?? 1);
    const videoAspect = video.videoWidth / video.videoHeight;
    const wrapAspect = wrap.clientWidth / wrap.clientHeight;

    // Cover crop, then the digital zoom, both in the tangent plane.
    const fraction = wrapAspect < videoAspect ? wrapAspect / videoAspect : 1;
    const shownHalfTan = (Math.tan((camFov * Math.PI) / 360) * fraction) / scale;
    const cameraFov = (2 * Math.atan(shownHalfTan) * 180) / Math.PI;

    // The render's horizontal field of view, from 35 mm equivalence.
    const canvasAspect = canvas.clientWidth / canvas.clientHeight;
    const diagonal = Math.hypot(36, 24);
    const width = (diagonal / Math.hypot(1, canvasAspect)) * canvasAspect;
    const renderFov = (2 * Math.atan(width / (2 * focal)) * 180) / Math.PI;

    const appFov = Number(/([\d.]+)° horizontal/.exec(document.getElementById('readout').textContent)?.[1]);
    return { cameraFov, renderFov, scale, focal, camFov, appFov, videoW: video.videoWidth };
  });
}

// Wider than the lens can see: there is nothing to crop, so the render must be
// pulled back to the lens's limit rather than showing two different angles
// side by side. This is the state left over from setting 16 mm above.
const clamped = await page.evaluate(() => ({
  min: Number(document.getElementById('focal').min),
  value: Number(document.getElementById('focal').value),
}));
check(
  'focal stops at the lens limit',
  clamped.min > 16 && clamped.value >= clamped.min,
  JSON.stringify(clamped),
);
const wide = await fovAgreement();
check(
  'still agrees at the widest matchable focal',
  Math.abs(wide.cameraFov - wide.renderFov) < 0.05,
  `${wide.cameraFov.toFixed(2)}° vs ${wide.renderFov.toFixed(2)}°`,
);

await snap('phone-split');

for (const focal of [300, 600, 1200]) {
  await setFocal(focal);
  const a = await fovAgreement();
  check(
    `camera and render agree at ${focal} mm`,
    Math.abs(a.cameraFov - a.renderFov) < 0.02,
    `camera ${a.cameraFov.toFixed(3)}° vs render ${a.renderFov.toFixed(3)}° (app says ${a.appFov}°), crop x${a.scale.toFixed(2)}`,
  );
}

await setFocal(400);

// --- pinch to zoom --------------------------------------------------------
const focalBefore = await page.evaluate(() => Number(document.getElementById('focal').value));
await page.evaluate(() => {
  const stage = document.getElementById('stage');
  const send = (type, id, x, y) =>
    stage.dispatchEvent(
      new PointerEvent(type, {
        pointerId: id,
        clientX: x,
        clientY: y,
        bubbles: true,
        pointerType: 'touch',
      }),
    );
  send('pointerdown', 1, 300, 200);
  send('pointerdown', 2, 500, 200);
  // Fingers apart by a factor of two.
  send('pointermove', 2, 700, 200);
  send('pointerup', 1, 300, 200);
  send('pointerup', 2, 700, 200);
});
await settle();
const focalAfter = await page.evaluate(() => Number(document.getElementById('focal').value));
check(
  'pinch outwards lengthens the lens',
  focalAfter > focalBefore * 1.5,
  `${focalBefore} mm -> ${focalAfter} mm`,
);

// A pinch must not also drag the view sideways.
const bearingBefore = await page.textContent('#readout');
await page.evaluate(() => {
  const stage = document.getElementById('stage');
  const send = (type, id, x, y) =>
    stage.dispatchEvent(
      new PointerEvent(type, { pointerId: id, clientX: x, clientY: y, bubbles: true, pointerType: 'touch' }),
    );
  send('pointerdown', 3, 400, 200);
  send('pointerdown', 4, 500, 200);
  send('pointermove', 4, 460, 200);
  send('pointerup', 3, 400, 200);
  send('pointerup', 4, 460, 200);
});
await settle();
check(
  'pinch inwards shortens the lens',
  (await page.evaluate(() => Number(document.getElementById('focal').value))) < focalAfter,
);
check('pinch did not move the aim', /looking (\d+\.\d)/.exec(bearingBefore)?.[1] ===
  /looking (\d+\.\d)/.exec(await page.textContent('#readout'))?.[1]);

// --- calibration ----------------------------------------------------------
await untuck();
await page.click('#calibrate-start');
check('calibration mode entered', await page.evaluate(() => document.body.classList.contains('calibrating')));
check(
  'calibration hides the panel covering the image',
  await page.evaluate(() => document.body.classList.contains('tucked')),
);
await snap('phone-calibrating');

const tapCamera = (fx, fy) =>
  page.evaluate(
    ([fx, fy]) => {
      const wrap = document.getElementById('cam-wrap').getBoundingClientRect();
      document.getElementById('stage').dispatchEvent(
        new PointerEvent('pointerdown', {
          pointerId: 9,
          clientX: wrap.left + wrap.width * fx,
          clientY: wrap.top + wrap.height * fy,
          bubbles: true,
          pointerType: 'touch',
        }),
      );
    },
    [fx, fy],
  );

// Same landmark twice: no angular separation, so no lens fits and the app has
// to say so rather than divide by zero and produce a number.
await tapCamera(0.2, 0.5);
await tapCamera(0.8, 0.5);
await settle();
check(
  'same landmark twice is refused with a reason',
  /same direction|further apart/i.test(await page.textContent('#calibrate-step')),
  (await page.textContent('#calibrate-step')).slice(0, 60),
);

// Two different landmarks, tapped well apart.
const fovBefore = await page.evaluate(() => Number(document.getElementById('camfov').value));
await page.selectOption('#cal-target', { index: 0 });
await tapCamera(0.15, 0.5);
await page.selectOption('#cal-target', { index: 1 });
await tapCamera(0.85, 0.5);
await settle();

const afterCal = await page.evaluate(() => ({
  calibrating: document.body.classList.contains('calibrating'),
  fov: Number(document.getElementById('camfov').value),
  hint: document.getElementById('camfov-hint').textContent,
  stored: Object.keys(localStorage).filter((k) => k.startsWith('fe.camfov:')).length,
}));
check('calibration completes and leaves the mode', !afterCal.calibrating);
check('calibration changed the field of view', afterCal.fov !== fovBefore, `${fovBefore}° -> ${afterCal.fov}°`);
check('calibration is recorded as such', /Calibrated/.test(afterCal.hint), afterCal.hint);
check('calibration persists for next time', afterCal.stored >= 1);
check(
  'camera still matches the render after calibrating',
  await fovAgreement().then((a) => Math.abs(a.cameraFov - a.renderFov) < 0.05),
);

// --- location -------------------------------------------------------------
await page.click('#gps');
await page.waitForFunction(
  () => document.getElementById('observer').value === 'gps',
  null,
  { timeout: 15_000 },
).catch(() => {});
await settle();
const gps = await page.evaluate(() => ({
  pressed: document.getElementById('gps').getAttribute('aria-pressed'),
  observer: document.getElementById('observer').value,
  readout: document.getElementById('readout').textContent,
  status: document.getElementById('bar-status').textContent,
}));
check('gps engaged', gps.pressed === 'true');
check('observer switched to the fix', gps.observer === 'gps', gps.status);
check('readout names the fix and its accuracy', /My location \(±\d+ m\)/.test(gps.readout));
check(
  'eye height comes from the terrain, not the satellite',
  /eye \d+\.\d\d m above datum/.test(gps.readout),
  /eye [^→]*/.exec(gps.readout)?.[0]?.slice(0, 24) ?? '',
);

await page.click('#gps');
await settle();
check('gps releases back to a named observer', (await page.inputValue('#observer')) !== 'gps');

// --- orientation ----------------------------------------------------------
check(
  'chromium exposes the absolute orientation event',
  await page.evaluate(() => 'ondeviceorientationabsolute' in window),
);

const feed = async (alpha, beta, gamma) =>
  page.evaluate(
    ([alpha, beta, gamma]) => {
      window.dispatchEvent(
        new DeviceOrientationEvent('deviceorientationabsolute', {
          alpha,
          beta,
          gamma,
          absolute: true,
        }),
      );
    },
    [alpha, beta, gamma],
  );

// The click resolves as soon as the handler starts; the handler then waits up
// to two seconds for a first reading, so the events have to keep coming while
// it does.
await untuck();
await page.click('#gyro');
for (let i = 0; i < 15; i++) {
  await feed(0, 90, 0);
  await page.waitForTimeout(60);
}
await settle();

check(
  'gyro engaged',
  (await page.getAttribute('#gyro', 'aria-pressed')) === 'true',
  await page.textContent('#cam-note'),
);

// Alpha zero, phone upright: looking north. The scene's declination is added
// because Chrome reports alpha against magnetic north.
const declination = await page.evaluate(async () => {
  const res = await fetch('bay-area/manifest.json');
  return (await res.json()).scene.magneticDeclinationDeg ?? 0;
});
check('scene carries a declination', declination > 0, `${declination}°`);
const readNorth = await page.textContent('#readout');
check(
  'heading follows the sensor, with declination applied',
  Math.abs(Number(/looking (\d+\.\d)/.exec(readNorth)?.[1]) - declination) < 0.6,
  `looking ${/looking (\d+\.\d)/.exec(readNorth)?.[1]}°, declination ${declination}°`,
);

// Turning the phone must turn the view the other way round the compass.
await feed(90, 90, 0);
await settle();
const readWest = Number(/looking (\d+\.\d)/.exec(await page.textContent('#readout'))?.[1]);
check(
  'alpha 90 points the camera west',
  Math.abs(readWest - ((270 + declination) % 360)) < 0.6,
  `looking ${readWest}°`,
);

// Tilting up must raise the view, and the readout must say the reference.
await feed(90, 100, 0);
await settle();
check('gyro reference reported', /gyro magnetic/.test(await page.textContent('#readout')));

// A drag while tracking moves the offset, not just the view — otherwise the
// next reading a sixtieth of a second later snaps it straight back.
await page.evaluate(() => {
  const stage = document.getElementById('stage');
  const send = (type, x) =>
    stage.dispatchEvent(
      new PointerEvent(type, { pointerId: 7, clientX: x, clientY: 200, bubbles: true, pointerType: 'touch' }),
    );
  send('pointerdown', 400);
  send('pointermove', 300);
  send('pointerup', 300);
});
await settle();
const draggedTo = Number(/looking (\d+\.\d)/.exec(await page.textContent('#readout'))?.[1]);
await feed(90, 100, 0);
await settle();
const afterNextReading = Number(/looking (\d+\.\d)/.exec(await page.textContent('#readout'))?.[1]);
check(
  'a drag survives the next sensor reading',
  Math.abs(draggedTo - afterNextReading) < 0.05,
  `${draggedTo}° then ${afterNextReading}°`,
);
check('offset is shown', /offset [+-]\d/.test(await page.textContent('#readout')));

await page.click('#gyro');
await settle();
check('gyro can be turned off', (await page.getAttribute('#gyro', 'aria-pressed')) === 'false');

const stillMoves = await page.evaluate(() => {
  const before = document.getElementById('readout').textContent;
  window.dispatchEvent(
    new DeviceOrientationEvent('deviceorientationabsolute', { alpha: 200, beta: 90, gamma: 0, absolute: true }),
  );
  return before;
});
await settle();
check(
  'the sensor is ignored once switched off',
  /looking (\d+\.\d)/.exec(stillMoves)?.[1] ===
    /looking (\d+\.\d)/.exec(await page.textContent('#readout'))?.[1],
);

// --- teardown -------------------------------------------------------------
await page.click('#camera');
await settle();
check(
  'turning the camera off clears the crop',
  await page.evaluate(() => !document.getElementById('cam').style.transform),
);

if (errors.length) {
  console.error('\nconsole errors:', errors.slice(0, 5));
  problems.push('console errors');
}

await browser.close();

console.log(problems.length ? `\n${problems.length} failed: ${problems.join(', ')}` : '\nall checks passed');
process.exitCode = problems.length ? 1 : 0;
