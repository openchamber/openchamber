import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const AUTH_MODULE_PATH = fileURLToPath(new URL('./opencodeAuth.ts', import.meta.url));

// opencodeAuth.ts bakes the data directory into module scope from os.homedir()
// at import time. Point os.homedir() at a temp home for that import only, so no
// test ever touches the real ~/.local/share/opencode.
const loadAuthModule = async () => {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'oc-vscode-auth-permissions-'));
  const originalHomedir = os.homedir;
  os.homedir = () => home;
  let authModule;
  try {
    authModule = await import(`${pathToFileURL(AUTH_MODULE_PATH).href}?auth-permissions-test=${Math.random().toString(36).slice(2)}`);
  } finally {
    os.homedir = originalHomedir;
  }
  return {
    authModule,
    dataDir: path.join(home, '.local', 'share', 'opencode'),
    authFile: path.join(home, '.local', 'share', 'opencode', 'auth.json'),
    restore: () => fs.rmSync(home, { recursive: true, force: true }),
  };
};

describe('VS Code writeAuthFile directory permissions', () => {
  it('applies 0700 only on directory creation', { skip: process.platform === 'win32' }, async () => {
    const { authModule, dataDir, authFile, restore } = await loadAuthModule();
    try {
      authModule.updateProviderAuth('anthropic', { type: 'api', key: 'secret' });

      assert.equal(fs.statSync(dataDir).mode & 0o777, 0o700);
      assert.equal(fs.statSync(authFile).mode & 0o777, 0o600);
    } finally {
      restore();
    }
  });

  it('preserves a pre-existing data directory mode across writes', { skip: process.platform === 'win32' }, async () => {
    const { authModule, dataDir, restore } = await loadAuthModule();
    try {
      fs.mkdirSync(dataDir, { recursive: true });
      fs.chmodSync(dataDir, 0o770);

      authModule.updateProviderAuth('anthropic', { type: 'api', key: 'secret' });
      assert.equal(fs.statSync(dataDir).mode & 0o777, 0o770);

      authModule.updateProviderAuth('anthropic', { type: 'api', key: 'rotated' });
      assert.equal(fs.statSync(dataDir).mode & 0o777, 0o770);
    } finally {
      restore();
    }
  });
});
