/**
 * Build a single self-contained HTML file with the scene embedded.
 *
 *   npm run build:standalone           # -> dist-standalone/flat-earth.html
 *
 * Everything — script, terrain grid, buildings — is inlined, so the page needs
 * no network at all. That is what makes it work under a strict
 * content-security policy, on a phone with no signal at the water's edge, and
 * as one file you can hand to someone.
 *
 * Emitted as page content only — no doctype, html, head or body wrapper — so
 * it can be published directly as a hosted artifact.
 */

import { readFile, writeFile, mkdir, readdir } from 'node:fs/promises';
import { join } from 'node:path';

const DIST = 'dist';
const OUT_DIR = process.env.OUT_DIR ?? 'dist-standalone';
const BUNDLE = process.env.BUNDLE ?? 'bay-area';

const html = await readFile(join(DIST, 'index.html'), 'utf8');

const assets = await readdir(join(DIST, 'assets'));
const jsName = assets.find((f) => f.endsWith('.js'));
if (!jsName) throw new Error('no built JS found in dist/assets — run `npm run build` first');
const js = await readFile(join(DIST, 'assets', jsName), 'utf8');

const manifest = await readFile(join(DIST, BUNDLE, 'manifest.json'), 'utf8');
const parsed = JSON.parse(manifest);
const terrain = await readFile(join(DIST, BUNDLE, parsed.terrain.file));
const buildings = await readFile(join(DIST, BUNDLE, parsed.buildings.file), 'utf8');
const tide = parsed.tide
  ? await readFile(join(DIST, BUNDLE, parsed.tide.file), 'utf8')
  : '[]';

// The entry is already bare page content, and Vite passes it through without
// adding a doctype or a body element, so nothing may assume those exist —
// looking for <body> and missing it would silently produce a broken page.
const styleMatch = html.match(/<style>[\s\S]*?<\/style>/);
if (!styleMatch) throw new Error('no <style> block found in the built HTML');
const head = styleMatch[0];

const body = html
  .replace(styleMatch[0], '')
  .replace(/<script[^>]*src="[^"]*"[^>]*><\/script>/g, '')
  .replace(/<title>[\s\S]*?<\/title>/g, '')
  .replace(/<link[^>]*>/g, '')
  .replace(/<\/?(?:!doctype|html|head|body)[^>]*>/gi, '')
  .trim();

if (!body.includes('id="view"')) {
  throw new Error('extracted body is missing the canvas — the extraction is wrong');
}

const title = 'Bay Trail Horizon';

// JSON inside a script tag must not be able to close it early.
const safe = (s) => s.replace(/<\//g, '<\\/');

const out = `<title>${title}</title>
${head}
${body}

<script type="application/json" id="embedded-manifest">${safe(manifest)}</script>
<script type="application/json" id="embedded-buildings">${safe(buildings)}</script>
<script type="application/json" id="embedded-tide">${safe(tide)}</script>
<script type="text/plain" id="embedded-terrain">${terrain.toString('base64')}</script>
<script type="module">
${js}
</script>
`;

await mkdir(OUT_DIR, { recursive: true });
const path = join(OUT_DIR, 'flat-earth.html');
await writeFile(path, out);

const mb = (n) => `${(n / 1024 / 1024).toFixed(2)} MB`;
console.log(`${path}  ${mb(Buffer.byteLength(out))}`);
console.log(`  script    ${mb(js.length)}`);
console.log(`  terrain   ${mb(terrain.length)} raw -> ${mb((terrain.length * 4) / 3)} base64`);
console.log(`  buildings ${mb(buildings.length)} (${JSON.parse(buildings).length} features)`);
console.log(`  tide      ${mb(tide.length)} (${JSON.parse(tide).length} stations)`);
