import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';

// Mock child_process to prevent real spawnSync calls that would hang in tests
vi.mock('node:child_process', () => ({
  spawn: vi.fn(),
  spawnSync: vi.fn(() => ({ status: 0, stdout: '/usr/local/bin', stderr: '' })),
}));

// Mock node:fs so readOsReleaseId doesn't read real /etc/os-release
// and detectPackageManager doesn't touch the real filesystem
vi.mock('node:fs', () => {
  const impl = {
    readFileSync: vi.fn(() => 'ID=linux\n'),
    writeFileSync: vi.fn(),
    mkdirSync: vi.fn(),
    realpathSync: vi.fn((p) => p),
    realpathSyncNative: vi.fn((p) => p),
    existsSync: vi.fn(() => false),
  };
  return {
    default: impl,
    ...impl,
  };
});

const { checkForUpdates, checkNativeToolchain } = await import('./package-manager.js');

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

// ── checkNativeToolchain ────────────────────────────────────────────

describe('checkNativeToolchain', () => {
  let childProcessModule;

  beforeAll(async () => {
    childProcessModule = await import('node:child_process');
  });

  beforeEach(() => {
    vi.mocked(childProcessModule.spawnSync).mockReset();
  });

  function mockCommands(availableCommands) {
    vi.mocked(childProcessModule.spawnSync).mockImplementation((cmd, args) => {
      if (args?.[0] === '--version' && availableCommands.includes(cmd)) {
        return { status: 0, stdout: '1.0.0\n', stderr: '' };
      }
      if (args?.[0] === '--version') {
        return { status: 1, stdout: '', stderr: 'not found' };
      }
      throw new Error(`command not found: ${cmd}`);
    });
  }

  it('returns ok=true when all tools are present on linux', () => {
    mockCommands(['npm', 'make', 'cc', 'c++', 'python3']);

    const result = checkNativeToolchain({ platform: 'linux' });
    expect(result).toEqual({ ok: true });
  });

  it('returns ok=true when gcc substitutes for cc on linux', () => {
    mockCommands(['npm', 'make', 'gcc', 'c++', 'python3']);

    const result = checkNativeToolchain({ platform: 'linux' });
    expect(result).toEqual({ ok: true });
  });

  it('returns ok=true when g++ substitutes for c++ on linux', () => {
    mockCommands(['npm', 'make', 'cc', 'g++', 'python3']);

    const result = checkNativeToolchain({ platform: 'linux' });
    expect(result).toEqual({ ok: true });
  });

  it('returns ok=true when python substitutes for python3 on linux', () => {
    mockCommands(['npm', 'make', 'cc', 'c++', 'python']);

    const result = checkNativeToolchain({ platform: 'linux' });
    expect(result).toEqual({ ok: true });
  });

  it('returns ok=true on windows regardless of tools', () => {
    mockCommands([]);

    const result = checkNativeToolchain({ platform: 'win32' });
    expect(result).toEqual({ ok: true });
  });

  it('returns ok=true on macos when cc is available', () => {
    mockCommands(['make', 'cc', 'c++', 'python3']);

    const result = checkNativeToolchain({ platform: 'darwin' });
    expect(result).toEqual({ ok: true });
  });

  it('reports missing cc when neither cc nor gcc is present', () => {
    mockCommands(['make', 'c++', 'python3']);

    const result = checkNativeToolchain({ platform: 'linux' });
    expect(result.ok).toBe(false);
    expect(result.missing).toContain('cc');
    expect(result.missing).not.toContain('make');
    expect(result.missing).not.toContain('c++');
    expect(result.missing).not.toContain('python3');
    expect(typeof result.instructions).toBe('string');
    expect(result.instructions.length).toBeGreaterThan(0);
  });

  it('reports missing c++ when neither c++ nor g++ is present', () => {
    mockCommands(['make', 'cc', 'python3']);

    const result = checkNativeToolchain({ platform: 'linux' });
    expect(result.ok).toBe(false);
    expect(result.missing).toContain('c++');
  });

  it('reports missing make', () => {
    mockCommands(['cc', 'c++', 'python3']);

    const result = checkNativeToolchain({ platform: 'linux' });
    expect(result.ok).toBe(false);
    expect(result.missing).toContain('make');
  });

  it('reports missing python3 when neither python3 nor python is present', () => {
    mockCommands(['make', 'cc', 'c++']);

    const result = checkNativeToolchain({ platform: 'linux' });
    expect(result.ok).toBe(false);
    expect(result.missing).toContain('python3');
  });

  it('reports multiple missing tools', () => {
    mockCommands(['cc']);

    const result = checkNativeToolchain({ platform: 'linux' });
    expect(result.ok).toBe(false);
    expect(result.missing).toEqual(expect.arrayContaining(['make', 'c++', 'python3']));
    expect(result.missing).not.toContain('cc');
  });

  it('includes macos install instructions on darwin', () => {
    mockCommands([]);

    const result = checkNativeToolchain({ platform: 'darwin' });
    expect(result.ok).toBe(false);
    expect(result.instructions).toContain('xcode-select --install');
  });

  it('includes debian/ubuntu instructions for debian id', async () => {
    mockCommands([]);
    const fs = await import('node:fs');
    const spy = vi.spyOn(fs, 'readFileSync').mockImplementation((filepath) => {
      if (filepath === '/etc/os-release') return 'ID=debian\n';
      return '';
    });

    const result = checkNativeToolchain({ platform: 'linux' });
    expect(result.instructions).toContain('apt-get');
    spy.mockRestore();
  });

  it('includes fedora/rhel instructions for almalinux id', async () => {
    mockCommands([]);
    const fs = await import('node:fs');
    const spy = vi.spyOn(fs, 'readFileSync').mockImplementation((filepath) => {
      if (filepath === '/etc/os-release') return 'ID="almalinux"\n';
      return '';
    });

    const result = checkNativeToolchain({ platform: 'linux' });
    expect(result.instructions).toContain('dnf');
    spy.mockRestore();
  });

  it('includes arch instructions for arch id', async () => {
    mockCommands([]);
    const fs = await import('node:fs');
    const spy = vi.spyOn(fs, 'readFileSync').mockImplementation((filepath) => {
      if (filepath === '/etc/os-release') return 'ID=arch\n';
      return '';
    });

    const result = checkNativeToolchain({ platform: 'linux' });
    expect(result.instructions).toContain('pacman');
    spy.mockRestore();
  });

  it('falls back to generic linux instructions when os-release is unreadable', async () => {
    mockCommands([]);
    const fs = await import('node:fs');
    const spy = vi.spyOn(fs, 'readFileSync').mockImplementation(() => {
      throw new Error('ENOENT');
    });

    const result = checkNativeToolchain({ platform: 'linux' });
    expect(result.instructions).toContain('apt-get');
    expect(result.instructions).toContain('dnf');
    expect(result.instructions).toContain('pacman');
    spy.mockRestore();
  });
});
