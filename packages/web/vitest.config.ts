import path from 'node:path';
import { availableParallelism } from 'node:os';
import { fileURLToPath } from 'node:url';
import { configDefaults, defineConfig } from 'vitest/config';

const here = path.dirname(fileURLToPath(import.meta.url));
const maxWorkers = Math.max(1, Math.min(4, availableParallelism() - 1));

export default defineConfig({
  resolve: {
    alias: [
      { find: 'bun:test', replacement: path.resolve(here, './test/bun-test-shim.ts') },
      { find: '@openchamber/sdk/schemas', replacement: path.resolve(here, '../sdk/src/schemas.ts') },
      { find: '@openchamber/sdk/ui', replacement: path.resolve(here, '../sdk/src/ui/index.ts') },
      { find: '@openchamber/sdk', replacement: path.resolve(here, '../sdk/src/index.ts') },
      { find: '@openchamber/ui', replacement: path.resolve(here, '../ui/src') },
      { find: '@web', replacement: path.resolve(here, './src') },
      { find: /^@\//, replacement: `${path.resolve(here, '../ui/src')}/` },
    ],
  },
  test: {
    maxWorkers,
    include: [...configDefaults.include, '../ui/src/**/*.vitest.tsx'],
    exclude: [...configDefaults.exclude, 'opencode-server/**/*.test.mjs'],
    testTimeout: 30_000,
    hookTimeout: 30_000,
    setupFiles: ['./test/isolated-data-dir.ts', './test/loopback-supertest.js'],
    env: {
      OPENCHAMBER_ENTERPRISE_MODE: '',
      OPENCHAMBER_RELAY_URL: '',
      OPENCHAMBER_JEV_URL: '',
      OPENCHAMBER_JEV_MODEL: '',
      OPENCHAMBER_JEV_API_KEY: '',
      OPENCODE_DISABLE_CLAUDE_CODE: '',
      OPENCODE_DISABLE_CLAUDE_CODE_SKILLS: '',
    },
  },
});
