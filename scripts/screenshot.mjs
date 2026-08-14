/**
 * Headless render check.
 *
 *   npm run build && npx vite preview --port 4173 &
 *   node scripts/screenshot.mjs
 *
 * Drives the app through a few observer/target/lens combinations and writes
 * PNGs, so a renderer regression is visible without a GPU or a human. The
 * flat/round pair at 600 mm is the one worth looking at: the flat model should
 * expose terrain that curvature hides.
 *
 * CHROMIUM_PATH overrides the browser binary, which some sandboxes need
 * because their preinstalled Chromium does not match the playwright package's
 * expected build.
 */

import { chromium } from 'playwright';
import { mkdir } from 'node:fs/promises';

const OUT = process.env.OUT_DIR ?? 'shots';
const URL_BASE = process.env.APP_URL ?? 'http://localhost:4173/';

await mkdir(OUT, { recursive: true });

const launch = {
  // SwiftShader: these runners have no GPU.
  args: ['--use-gl=angle', '--use-angle=swiftshader', '--enable-unsafe-swiftshader'],
  ...(process.env.CHROMIUM_PATH ? { executablePath: process.env.CHROMIUM_PATH } : {}),
};

const browser = await chromium.launch(launch);
const page = await browser.newPage({ viewport: { width: 1280, height: 720 } });

const errors = [];
page.on('console', (m) => {
  if (m.type() === 'error') errors.push(m.text());
});
page.on('pageerror', (e) => errors.push(String(e)));

await page.goto(URL_BASE, { waitUntil: 'networkidle' });
await page.waitForTimeout(6000);

async function setup({ observer, target, focal, flat, eye }) {
  await page.selectOption('#observer', { label: observer });
  await page.selectOption('#target', { label: target });
  await page.click('#aim');
  for (const [id, value] of [['focal', focal], ['eye', eye]]) {
    await page.fill(`#${id}`, String(value));
    await page.dispatchEvent(`#${id}`, 'input');
  }
  if ((await page.isChecked('#flat')) !== flat) await page.click('#flat');
  await page.click('#aim');
  await page.waitForTimeout(1200);
}

const OBSERVER = 'Albany Beach';
const TARGET = 'Golden Gate Bridge, south tower';

const cases = [
  { name: 'round-600mm', flat: false, focal: 600, eye: 1.6 },
  { name: 'flat-600mm', flat: true, focal: 600, eye: 1.6 },
  { name: 'round-50mm', flat: false, focal: 50, eye: 1.6 },
  { name: 'round-600mm-eye20', flat: false, focal: 600, eye: 20 },
];

for (const c of cases) {
  await setup({ observer: OBSERVER, target: TARGET, ...c });
  // Generous: these runners have no GPU, and a frame out of SwiftShader can
  // take far longer than the 30-second default allows.
  await page.screenshot({ path: `${OUT}/${c.name}.png`, timeout: 120_000 });
  const readout = (await page.textContent('#readout')).replace(/\s+/g, ' ');
  console.log(`${c.name.padEnd(20)} ${readout}`);
}

if (errors.length) {
  console.error('\nconsole errors:', errors.slice(0, 5));
  process.exitCode = 1;
} else {
  console.log('\nno console errors');
}

await browser.close();
