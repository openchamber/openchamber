import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  readDesktopLocalClientTokenFromSettings,
  readDesktopLocalPortFromSettings,
  readLastManagedLocalConfigPath,
  writeLastManagedLocalConfigPath,
} from './cli-paths.js';

let dataDir;

beforeEach(() => {
  dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'oc-cli-paths-'));
  vi.stubEnv('OPENCHAMBER_DATA_DIR', dataDir);
});

afterEach(() => {
  vi.unstubAllEnvs();
  fs.rmSync(dataDir, { recursive: true, force: true });
});

describe('CLI settings reads', () => {
  it.each([null, [], 0, 'text', { desktopLocalPort: '3000' }, { desktopLocalPort: 65536 }])(
    'keeps defaults for unchecked settings: %j',
    (settings) => {
      fs.writeFileSync(path.join(dataDir, 'settings.json'), JSON.stringify(settings));

      expect(readDesktopLocalPortFromSettings()).toBeNull();
      expect(readDesktopLocalClientTokenFromSettings()).toBe('');
    },
  );

  it('preserves the finite-number acceptance rule and trims the token', () => {
    fs.writeFileSync(path.join(dataDir, 'settings.json'), JSON.stringify({
      desktopLocalPort: 3000.5,
      desktopLocalClientToken: ' local-token ',
    }));

    expect(readDesktopLocalPortFromSettings()).toBe(3000.5);
    expect(readDesktopLocalClientTokenFromSettings()).toBe('local-token');
  });

  it('preserves unrelated tunnel state when saving a config path', () => {
    const statePath = path.join(dataDir, 'tunnel-cli-state.json');
    fs.writeFileSync(statePath, '{"constructor":"retained","other":{"enabled":true},"lastManagedLocalConfigPath":42}');
    expect(readLastManagedLocalConfigPath()).toBe('');

    writeLastManagedLocalConfigPath(' config.yml ');

    expect(readLastManagedLocalConfigPath()).toBe('config.yml');
    expect(JSON.parse(fs.readFileSync(statePath, 'utf8'))).toMatchObject({
      constructor: 'retained',
      other: { enabled: true },
      lastManagedLocalConfigPath: 'config.yml',
    });
  });
});
