import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

// Mock child_process to prevent real spawnSync calls that would hang in tests
vi.mock('node:child_process', () => ({
  spawn: vi.fn(),
  spawnSync: vi.fn(() => ({ status: 0, stdout: '/usr/local/bin', stderr: '' })),
}));

const {
  checkForUpdates,
  detectPackageManager,
  detectPackageManagerDetails,
  executeUpdate,
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

describe('detectPackageManagerDetails', () => {
  // Each test re-imports a fresh module instance (resetting the in-module
  // detection cache) together with a fresh child_process mock, so the
  // spawnSync behavior can be controlled without disturbing other tests.

  it('falls back to default-fallback without probing every package manager when nothing owns the install', async () => {
    vi.resetModules();
    const { spawnSync: freshSpawnSync } = await import('node:child_process');
    const { detectPackageManagerDetails: freshDetect } = await import('./package-manager.js');

    // Every PM binary exists, but none of the global queries reveals an
    // openchamber install (no ownership match, no `list -g` match).
    freshSpawnSync.mockImplementation((command, args) => {
      if (Array.isArray(args) && args.includes('--version')) {
        return { status: 0, stdout: '', stderr: '' };
      }
      if (Array.isArray(args) && args.includes('-g')) {
        return { status: 0, stdout: '/tmp/global-bin', stderr: '' };
      }
      return { status: 0, stdout: '', stderr: '' };
    });

    const details = freshDetect();

    expect(details.reason).toBe('default-fallback');
    expect(details.packageManager).toBe('npm');

    // The ownership-check cap stops the per-PM `bin -g`/`root -g` storm before
    // bun is ever ownership-probed (only the first two candidates are checked).
    const bunOwnershipProbes = freshSpawnSync.mock.calls.filter(
      ([command, args]) => command === 'bun' && Array.isArray(args) && args[0] === 'pm' && args[1] === 'bin',
    );
    expect(bunOwnershipProbes).toHaveLength(0);

    // A second call is served from the cache: no global `-g` queries are
    // re-run (only the cheap `--version` command-resolution check), and the
    // fallback reason is preserved instead of being reported as 'cached'.
    const spawnCallsBeforeSecondCall = freshSpawnSync.mock.calls.length;
    const cached = freshDetect();
    const callsDuringCached = freshSpawnSync.mock.calls.slice(spawnCallsBeforeSecondCall);
    expect(cached.reason).toBe('default-fallback');
    expect(callsDuringCached.filter(([, args]) => Array.isArray(args) && args.includes('-g'))).toHaveLength(0);
  });

  it('still detects a genuinely global npm install after the ownership-check cap', async () => {
    vi.resetModules();
    const { spawnSync: freshSpawnSync } = await import('node:child_process');
    const { detectPackageManagerDetails: freshDetect } = await import('./package-manager.js');

    // `npm list -g` reports the package; everything else finds nothing, so the
    // npm-global install is only discoverable through the fallback checks.
    freshSpawnSync.mockImplementation((command, args) => {
      if (command === 'npm' && Array.isArray(args) && args[0] === 'list') {
        return { status: 0, stdout: '@openchamber/web@1.2.3', stderr: '' };
      }
      if (Array.isArray(args) && args.includes('--version')) {
        return { status: 0, stdout: '', stderr: '' };
      }
      if (Array.isArray(args) && args.includes('-g')) {
        return { status: 0, stdout: '/tmp/global-bin', stderr: '' };
      }
      return { status: 0, stdout: '', stderr: '' };
    });

    const details = freshDetect();

    expect(details.packageManager).toBe('npm');
    expect(details.reason).not.toBe('default-fallback');
  });
});
