import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

// Mock child_process to prevent real spawnSync calls that would hang in tests
vi.mock('node:child_process', () => ({
  spawn: vi.fn(),
  spawnSync: vi.fn(() => ({ status: 0, stdout: '/usr/local/bin', stderr: '' })),
}));

const {
  checkForUpdates,
  detectPackageManager,
  executeUpdate,
  getCurrentVersion,
  getUpdateCommand,
  readUpdateChannel,
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
  let previousDataDir;

  beforeEach(() => {
    fetchMock = createFetchMock();
    originalFetch = globalThis.fetch;
    globalThis.fetch = fetchMock;
    // No channel picked: these are the release checks, whatever the machine's own settings say.
    previousDataDir = process.env.OPENCHAMBER_DATA_DIR;
    process.env.OPENCHAMBER_DATA_DIR = path.join(os.tmpdir(), 'oc-update-check-no-settings');
  });

  afterEach(() => {
    globalThis.fetch = originalFetch;
    if (previousDataDir === undefined) delete process.env.OPENCHAMBER_DATA_DIR;
    else process.env.OPENCHAMBER_DATA_DIR = previousDataDir;
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

  // --- Scenario: cross-verification uses the configured npm registry ---

  it('cross-verifies against the configured npm registry, not registry.npmjs.org', async () => {
    const previousLower = process.env.npm_config_registry;
    const previous = process.env.NPM_CONFIG_REGISTRY;
    process.env.npm_config_registry = '';
    process.env.NPM_CONFIG_REGISTRY = 'https://mirror.example.com/npm';
    // Only the mirror is mocked. A stray call to registry.npmjs.org would reject,
    // drop npm cross-verification, and flip available to false.
    fetchMock
      .when('api.openchamber.dev', {
        ok: true,
        json: async () => ({
          latestVersion: '1.10.0',
          updateAvailable: true,
          releaseNotes: '## [1.10.0]\n\n- New',
        }),
      })
      .when('mirror.example.com/npm/@openchamber%2Fweb', {
        ok: true,
        json: async () => ({
          'dist-tags': { latest: '1.10.0' },
        }),
      })
      .when('raw.githubusercontent.com', {
        ok: true,
        text: async () => '## [1.10.0]\n\n- New',
      });

    try {
      const result = await checkForUpdates({ currentVersion: '1.9.10' });

      expect(result.available).toBe(true);
      expect(result.version).toBe('1.10.0');
      expect(
        fetchMock.mock.calls.some(([url]) => String(url) === 'https://mirror.example.com/npm/@openchamber%2Fweb'),
      ).toBe(true);
    } finally {
      if (previousLower === undefined) delete process.env.npm_config_registry;
      else process.env.npm_config_registry = previousLower;
      if (previous === undefined) delete process.env.NPM_CONFIG_REGISTRY;
      else process.env.NPM_CONFIG_REGISTRY = previous;
    }
  });

  it('cross-verifies scoped metadata without exposing registry credentials', async () => {
    const previousLower = process.env.npm_config_registry;
    const previous = process.env.NPM_CONFIG_REGISTRY;
    process.env.npm_config_registry = '';
    process.env.NPM_CONFIG_REGISTRY = 'https://test-user:test-password@mirror.example.com/npm/';
    fetchMock
      .when('api.openchamber.dev', {
        ok: true,
        json: async () => ({ latestVersion: '1.10.0', updateAvailable: true }),
      })
      .when('mirror.example.com/npm/@openchamber%2Fweb', {
        ok: true,
        json: async () => ({ 'dist-tags': { latest: '1.10.0' } }),
      });

    try {
      const result = await checkForUpdates({ currentVersion: '1.9.10' });
      const npmCall = fetchMock.mock.calls.find(([url]) => String(url).includes('mirror.example.com'));

      expect(result.available).toBe(true);
      expect(npmCall[0]).toBe('https://mirror.example.com/npm/@openchamber%2Fweb');
      expect(npmCall[0]).not.toContain('test-password');
      expect(npmCall[1].headers.Authorization).toBe(`Basic ${Buffer.from('test-user:test-password').toString('base64')}`);
    } finally {
      if (previousLower === undefined) delete process.env.npm_config_registry;
      else process.env.npm_config_registry = previousLower;
      if (previous === undefined) delete process.env.NPM_CONFIG_REGISTRY;
      else process.env.NPM_CONFIG_REGISTRY = previous;
    }
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
      installId: '4f4dfead-9688-4c4f-97d7-4607fbbfc3ab',
      platform: 'windows',
      arch: 'arm64',
    });

    expect(result.available).toBe(true);
    expect(result.version).toBe('1.10.0');
    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(JSON.parse(fetchMock.mock.calls[0][1].body)).toMatchObject({
      installId: '4f4dfead-9688-4c4f-97d7-4607fbbfc3ab',
      platform: 'windows',
      arch: 'arm64',
    });
  });

  it('still checks for updates in enterprise mode but reports no usage', async () => {
    fetchMock
      .when('api.openchamber.dev', {
        ok: true,
        json: async () => ({ latestVersion: '1.10.0', updateAvailable: true, releaseNotes: '' }),
      });
    process.env.OPENCHAMBER_ENTERPRISE_MODE = '1';
    try {
      const result = await checkForUpdates({
        appType: 'desktop-electron',
        currentVersion: '1.9.10',
        installId: '4f4dfead-9688-4c4f-97d7-4607fbbfc3ab',
        platform: 'windows',
        arch: 'arm64',
      });
      expect(result.available).toBe(true);
      const sent = JSON.parse(fetchMock.mock.calls[0][1].body);
      expect(sent.reportUsage).toBe(false);
      expect(sent.installId).toBeUndefined();
    } finally {
      delete process.env.OPENCHAMBER_ENTERPRISE_MODE;
    }
  });

  it('resolves an Android APK asset when the update API returns an AAB', async () => {
    fetchMock
      .when('api.openchamber.dev', {
        ok: true,
        json: async () => ({
          latestVersion: '1.10.0',
          updateAvailable: true,
          downloadUrl: 'https://github.com/openchamber/openchamber/releases/download/v1.10.0/OpenChamber-1.10.0-42-android.aab',
        }),
      })
      .when('api.github.com/repos/openchamber/openchamber/releases/tags/v1.10.0', {
        ok: true,
        json: async () => ({
          assets: [
            {
              name: 'OpenChamber-1.10.0-42-android.aab',
              browser_download_url: 'https://downloads.example/OpenChamber-1.10.0-42-android.aab',
            },
            {
              name: 'app-release.apk',
              browser_download_url: 'https://downloads.example/app-release.apk',
            },
            {
              name: 'OpenChamber-1.10.0-42-android.apk',
              browser_download_url: 'https://downloads.example/OpenChamber-1.10.0-42-android.apk',
            },
          ],
        }),
      });

    const result = await checkForUpdates({
      appType: 'mobile-capacitor',
      platform: 'android',
      currentVersion: '1.9.10',
    });

    expect(result.downloadUrl).toBe('https://downloads.example/OpenChamber-1.10.0-42-android.apk');
  });

  it('keeps a direct Android APK URL from the update API', async () => {
    const apkUrl = 'https://github.com/openchamber/openchamber/releases/download/v1.10.0/OpenChamber-1.10.0-42-android.apk';
    fetchMock.when('api.openchamber.dev', {
      ok: true,
      json: async () => ({
        latestVersion: '1.10.0',
        updateAvailable: true,
        downloadUrl: apkUrl,
      }),
    });

    const result = await checkForUpdates({
      appType: 'mobile-capacitor',
      platform: 'android',
      currentVersion: '1.9.10',
    });

    expect(result.downloadUrl).toBe(apkUrl);
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

describe('checkForUpdates on the update channels', () => {
  let fetchMock;
  let originalFetch;
  let dataDir;
  let previousDataDir;

  const pickChannel = (channel) => {
    fs.writeFileSync(path.join(dataDir, 'settings.json'), JSON.stringify({ serverUpdateChannel: channel }));
  };
  const serveDistTags = (distTags) => {
    fetchMock
      .when('api.openchamber.dev', { ok: true, json: async () => ({ latestVersion: '2.5.3', updateAvailable: true }) })
      .when('registry.npmjs.org', { ok: true, json: async () => ({ 'dist-tags': distTags }) });
  };

  beforeEach(() => {
    fetchMock = createFetchMock();
    originalFetch = globalThis.fetch;
    globalThis.fetch = fetchMock;
    previousDataDir = process.env.OPENCHAMBER_DATA_DIR;
    dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'oc-update-channel-'));
    process.env.OPENCHAMBER_DATA_DIR = dataDir;
  });

  afterEach(() => {
    globalThis.fetch = originalFetch;
    if (previousDataDir === undefined) delete process.env.OPENCHAMBER_DATA_DIR;
    else process.env.OPENCHAMBER_DATA_DIR = previousDataDir;
    fs.rmSync(dataDir, { recursive: true, force: true });
  });

  it('offers the Canary build once Canary is picked', async () => {
    pickChannel('canary');
    serveDistTags({ latest: '2.5.3', canary: '2.5.4-canary.20261031.7' });

    const result = await checkForUpdates({ currentVersion: '2.5.3' });

    expect(result).toMatchObject({ available: true, version: '2.5.4-canary.20261031.7', updateCommand: 'openchamber update' });
    // The website still counts the check-in.
    expect(fetchMock.mock.calls.some(([url]) => String(url).includes('api.openchamber.dev'))).toBe(true);
  });

  it('offers the next night and not the same or an earlier one', async () => {
    pickChannel('canary');
    serveDistTags({ latest: '2.5.3', canary: '2.5.4-canary.20261031.7' });

    expect((await checkForUpdates({ currentVersion: '2.5.4-canary.20261030.6' })).available).toBe(true);
    expect((await checkForUpdates({ currentVersion: '2.5.4-canary.20261031.7' })).available).toBe(false);
    expect((await checkForUpdates({ currentVersion: '2.5.4-canary.20261101.8' })).available).toBe(false);
  });

  it('is up to date on Canary before the first Canary is published', async () => {
    pickChannel('canary');
    serveDistTags({ latest: '2.5.3' });

    const result = await checkForUpdates({ currentVersion: '2.5.3' });

    expect(result.available).toBe(false);
    expect(result.error).toBeUndefined();
  });

  it('reports an unreadable registry as a failed check, not as up to date', async () => {
    pickChannel('canary');
    fetchMock
      .when('api.openchamber.dev', { ok: true, json: async () => ({ latestVersion: '2.5.3', updateAvailable: false }) })
      .when('registry.npmjs.org', Promise.reject(new Error('Registry unreachable')));

    const result = await checkForUpdates({ currentVersion: '2.5.3' });

    expect(result.available).toBe(false);
    expect(result.error).toBe('Unable to determine versions');
  });

  it('offers the older release on Stable from a Canary build', async () => {
    pickChannel('stable');
    serveDistTags({ latest: '2.5.3', canary: '2.5.4-canary.20261031.7' });

    const result = await checkForUpdates({ currentVersion: '2.5.4-canary.20261031.7' });

    expect(result).toMatchObject({ available: true, version: '2.5.3' });
  });

  it('keeps a Canary build installed from the terminal on Canary until a channel is picked', async () => {
    serveDistTags({ latest: '2.5.3', canary: '2.5.4-canary.20261031.7' });

    expect(readUpdateChannel('2.5.4-canary.20261031.7')).toBe('canary');
    expect(readUpdateChannel('2.5.3')).toBe('stable');
    expect((await checkForUpdates({ currentVersion: '2.5.4-canary.20261031.7' })).available).toBe(false);
  });

  it('leaves the desktop app, VS Code and phones on releases', async () => {
    pickChannel('canary');
    serveDistTags({ latest: '2.5.3', canary: '2.5.4-canary.20261031.7' });

    const result = await checkForUpdates({ currentVersion: '2.5.3', appType: 'vscode' });

    expect(result.version).toBe('2.5.3');
    expect(result.available).toBe(false);
  });
});

describe('getCurrentVersion', () => {
  it('is exported for the CLI update command', () => {
    expect(typeof getCurrentVersion).toBe('function');
    expect(getCurrentVersion()).toMatch(/^\d+\.\d+\.\d+|unknown$/);
  });
});

describe('getUpdateCommand', () => {
  it('pins the exact target version instead of re-resolving the latest dist-tag', () => {
    expect(getUpdateCommand('npm', { targetVersion: '1.24.1' })).toBe('npm install -g @openchamber/web@1.24.1');
    expect(getUpdateCommand('pnpm', { targetVersion: 'v1.24.1' })).toBe('pnpm add -g @openchamber/web@1.24.1');
    expect(getUpdateCommand('yarn', { targetVersion: '1.24.1' })).toBe('yarn global add @openchamber/web@1.24.1');
    expect(getUpdateCommand('bun', { targetVersion: '1.25.0-beta.1' })).toContain('add -g @openchamber/web@1.25.0-beta.1');
  });

  describe('pnpm build approvals', () => {
    function stubPnpmVersion(stdout, status = 0) {
      spawnSync.mockImplementation((command, args) => (
        Array.isArray(args) && args[0] === '--version'
          ? { status, stdout, stderr: '' }
          : { status: 0, stdout: '', stderr: '' }
      ));
    }

    afterEach(() => {
      spawnSync.mockReset();
    });

    it('pre-approves the dependency builds on pnpm 10.4 and newer', () => {
      for (const version of ['10.4.0', '10.34.6', '11.28.2', '12.11.2']) {
        stubPnpmVersion(`${version}\n`);
        expect(getUpdateCommand('pnpm', { targetVersion: '1.24.1' })).toBe(
          'pnpm add -g --allow-build=msgpackr-extract --allow-build=node-pty @openchamber/web@1.24.1',
        );
      }
    });

    it('leaves the flag out where pnpm rejects it or the version is unknown', () => {
      for (const version of ['9.15.9', '10.3.0', '']) {
        stubPnpmVersion(`${version}\n`);
        expect(getUpdateCommand('pnpm', { targetVersion: '1.24.1' })).toBe('pnpm add -g @openchamber/web@1.24.1');
      }
      stubPnpmVersion('', 1);
      expect(getUpdateCommand('pnpm', { targetVersion: '1.24.1' })).toBe('pnpm add -g @openchamber/web@1.24.1');
    });
  });

  it('falls back to the latest dist-tag when no target version is given', () => {
    expect(getUpdateCommand('npm')).toBe('npm install -g @openchamber/web@latest');
  });

  it('rejects a target version that is not a concrete version', () => {
    expect(() => getUpdateCommand('npm', { targetVersion: 'latest; rm -rf /' })).toThrow(/Invalid target version/);
  });
});

describe('executeUpdate', () => {
  function stubSpawnSync({ installStatus = 0, listingStdout = '', listingStatus = 0 } = {}) {
    spawnSync.mockImplementation((command, args) => {
      if (!Array.isArray(args)) {
        return { status: installStatus, stdout: '', stderr: '' };
      }
      if (args.includes('--version')) {
        return { status: 0, stdout: '10.0.0', stderr: '' };
      }
      if (args[0] === 'list' || args[0] === 'pm' || args[0] === 'global') {
        return { status: listingStatus, stdout: listingStdout, stderr: '' };
      }
      return { status: 0, stdout: '', stderr: '' };
    });
  }

  afterEach(() => {
    spawnSync.mockReset();
  });

  it('reports success when the installed version matches the target', () => {
    stubSpawnSync({ listingStdout: '└── @openchamber/web@1.24.1' });
    const result = executeUpdate('npm', { targetVersion: '1.24.1' });
    expect(result.success).toBe(true);
    expect(result.installedVersion).toBe('1.24.1');
  });

  it('fails when the package manager exits non-zero', () => {
    stubSpawnSync({ installStatus: 1 });
    const result = executeUpdate('npm', { targetVersion: '1.24.1' });
    expect(result.success).toBe(false);
    expect(result.error).toContain('exited with code 1');
  });

  it('fails when the package manager exits successfully but installed the wrong version', () => {
    stubSpawnSync({ listingStdout: '└── @openchamber/web@1.19.0' });
    const result = executeUpdate('npm', { targetVersion: '1.24.1' });
    expect(result.success).toBe(false);
    expect(result.error).toContain('1.19.0');
    expect(result.error).toContain('1.24.1');
  });

  it('fails loudly when the installed version cannot be verified', () => {
    stubSpawnSync({ listingStdout: '', listingStatus: 1 });
    const result = executeUpdate('npm', { targetVersion: '1.24.1' });
    expect(result.success).toBe(false);
    expect(result.error).toContain('Could not determine');
  });

  it('keeps the previous behavior when no target version is given', () => {
    stubSpawnSync();
    const result = executeUpdate('npm');
    expect(result.success).toBe(true);
    expect(result.installedVersion).toBeNull();
  });
});

describe('detectPackageManagerDetails', () => {
  afterEach(() => {
    vi.restoreAllMocks();
    spawnSync.mockReset();
    vi.unstubAllEnvs();
  });

  it.each([
    ['Windows pnpm store', String.raw`D:\pnpm-store\v11\links\@openchamber\web\2.5.1\hash\node_modules\@openchamber\web`, 'pnpm'],
    ['POSIX pnpm store', '/home/user/.local/share/pnpm-store/v11/links/@openchamber/web/2.5.1/hash/node_modules/@openchamber/web', 'pnpm'],
    ['case-insensitive Windows pnpm store', String.raw`D:\PNPM-STORE\v11\links\@openchamber\web\2.5.1\hash\node_modules\@openchamber\web`, 'pnpm'],
    ['pnpm virtual store', '/opt/global/node_modules/.pnpm/@openchamber+web@2.5.1/node_modules/@openchamber/web', 'pnpm'],
    ['npm install', '/usr/local/lib/node_modules/@openchamber/web', 'npm'],
    ['unrelated store name', '/opt/pnpm-store-backup/node_modules/@openchamber/web', 'npm'],
  ])('uses the install path for %s when global roots cannot establish ownership', async (_name, packagePath, packageManager) => {
    vi.stubEnv('OPENCHAMBER_RUNTIME', '');
    vi.stubEnv('OPENCHAMBER_PACKAGE_MANAGER', '');
    vi.stubEnv('npm_config_user_agent', '');
    vi.stubEnv('npm_execpath', '');
    spawnSync.mockImplementation((command, args) => {
      if (command !== 'npm' && command !== 'pnpm') {
        return { status: 1, stdout: '', stderr: '' };
      }
      if (args[0] === '--version') {
        return { status: 0, stdout: '10.0.0', stderr: '' };
      }
      if (args[0] === 'list') {
        return { status: 0, stdout: '@openchamber/web 2.5.1', stderr: '' };
      }
      return { status: 1, stdout: '', stderr: '' };
    });
    vi.resetModules();
    const { detectPackageManagerDetails, getUpdateCommand } = await import('./package-manager.js');
    const moduleDir = path.dirname(fileURLToPath(import.meta.url));
    const resolve = path.resolve;
    vi.spyOn(path, 'resolve').mockImplementation((...parts) => (
      parts.length === 3 && parts[0] === moduleDir && parts[1] === '..' && parts[2] === '..'
        ? packagePath
        : resolve(...parts)
    ));

    expect(detectPackageManagerDetails()).toMatchObject({
      packageManager,
      packagePath,
      reason: 'hinted-visible-install',
      globalNodeModulesRoot: null,
    });
    expect(getUpdateCommand()).toBe(packageManager === 'pnpm'
      ? 'pnpm add -g @openchamber/web@latest'
      : 'npm install -g @openchamber/web@latest');
  });

  it('keeps reporting a copy no package manager installed after the first detection', async () => {
    vi.stubEnv('OPENCHAMBER_RUNTIME', '');
    vi.stubEnv('OPENCHAMBER_PACKAGE_MANAGER', '');
    // No package manager answers, as on a server where an unpacked tarball runs.
    spawnSync.mockImplementation(() => ({ status: 1, stdout: '', stderr: '' }));
    vi.resetModules();
    const { detectPackageManagerDetails, isUnmanagedInstall } = await import('./package-manager.js');

    expect(detectPackageManagerDetails().reason).toBe('unmanaged-install');
    expect(detectPackageManagerDetails().reason).toBe('unmanaged-install');
    expect(isUnmanagedInstall()).toBe(true);
  });
});

describe('CLI update exports', () => {
  it('exports package-manager helpers used by the update command', () => {
    expect(typeof detectPackageManager).toBe('function');
    expect(typeof executeUpdate).toBe('function');
  });
});
