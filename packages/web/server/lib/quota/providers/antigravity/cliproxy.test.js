import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { expect, it } from 'vitest';

// Credential paths are module-level constants. Use a fresh Node process so the
// sandbox HOME/config paths and fetch guard apply before the first import.
it('CLIProxyAPI account source passes its isolated loopback integration suite', () => {
  const result = spawnSync(process.execPath, [
    '--test', fileURLToPath(new URL('./cliproxy.integration.mjs', import.meta.url))
  ], { encoding: 'utf8', timeout: 15_000 });
  expect(result.error, result.stderr).toBeUndefined();
  expect(result.status, result.stdout + result.stderr).toBe(0);
});
