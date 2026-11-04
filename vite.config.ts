import { defineConfig } from 'vite';

export default defineConfig({
  // Local dev/preview works at /; Pages builds set VITE_BASE_PATH=/mini-metro-web/.
  base: process.env.VITE_BASE_PATH ?? './',
  build: { target: 'es2022', rollupOptions: { output: { manualChunks: { three: ['three'] } } } },
});
