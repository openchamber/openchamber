import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { defineConfig } from 'vitest/config';

const here = path.dirname(fileURLToPath(import.meta.url));

export default defineConfig({
  resolve: {
    alias: [
      { find: 'bun:test', replacement: path.resolve(here, './test/bun-test-shim.ts') },
      // The same shared-UI aliases the app build uses. Without them a test can
      // reference `@openchamber/ui/...` in a mock factory but not resolve the
      // real module behind it, which is what forced mocks to hand-copy export
      // lists that then fell behind the source.
      { find: '@opencode-ai/sdk/v2', replacement: path.resolve(here, '../../node_modules/@opencode-ai/sdk/dist/v2/client.js') },
      { find: '@openchamber/ui', replacement: path.resolve(here, '../ui/src') },
      { find: '@web', replacement: path.resolve(here, './src') },
      // Anchored to `@/` on purpose: a bare `@` prefix would also swallow
      // scoped dependencies the server tests rely on, such as `@octokit/rest`.
      { find: /^@\//, replacement: `${path.resolve(here, '../ui/src')}/` },
    ],
  },
  test: {
    // The Git suites drive a real `git` binary against temporary repositories.
    // Those subprocess round-trips routinely pass the 5s default, and which
    // cases exceed it shifts with machine load, so the default made a valid
    // suite fail differently on every run.
    testTimeout: 30_000,
    hookTimeout: 30_000,
  },
});
