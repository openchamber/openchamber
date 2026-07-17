import { fileURLToPath } from 'node:url';
import { defineConfig } from 'vitest/config';

export default defineConfig({
  resolve: {
    alias: {
      '@': fileURLToPath(new URL('../ui/src', import.meta.url)),
      'bun:test': fileURLToPath(new URL('./test/bun-test-shim.ts', import.meta.url)),
    },
  },
});
