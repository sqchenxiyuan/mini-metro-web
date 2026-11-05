import { defineConfig } from 'vite';
import { fileURLToPath } from 'node:url';

export default defineConfig({
  // Local dev/preview works at /; Pages builds set VITE_BASE_PATH=/mini-metro-web/.
  base: process.env.VITE_BASE_PATH ?? './',
  build: {
    target: 'es2022',
    rollupOptions: {
      input: {
        main: fileURLToPath(new URL('./index.html', import.meta.url)),
        integration: fileURLToPath(new URL('./integration.html', import.meta.url)),
      },
      output: { manualChunks: { three: ['three'] } },
    },
  },
});
