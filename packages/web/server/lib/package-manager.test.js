import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

// Mock child_process to prevent real spawnSync calls that would hang in tests
vi.mock('node:child_process', () => ({
  spawn: vi.fn(),
  spawnSync: vi.fn(() => ({ status: 0, stdout: '/usr/local/bin', stderr: '' })),
}));

const {
  checkForUpdates,
  detectPackageManager,
  executeUpdate,
  getUpdateLaunchSpec,
  getCurrentVersion,
} = await import('./package-manager.js');

/** Helper: create a fetch mock that routes by URL pattern */
function createFetchMock() {
  const handlers = new Map();

  const mock = vi.fn((url, options) => {
    const urlStr = typeof url === 'string' ? url : url.toString();

    for (const [pattern, response] of handlers) {
      if (urlStr.includes(pattern)) {
        return Promise.resolve(response);
      }
    }

    return Promise.reject(new Error(`Unexpected fetch call: ${urlStr}`));
  });

  mock.when = (pattern, response) => {
    handlers.set(pattern, response);
    return mock;
  };

  return mock;
}

describe('checkForUpdates', () => {
  let fetchMock;
  let originalFetch;

  beforeEach(() => {
    fetchMock = createFetchMock();
    originalFetch = globalThis.fetch;
    globalThis.fetch = fetchMock;
  });

  afterEach(() => {
    globalThis.fetch = originalFetch;
  });

  // --- Scenario: API says update available, npm confirms ---

  it('returns available=true when both API and npm confirm a newer version', async () => {
    fetchMock
      .when('api.openchamber.dev', {
        ok: true,
        json: async () => ({
          latestVersion: '1.10.0',
          updateAvailable: true,
          releaseNotes: '## [1.10.0] - 2026-05-01\n\n- Great new feature',
        }),
      })
      .when('registry.npmjs.org', {
        ok: true,
        json: async () => ({
          'dist-tags': { latest: '1.10.0' },
        }),
      })
      .when('raw.githubusercontent.com', {
        ok: true,
        text: async () => '## [1.10.0] - 2026-05-01\n\n- Great new feature',
      });

    const result = await checkForUpdates({ currentVersion: '1.9.10' });

    expect(result.available).toBe(true);
    expect(result.version).toBe('1.10.0');
    expect(result.currentVersion).toBe('1.9.10');
  });

  // --- Scenario (THE FIX): API says update available, npm does NOT have it ---

  it('returns available=false when API claims update but npm has same version', async () => {
    fetchMock
      .when('api.openchamber.dev', {
        ok: true,
        json: async () => ({
          latestVersion: '1.10.0',
          updateAvailable: true,
          releaseNotes: '## [1.10.0] - 2026-05-01\n\n- Great new feature',
        }),
      })
      .when('registry.npmjs.org', {
        ok: true,
        json: async () => ({
          'dist-tags': { latest: '1.9.10' },
        }),
      });

    const result = await checkForUpdates({ currentVersion: '1.9.10' });

    expect(result.available).toBe(false);
  });

  it('returns available=false when npm only has a prerelease of the current version', async () => {
    fetchMock
      .when('api.openchamber.dev', Promise.reject(new Error('Network error')))
      .when('registry.npmjs.org', {
        ok: true,
        json: async () => ({
          'dist-tags': { latest: '1.10.0-beta.1' },
        }),
      });

    const result = await checkForUpdates({ currentVersion: '1.10.0' });

    expect(result.available).toBe(false);
  });

  it('accepts electron desktop update claims without npm cross-checking', async () => {
    fetchMock
      .when('api.openchamber.dev', {
        ok: true,
        json: async () => ({
          latestVersion: '1.10.0',
          updateAvailable: true,
          releaseNotes: '## [1.10.0] - 2026-05-01\n\n- Great new feature',
        }),
      });

    const result = await checkForUpdates({
      appType: 'desktop-electron',
      currentVersion: '1.9.10',
    });

    expect(result.available).toBe(true);
    expect(result.version).toBe('1.10.0');
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it('returns available=false when API claims update but npm is behind', async () => {
    fetchMock
      .when('api.openchamber.dev', {
        ok: true,
        json: async () => ({
          latestVersion: '1.10.0',
          updateAvailable: true,
          releaseNotes: '## [1.10.0] - 2026-05-01\n\n- Great new feature',
        }),
      })
      .when('registry.npmjs.org', {
        ok: true,
        json: async () => ({
          'dist-tags': { latest: '1.9.9' },
        }),
      });

    const result = await checkForUpdates({ currentVersion: '1.9.10' });

    expect(result.available).toBe(false);
  });

  // --- Scenario: API says no update, npm agrees ---

  it('returns available=false when API says no update and versions match', async () => {
    fetchMock.when('api.openchamber.dev', {
      ok: true,
      json: async () => ({
        latestVersion: '1.9.10',
        updateAvailable: false,
      }),
    });

    const result = await checkForUpdates({ currentVersion: '1.9.10' });

    expect(result.available).toBe(false);
  });

  // --- Scenario: API unreachable, npm fallback ---

  it('returns available=true from npm fallback when API is unreachable and npm has newer version', async () => {
    fetchMock
      .when('api.openchamber.dev', Promise.reject(new Error('Network error')))
      .when('registry.npmjs.org', {
        ok: true,
        json: async () => ({
          'dist-tags': { latest: '1.10.0' },
        }),
      })
      .when('raw.githubusercontent.com', {
        ok: true,
        text: async () => '## [1.10.0] - 2026-05-01\n\n- Great new feature',
      });

    const result = await checkForUpdates({ currentVersion: '1.9.10' });

    expect(result.available).toBe(true);
    expect(result.version).toBe('1.10.0');
  });

  it('returns available=false from npm fallback when API is unreachable and versions match', async () => {
    fetchMock
      .when('api.openchamber.dev', Promise.reject(new Error('Network error')))
      .when('registry.npmjs.org', {
        ok: true,
        json: async () => ({
          'dist-tags': { latest: '1.9.10' },
        }),
      });

    const result = await checkForUpdates({ currentVersion: '1.9.10' });

    expect(result.available).toBe(false);
  });

  // --- Scenario: API returns null (bad response), npm fallback ---

  it('returns available=false when API returns non-ok status and versions match on npm', async () => {
    fetchMock
      .when('api.openchamber.dev', {
        ok: false,
        status: 500,
        json: async () => ({}),
      })
      .when('registry.npmjs.org', {
        ok: true,
        json: async () => ({
          'dist-tags': { latest: '1.9.10' },
        }),
      });

    const result = await checkForUpdates({ currentVersion: '1.9.10' });

    expect(result.available).toBe(false);
  });

  // --- Scenario: Both API and npm are unreachable ---

  it('returns available=false when both sources are unreachable', async () => {
    fetchMock
      .when('api.openchamber.dev', Promise.reject(new Error('Network error')))
      .when('registry.npmjs.org', Promise.reject(new Error('Registry unreachable')));

    const result = await checkForUpdates({ currentVersion: '1.9.10' });

    expect(result.available).toBe(false);
  });
});

describe('getCurrentVersion', () => {
  it('is exported for the CLI update command', () => {
    expect(typeof getCurrentVersion).toBe('function');
    expect(getCurrentVersion()).toMatch(/^\d+\.\d+\.\d+|unknown$/);
  });
});

describe('CLI update exports', () => {
  it('exports package-manager helpers used by the update command', () => {
    expect(typeof detectPackageManager).toBe('function');
    expect(typeof executeUpdate).toBe('function');
  });
});

describe('getUpdateLaunchSpec', () => {
  it('pins the package-manager arguments to the requested target version', () => {
    expect(getUpdateLaunchSpec('npm', '2.3.4', { platform: 'linux', command: '/usr/bin/npm' })).toEqual({
      command: '/usr/bin/npm',
      args: ['install', '-g', '@openchamber/web@2.3.4'],
      source: 'executable',
    });
  });

  it('resolves the standard Windows npm shim to npm-cli.js', () => {
    const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'openchamber-npm-shim-'));
    try {
      const shimPath = path.join(directory, 'npm.cmd');
      const npmCliPath = path.join(directory, 'node_modules', 'npm', 'bin', 'npm-cli.js');
      fs.mkdirSync(path.dirname(npmCliPath), { recursive: true });
      fs.writeFileSync(shimPath, '@echo off\r\n');
      fs.writeFileSync(npmCliPath, '');

      expect(getUpdateLaunchSpec('npm', '2.3.4', {
        platform: 'win32',
        command: 'npm',
        execPath: 'C:\\Program Files\\nodejs\\node.exe',
        spawnSync: vi.fn(() => ({ status: 0, stdout: `${shimPath}\r\n`, stderr: '' })),
      })).toEqual({
        command: 'C:\\Program Files\\nodejs\\node.exe',
        args: [npmCliPath, 'install', '-g', '@openchamber/web@2.3.4'],
        source: 'node-shim',
      });
    } finally {
      fs.rmSync(directory, { recursive: true, force: true });
    }
  });

  it('fails closed when a Windows package-manager shim cannot be resolved safely', () => {
    const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'openchamber-bad-shim-'));
    try {
      const shimPath = path.join(directory, 'npm.cmd');
      fs.writeFileSync(shimPath, '@echo off\r\n');
      expect(() => getUpdateLaunchSpec('npm', '2.3.4', {
        platform: 'win32',
        command: 'npm',
        spawnSync: vi.fn(() => ({ status: 0, stdout: `${shimPath}\r\n`, stderr: '' })),
      })).toThrow('Unable to safely resolve');
    } finally {
      fs.rmSync(directory, { recursive: true, force: true });
    }
  });

  it('rejects non-version package targets before launching a package manager', () => {
    expect(() => getUpdateLaunchSpec('npm', 'file:untrusted-package.tgz', {
      platform: 'linux',
      command: '/usr/bin/npm',
    })).toThrow('Invalid OpenChamber update target version');
  });
});
