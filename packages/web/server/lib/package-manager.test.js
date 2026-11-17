import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { spawnSync } from 'node:child_process';

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
    delete process.env.OPENCHAMBER_UPDATE_API_URL;
  });

  const release = (tag, extra = {}) => ({
    tag_name: tag,
    draft: false,
    prerelease: false,
    assets: [],
    body: `notes for ${tag}`,
    html_url: `https://github.com/developing-today-forks/openchamber/releases/tag/${tag}`,
    ...extra,
  });
  const forkReleases = (...releases) => ({ ok: true, json: async () => releases });
  const upstreamCalls = () => fetchMock.mock.calls.filter(([url]) => /api\.openchamber\.dev|registry\.npmjs\.org|raw\.githubusercontent\.com\/openchamber/.test(String(url)));

  it('reports the highest published fork release as the update, for every app type', async () => {
    fetchMock.when('developing-today-forks/openchamber/releases?per_page=30', forkReleases(release('v1.9.10'), release('v1.10.0')));

    for (const appType of ['web', 'desktop-electron', 'vscode']) {
      const result = await checkForUpdates({ currentVersion: '1.9.10', appType });
      expect(result.available).toBe(true);
      expect(result.version).toBe('1.10.0');
      expect(result.releaseUrl).toBe('https://github.com/developing-today-forks/openchamber/releases/tag/v1.10.0');
      expect(result.manualUpdate).toBe(true);
      expect(result.updateCommand).toContain('https://github.com/developing-today-forks/openchamber/releases/tag/v1.10.0');
    }
    expect(upstreamCalls()).toHaveLength(0);
  });

  it('ignores drafts and prereleases when picking the latest release', async () => {
    fetchMock.when('developing-today-forks/openchamber/releases?per_page=30', forkReleases(
      release('v1.11.0', { draft: true }),
      release('v1.10.1-rc.1', { prerelease: true }),
      release('v1.10.0'),
    ));

    const result = await checkForUpdates({ currentVersion: '1.9.10', appType: 'web' });

    expect(result.available).toBe(true);
    expect(result.version).toBe('1.10.0');
  });

  it('picks the highest semver release, not the newest one created', async () => {
    fetchMock.when('developing-today-forks/openchamber/releases?per_page=30', forkReleases(release('v2.2.0'), release('v2.10.0'), release('v2.9.0')));

    const result = await checkForUpdates({ currentVersion: '2.2.0', appType: 'web' });

    expect(result.version).toBe('2.10.0');
  });

  it('reports no update when the fork release has the installed version', async () => {
    fetchMock.when('developing-today-forks/openchamber/releases?per_page=30', forkReleases(release('v1.10.0')));

    const result = await checkForUpdates({ currentVersion: '1.10.0', appType: 'web' });

    expect(result.available).toBe(false);
  });

  it('reports no update and does not fall back to npm when the fork feed is unreachable', async () => {
    fetchMock.when('developing-today-forks/openchamber/releases?per_page=30', { ok: false, status: 503, json: async () => ({}) });

    const result = await checkForUpdates({ currentVersion: '1.9.10', appType: 'web' });

    expect(result.available).toBe(false);
    expect(result.error).toBe('Unable to reach the release feed');
    expect(upstreamCalls()).toHaveLength(0);
  });

  it('uses OPENCHAMBER_UPDATE_API_URL instead of the fork feed when it is set', async () => {
    process.env.OPENCHAMBER_UPDATE_API_URL = 'https://api.openchamber.dev/v1/update/check';
    fetchMock.when('api.openchamber.dev', {
      ok: true,
      json: async () => ({ latestVersion: '1.10.0', updateAvailable: true, releaseNotes: '- override' }),
    });

    const result = await checkForUpdates({ currentVersion: '1.9.10', appType: 'web' });

    expect(result.available).toBe(true);
    expect(result.version).toBe('1.10.0');
    expect(fetchMock.mock.calls.some(([url]) => String(url).includes('developing-today-forks/openchamber/releases?per_page'))).toBe(false);
  });

  it('reports no update when the update API returns a malformed latest version', async () => {
    process.env.OPENCHAMBER_UPDATE_API_URL = 'https://api.openchamber.dev/v1/update/check';
    fetchMock.when('api.openchamber.dev', {
      ok: true,
      json: async () => ({ latestVersion: '1.10junk.0', updateAvailable: true }),
    });

    const result = await checkForUpdates({ currentVersion: '1.9.10', appType: 'web' });

    // parseInt alone read '10junk' as 10 and claimed the upgrade; a malformed
    // version must never claim an update.
    expect(result.available).toBe(false);
  });

  // --- Response body caps (the update answers are read through the bounded reader) ---

  const streamedBody = (chunks) => {
    const state = { cancelled: false };
    const stream = new ReadableStream({
      start(controller) {
        for (const chunk of chunks) controller.enqueue(new TextEncoder().encode(chunk));
        // Never closed: only the reader cancelling can end this body.
      },
      cancel() {
        state.cancelled = true;
      },
    });
    return { response: new Response(stream), state };
  };
  const oversizedJson = (value) => {
    const json = JSON.stringify(value);
    const half = Math.ceil(json.length / 2);
    return [json.slice(0, half), json.slice(half), 'x'.repeat(1024 * 1024)];
  };

  it('reports no update when the update API streams an over-cap body, and cancels the stream', async () => {
    process.env.OPENCHAMBER_UPDATE_API_URL = 'https://api.openchamber.dev/v1/update/check';
    const { response, state } = streamedBody(oversizedJson({ latestVersion: '9.9.9', updateAvailable: true }));
    fetchMock.when('api.openchamber.dev', { ok: true, body: response.body, headers: response.headers });

    const result = await checkForUpdates({ currentVersion: '1.9.10', appType: 'web' });

    expect(result.available).toBe(false);
    expect(state.cancelled).toBe(true);
  });

  it('reports no update when the fork feed streams an over-cap body, and cancels the stream', async () => {
    const { response, state } = streamedBody(oversizedJson([release('v9.9.9')]));
    fetchMock.when('developing-today-forks/openchamber/releases?per_page=30', { ok: true, body: response.body, headers: response.headers });

    const result = await checkForUpdates({ currentVersion: '1.9.10', appType: 'web' });

    expect(result.available).toBe(false);
    expect(state.cancelled).toBe(true);
  });

  it('reports no update when the installed version is malformed', async () => {
    process.env.OPENCHAMBER_UPDATE_API_URL = 'https://api.openchamber.dev/v1/update/check';
    fetchMock.when('api.openchamber.dev', {
      ok: true,
      json: async () => ({ latestVersion: '1.10.0', updateAvailable: true }),
    });

    const result = await checkForUpdates({ currentVersion: '1..9', appType: 'web' });

    expect(result.available).toBe(false);
  });

  // --- Android APK resolution (the API override still hands over a direct APK URL) ---

  it('resolves an Android APK asset from the fork release when the update API returns an AAB', async () => {
    process.env.OPENCHAMBER_UPDATE_API_URL = 'https://api.openchamber.dev/v1/update/check';
    fetchMock
      .when('api.openchamber.dev', {
        ok: true,
        json: async () => ({
          latestVersion: '1.10.0',
          updateAvailable: true,
          downloadUrl: 'https://github.com/developing-today-forks/openchamber/releases/download/v1.10.0/OpenChamber-1.10.0-42-android.aab',
        }),
      })
      .when('api.github.com/repos/developing-today-forks/openchamber/releases/tags/v1.10.0', {
        ok: true,
        json: async () => ({
          assets: [{ name: 'OpenChamber-1.10.0-42-android.apk', browser_download_url: 'https://downloads.example/OpenChamber-1.10.0-42-android.apk' }],
        }),
      });

    const result = await checkForUpdates({ appType: 'mobile-capacitor', platform: 'android', currentVersion: '1.9.10' });

    expect(result.downloadUrl).toBe('https://downloads.example/OpenChamber-1.10.0-42-android.apk');
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
  it('never runs the package manager and points at the fork release', () => {
    vi.mocked(spawnSync).mockClear();

    const result = executeUpdate('npm', { targetVersion: '1.10.0' });

    expect(result.success).toBe(false);
    expect(result.manualUpdate).toBe(true);
    expect(result.error).toContain('https://github.com/developing-today-forks/openchamber/releases/latest');
    expect(result.error).toContain('(v1.10.0)');
    expect(spawnSync).not.toHaveBeenCalled();
  });
});

describe('detectPackageManagerDetails', () => {
  afterEach(() => {
    spawnSync.mockReset();
    vi.unstubAllEnvs();
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

describe('checkForUpdates for the Android app', () => {
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

  const apk = (version) => ({
    name: `OpenChamber-${version}-android.apk`,
    browser_download_url: `https://github.com/developing-today-forks/openchamber/releases/download/v${version}/OpenChamber-${version}-android.apk`,
  });

  it('uses the highest published fork release and its APK, never the upstream API', async () => {
    fetchMock
      .when('releases/tags/v2.3.0', {
        ok: true,
        json: async () => ({ assets: [apk('2.3.0')] }),
      })
      .when('developing-today-forks/openchamber/releases?per_page=30', {
        ok: true,
        json: async () => [
          { tag_name: 'v2.4.0', draft: true, prerelease: false, assets: [] },
          { tag_name: 'v2.3.1-beta.1', draft: false, prerelease: true, assets: [] },
          { tag_name: 'v2.3.0', draft: false, prerelease: false, body: '- fork release', html_url: 'https://github.com/developing-today-forks/openchamber/releases/tag/v2.3.0' },
          { tag_name: 'v2.2.0', draft: false, prerelease: false, assets: [] },
        ],
      });

    const result = await checkForUpdates({ currentVersion: '2.2.0', appType: 'mobile-capacitor', platform: 'android' });

    expect(result.available).toBe(true);
    expect(result.version).toBe('2.3.0');
    expect(result.downloadUrl).toBe('https://github.com/developing-today-forks/openchamber/releases/download/v2.3.0/OpenChamber-2.3.0-android.apk');
    expect(fetchMock.mock.calls.some(([url]) => String(url).includes('api.openchamber.dev'))).toBe(false);
    expect(fetchMock.mock.calls.some(([url]) => String(url).includes('registry.npmjs.org'))).toBe(false);
  });

  it('reports no update and does not fall back to npm when the fork feed is unreachable', async () => {
    fetchMock.when('developing-today-forks/openchamber/releases?per_page=30', { ok: false, status: 503, json: async () => ({}) });

    const result = await checkForUpdates({ currentVersion: '2.2.0', appType: 'mobile-capacitor', platform: 'android' });

    expect(result.available).toBe(false);
    expect(fetchMock.mock.calls.some(([url]) => String(url).includes('registry.npmjs.org'))).toBe(false);
  });
});
