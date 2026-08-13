import { defineConfig } from 'vite';
import { resolve } from 'node:path';

/**
 * The app lives in src/app; scene bundles are served from the repo's bundles/
 * directory as static assets, so a built scene appears at /<sceneId>/… without
 * a copy step. Run `npm run build:scene` before `npm run dev`.
 */
export default defineConfig({
  // GitHub Pages serves a project site from /<repo>/, not the web root. The
  // app resolves bundle URLs through import.meta.env.BASE_URL so the same
  // build works at either.
  base: process.env.PAGES_BASE ?? '/',
  root: resolve(import.meta.dirname, 'src/app'),
  publicDir: resolve(import.meta.dirname, 'bundles'),
  build: {
    outDir: resolve(import.meta.dirname, 'dist'),
    emptyOutDir: true,
  },
  server: {
    // Needed on a phone: the dev server has to be reachable from the LAN or a
    // tunnel. Note that camera, geolocation and orientation all require a
    // secure context, so a plain http:// LAN address will not grant them —
    // front the dev server with an HTTPS tunnel when testing on a handset.
    host: true,
  },
});
