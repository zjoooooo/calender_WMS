// Vite config (§11.3). The /api proxy target defaults to the local php -S backend on 8080 and can be
// changed with the env var VITE_API_TARGET (for example to run a second backend on another port).
//
// `vite build --mode demo` (npm run build:demo) is the calendar demo for GitHub Pages instead (§11.5):
// relative URLs (base './', it runs from any sub-path), no PWA or service worker, output in dist-demo/, and
// __WMS_DEMO__ = true, which swaps in the in-browser backend (src/demo, php-wasm). Every other mode builds
// with __WMS_DEMO__ = false, so the normal build contains none of it. Vite's dependency scan (the dev
// server's pre-bundling) does not apply `define` by itself, so it gets the same value: otherwise it follows
// the demo-only import in src/main.tsx to a module only the demo plugin provides, and fails.
import { defineConfig, loadEnv } from 'vite';
import react from '@vitejs/plugin-react';
import { VitePWA } from 'vite-plugin-pwa';
import { wmsDemo } from './vite.demo';

export default defineConfig(({ mode }) => {
  const env = loadEnv(mode, process.cwd(), 'VITE_');
  const apiTarget = process.env.VITE_API_TARGET || env.VITE_API_TARGET || 'http://127.0.0.1:8080';
  const demo = mode === 'demo';
  const define = { __WMS_DEMO__: String(demo) };
  if (demo) {
    return {
      base: './',
      define,
      plugins: [react(), wmsDemo(process.env.WMS_DEMO_DATA || 'demo-data')],
      // php-wasm's PHP build imports its .wasm next to itself: not pre-bundled (vite --mode demo).
      optimizeDeps: { exclude: ['@php-wasm/web-8-3'], esbuildOptions: { define } },
      server: { host: '0.0.0.0', port: 5173 },
      build: { outDir: 'dist-demo', emptyOutDir: true },
    };
  }
  return {
    define,
    optimizeDeps: { esbuildOptions: { define } },
    plugins: [
      react(),
      VitePWA({
        registerType: 'autoUpdate',
        includeAssets: ['icons/icon.svg'],
        manifest: {
          name: 'WMS Driver',
          short_name: 'WMS',
          description: 'WMS route & task calendar',
          start_url: '/driver',
          scope: '/',
          display: 'standalone',
          background_color: '#F5F6F8',
          theme_color: '#18202B',
          icons: [
            { src: '/icons/icon-192.png', sizes: '192x192', type: 'image/png' },
            { src: '/icons/icon-512.png', sizes: '512x512', type: 'image/png' },
            { src: '/icons/icon-512.png', sizes: '512x512', type: 'image/png', purpose: 'maskable' },
          ],
        },
        workbox: {
          navigateFallback: '/index.html',
          navigateFallbackDenylist: [/^\/api\//],
        },
      }),
    ],
    server: {
      host: '0.0.0.0',
      port: 5173,
      proxy: { '/api': apiTarget },
    },
    build: {
      outDir: '../backend/public/app',
      emptyOutDir: true,
    },
  };
});
