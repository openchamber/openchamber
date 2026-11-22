import path from 'node:path';
import { availableParallelism, tmpdir } from 'node:os';
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
    testTimeout: 30_000,
    hookTimeout: 30_000,
    setupFiles: ['./test/isolated-data-dir.ts', './test/loopback-supertest.js'],
    env: {
      // React chooses its build from NODE_ENV; a production value from the shell drops act().
      NODE_ENV: 'test',
      OPENCHAMBER_ENTERPRISE_MODE: '',
      OPENCHAMBER_RELAY_URL: '',
      // shared.js resolves the global OpenCode config directory from
      // OPENCODE_CONFIG_DIR when the module loads and prefers it over
      // XDG_CONFIG_HOME. A value exported by the developer's shell would
      // point suites that never set it at the real global config, so it
      // starts blank here; tests that need a directory set their own.
      OPENCODE_CONFIG_DIR: '',
      OPENCHAMBER_JEV_URL: '',
      OPENCHAMBER_JEV_MODEL: '',
      OPENCHAMBER_JEV_API_KEY: '',
      // The managed-process registry defaults to ~/.config/openchamber/managed-opencode,
      // keyed to the home folder rather than a data dir, so suites that start a
      // lifecycle without their own override wrote fixture pids (45678,
      // 2147483646) into the developer's real registry, where a running
      // OpenChamber reads them. Tests that need a registry set their own.
      OPENCHAMBER_MANAGED_PROCESS_REGISTRY: path.join(tmpdir(), `openchamber-test-managed-registry-${process.pid}`),
      OPENCODE_DISABLE_CLAUDE_CODE: '',
      OPENCODE_DISABLE_CLAUDE_CODE_SKILLS: '',
      OPENCODE_DISABLE_EXTERNAL_SKILLS: '',
    },
  },
});
