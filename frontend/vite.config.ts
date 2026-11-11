// Vite config (§11.3). The /api proxy target defaults to the local php -S backend on 8080 and can be
// changed with the env var VITE_API_TARGET (for example to run a second backend on another port).
import { defineConfig, loadEnv } from 'vite';
import react from '@vitejs/plugin-react';
import { VitePWA } from 'vite-plugin-pwa';

export default defineConfig(({ mode }) => {
  const env = loadEnv(mode, process.cwd(), 'VITE_');
  const apiTarget = process.env.VITE_API_TARGET || env.VITE_API_TARGET || 'http://127.0.0.1:8080';
  return {
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
