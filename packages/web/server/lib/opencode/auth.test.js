import { describe, expect, it } from 'vitest';
import fs from 'fs';
import os from 'os';
import path from 'path';
import { fileURLToPath, pathToFileURL } from 'url';

const AUTH_MODULE_PATH = fileURLToPath(new URL('./auth.js', import.meta.url));

// auth.js bakes the data directory into module scope from os.homedir() at
// import time. Point os.homedir() at a temp home for that import only, so no
// test ever touches the real ~/.local/share/opencode.
const loadAuthModule = async () => {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'oc-auth-permissions-'));
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

describe('writeAuthFile directory permissions', () => {
  it.skipIf(process.platform === 'win32')('applies 0700 only on directory creation', async () => {
    const { authModule, dataDir, authFile, restore } = await loadAuthModule();
    try {
      authModule.writeAuthFile({ anthropic: { type: 'api', key: 'secret' } });

      expect(fs.statSync(dataDir).mode & 0o777).toBe(0o700);
      expect(fs.statSync(authFile).mode & 0o777).toBe(0o600);
    } finally {
      restore();
    }
  });

  it.skipIf(process.platform === 'win32')('preserves a pre-existing data directory mode across writes', async () => {
    const { authModule, dataDir, restore } = await loadAuthModule();
    try {
      fs.mkdirSync(dataDir, { recursive: true });
      fs.chmodSync(dataDir, 0o770);

      authModule.writeAuthFile({ anthropic: { type: 'api', key: 'secret' } });
      expect(fs.statSync(dataDir).mode & 0o777).toBe(0o770);

      authModule.writeAuthFile({ anthropic: { type: 'api', key: 'rotated' } });
      expect(fs.statSync(dataDir).mode & 0o777).toBe(0o770);
    } finally {
      restore();
    }
  });
});
