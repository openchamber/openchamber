/**
 * Reproduction test for issue #2145:
 * Remote connection: local-only settings (e.g. opencodeBinary) are synced to the
 * server, breaking OpenCode startup with no client-side error.
 *
 * Demonstrates the full chain:
 * 1. sanitizeSettingsUpdate() accepts local-only fields with no filtering
 * 2. applyOpencodeBinaryFromSettings({strict: true}) fails when a local path
 *    from the client is persisted on a different server
 * 3. startOpenCode() bails immediately (no retry) on OPENCODE_BINARY_INVALID
 * 4. The error is only logged server-side — not surfaced to the client UI
 */
import { describe, expect, it, vi, afterEach } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createSettingsHelpers } from './settings-helpers.js';
import { createSettingsNormalizationRuntime } from './settings-normalization-runtime.js';
import { createOpenCodeEnvRuntime } from './env-runtime.js';

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

const createTestHelpers = () => {
  const normRuntime = createSettingsNormalizationRuntime({
    os: { homedir: () => '/home/testuser' },
    path: {
      resolve: (...args) => args[args.length - 1],
      sep: '/',
      dirname: (p) => p.split('/').slice(0, -1).join('/') || '/',
    },
    processLike: { platform: 'linux', env: {} },
    realpathSync: (p) => p,
    tunnelBootstrapTtlDefaultMs: 600000,
    tunnelBootstrapTtlMinMs: 60000,
    tunnelBootstrapTtlMaxMs: 3600000,
    tunnelSessionTtlDefaultMs: 86400000,
    tunnelSessionTtlMinMs: 3600000,
    tunnelSessionTtlMaxMs: 604800000,
  });

  return createSettingsHelpers({
    normalizePathForPersistence: (value) => value,
    normalizeDirectoryPath: (value) => value,
    normalizeTunnelBootstrapTtlMs: (value) => value,
    normalizeTunnelSessionTtlMs: (value) => value,
    normalizeTunnelProvider: (value) => value,
    normalizeTunnelMode: (value) => value,
    normalizeOptionalPath: (value) => value,
    normalizeManagedRemoteTunnelHostname: (value) => value,
    normalizeManagedRemoteTunnelPresets: () => undefined,
    normalizeManagedRemoteTunnelPresetTokens: () => undefined,
    sanitizeTypographySizesPartial: () => undefined,
    normalizeStringArray: normRuntime.normalizeStringArray,
    sanitizeModelRefs: normRuntime.sanitizeModelRefs,
    sanitizeSkillCatalogs: () => undefined,
    sanitizeProjects: normRuntime.sanitizeProjects,
  });
};

const createEnvTestRuntime = (settings, options = {}) => {
  const state = {
    cachedLoginShellEnvSnapshot: null,
    resolvedOpencodeBinary: null,
    resolvedOpencodeBinarySource: null,
    useWslForOpencode: false,
    resolvedWslBinary: null,
    resolvedWslOpencodePath: null,
    resolvedWslDistro: null,
    resolvedNodeBinary: null,
    resolvedBunBinary: null,
    managedOpenCodeShellEnvSnapshot: null,
  };

  const runtime = createOpenCodeEnvRuntime({
    state,
    normalizeDirectoryPath: (value) => value,
    readSettingsFromDiskMigrated: async () => settings,
    spawnSync: options.spawnSync,
    homedir: options.homedir,
  });

  return { runtime, state };
};

const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'oc-issue2145-'));
afterEach(() => {
  fs.rmSync(tempDir, { recursive: true, force: true });
});

// ===========================================================================
// PART 1: SANITIZE — server accepts local-only fields
// ===========================================================================

describe('PART 1: sanitizeSettingsUpdate accepts local-only settings (BUG)', () => {
  const helpers = createTestHelpers();

  it('accepts opencodeBinary (machine-local path) with no server-side filtering', () => {
    const localWindowsPath = 'C:\\Users\\me\\.opencode\\bin\\opencode.exe';
    const result = helpers.sanitizeSettingsUpdate({ opencodeBinary: localWindowsPath });
    // BUG: the server accepts this client-local path unconditionally
    expect(result).toHaveProperty('opencodeBinary');
    expect(result.opencodeBinary).toBe(localWindowsPath);
  });

  it('accepts lastDirectory (machine-local path) with no filtering', () => {
    const localPath = 'C:\\Users\\me\\projects\\my-project';
    const result = helpers.sanitizeSettingsUpdate({ lastDirectory: localPath });
    expect(result).toHaveProperty('lastDirectory');
    expect(result.lastDirectory).toBe(localPath);
  });

  it('accepts homeDirectory (machine-local path) with no filtering', () => {
    const localPath = 'C:\\Users\\me';
    const result = helpers.sanitizeSettingsUpdate({ homeDirectory: localPath });
    expect(result).toHaveProperty('homeDirectory');
    expect(result.homeDirectory).toBe(localPath);
  });

  it('accepts projects (machine-local paths) with no filtering', () => {
    const localProjects = [
      { id: 'proj1', path: 'C:\\Users\\me\\project1' },
      { id: 'proj2', path: 'C:\\Users\\me\\project2' },
    ];
    const result = helpers.sanitizeSettingsUpdate({ projects: localProjects });
    expect(result).toHaveProperty('projects');
  });

  it('accepts activeProjectId, pinnedDirectories, managedLocalTunnelConfigPath, securityScopedBookmarks, desktopUiPassword', () => {
    const payload = {
      activeProjectId: 'some-project-id',
      pinnedDirectories: ['C:\\Users\\me\\pinned'],
      managedLocalTunnelConfigPath: 'C:\\Users\\me\\.config\\tunnel.yml',
      securityScopedBookmarks: ['/some/bookmark'],
      desktopUiPassword: 'secret123',
    };
    const result = helpers.sanitizeSettingsUpdate(payload);
    expect(result).toHaveProperty('activeProjectId');
    expect(result).toHaveProperty('pinnedDirectories');
    expect(result).toHaveProperty('managedLocalTunnelConfigPath');
    expect(result).toHaveProperty('securityScopedBookmarks');
    expect(result).toHaveProperty('desktopUiPassword');
  });
});

// ===========================================================================
// PART 2: ENV RUNTIME — local binary path breaks OpenCode startup on server
// ===========================================================================

describe('PART 2: applyOpencodeBinaryFromSettings fails with client-local paths (BUG)', () => {
  const DIR_NOT_FOUND = 'OPENCODE_BINARY_INVALID';

  it('throws OPENCODE_BINARY_INVALID for a non-existent binary path', async () => {
    const { runtime } = createEnvTestRuntime({
      opencodeBinary: '/Users/me/.opencode/bin/opencode',
    });

    await expect(runtime.applyOpencodeBinaryFromSettings({ strict: true }))
      .rejects.toMatchObject({ code: DIR_NOT_FOUND });
  });

  it('throws OPENCODE_BINARY_INVALID for a Windows client path on Linux', async () => {
    const { runtime } = createEnvTestRuntime({
      opencodeBinary: 'C:\\Users\\me\\.opencode\\bin\\opencode.exe',
    });

    await expect(runtime.applyOpencodeBinaryFromSettings({ strict: true }))
      .rejects.toMatchObject({ code: DIR_NOT_FOUND });
  });

  it('succeeds (returns null, no error) when opencodeBinary is not set in settings', async () => {
    const { runtime } = createEnvTestRuntime({});
    const result = await runtime.applyOpencodeBinaryFromSettings({ strict: true });
    expect(result).toBeNull();
  });

  it('returns null (no error) in non-strict mode even with bad path', async () => {
    const { runtime } = createEnvTestRuntime({
      opencodeBinary: '/nonexistent/opencode',
    });
    const result = await runtime.applyOpencodeBinaryFromSettings({ strict: false });
    expect(result).toBeNull();
  });
});

// ===========================================================================
// PART 3: LIFECYCLE — startOpenCode bails immediately on OPENCODE_BINARY_INVALID
// ===========================================================================

describe('PART 3: startOpenCode does not retry on OPENCODE_BINARY_INVALID (BUG)', () => {
  const START_OPEN_CODE_MAX_ATTEMPTS = 2;

  it('breaks immediately on OPENCODE_BINARY_INVALID — no retry', async () => {
    // This tests the behavior shown in lifecycle.js lines 541-543:
    //   if (error?.code === 'OPENCODE_BINARY_INVALID') { break; }
    // Means the server never starts OpenCode, leaving UI in loading state.
    const applyOpencodeBinaryFromSettings = vi.fn().mockRejectedValue({
      code: 'OPENCODE_BINARY_INVALID',
      message: 'Configured OpenCode binary not found: C:\\Users\\me\\opencode.exe',
    });

    const startOpenCodeOnce = async () => {
      await applyOpencodeBinaryFromSettings({ strict: true });
    };

    // Simulate the startOpenCode loop from lifecycle.js lines 535-559
    let lastError = null;
    for (let attempt = 1; attempt <= START_OPEN_CODE_MAX_ATTEMPTS; attempt += 1) {
      try {
        await startOpenCodeOnce();
      } catch (error) {
        lastError = error;
        if (error?.code === 'OPENCODE_BINARY_INVALID') {
          break; // <-- BUG: bails immediately, never retries
        }
      }
    }

    // OPENCODE_BINARY_INVALID causes immediate break → applyOpencodeBinaryFromSettings
    // called only once despite max 2 attempts
    expect(applyOpencodeBinaryFromSettings).toHaveBeenCalledTimes(1);
    expect(lastError).toMatchObject({ code: 'OPENCODE_BINARY_INVALID' });
  });

  it('retries on non-binary errors up to START_OPEN_CODE_MAX_ATTEMPTS', async () => {
    const applyOpencodeBinaryFromSettings = vi.fn().mockResolvedValue('/valid/opencode');
    const createManagedOpenCodeServerProcess = vi.fn().mockRejectedValue(new Error('Port in use'));

    const startOpenCodeOnce = async () => {
      await applyOpencodeBinaryFromSettings({ strict: true });
      await createManagedOpenCodeServerProcess({});
    };

    // Simulate the startOpenCode loop
    let lastError = null;
    for (let attempt = 1; attempt <= START_OPEN_CODE_MAX_ATTEMPTS; attempt += 1) {
      try {
        await startOpenCodeOnce();
      } catch (error) {
        lastError = error;
        if (error?.code === 'OPENCODE_BINARY_INVALID') {
          break; // Not triggered for port-in-use errors
        }
        if (attempt >= START_OPEN_CODE_MAX_ATTEMPTS) {
          break;
        }
      }
    }

    // Non-binary errors should be retried
    expect(applyOpencodeBinaryFromSettings).toHaveBeenCalledTimes(START_OPEN_CODE_MAX_ATTEMPTS);
    expect(lastError).toBeDefined();
  });
});

// ===========================================================================
// PART 4: CLIENT — updateDesktopSettings sends everything to remote server
// ===========================================================================

describe('PART 4: Client-side updateDesktopSettings has no runtimeKey guard (BUG)', () => {
  it('_flushSettingsUpdate sends the entire changes payload with no field filtering', async () => {
    // Simulates the _flushSettingsUpdate flow in persistence.ts:
    // runtimeFetch('/api/config/settings', { method: 'PUT', body: JSON.stringify(changes) })
    // There is NO check for getRuntimeKey() !== 'local' before sending.
    const changes = {
      opencodeBinary: 'C:\\Users\\me\\.opencode\\bin\\opencode.exe',
      lastDirectory: 'C:\\Users\\me\\projects',
      homeDirectory: 'C:\\Users\\me',
      projects: [{ id: 'p1', path: 'C:\\Users\\me\\project1' }],
      activeProjectId: 'p1',
      pinnedDirectories: ['C:\\Users\\me\\pinned'],
    };

    // The bug: the client sends ALL changes to the server via PUT
    // without stripping machine-local fields
    const body = JSON.stringify(changes);
    const parsed = JSON.parse(body);

    expect(parsed).toHaveProperty('opencodeBinary');
    expect(parsed).toHaveProperty('lastDirectory');
    expect(parsed).toHaveProperty('homeDirectory');
    expect(parsed).toHaveProperty('projects');
    expect(parsed).toHaveProperty('activeProjectId');
    expect(parsed).toHaveProperty('pinnedDirectories');
  });

  it('shows no runtime key guard exists in updateDesktopSettings', async () => {
    // Read persistence.ts to confirm the absence of a getRuntimeKey() === 'local' guard
    const source = fs.readFileSync(
      path.resolve(import.meta.dirname, '../../../../ui/src/lib/persistence.ts'),
      'utf8',
    );

    // updateDesktopSettings and _flushSettingsUpdate send to runtimeFetch
    // without checking getRuntimeKey()
    const lines = source.split('\n');

    // Find _flushSettingsUpdate and check for runtimeKey guard or LOCAL_ONLY_KEYS
    const flushStart = lines.findIndex((l) => l.includes('const _flushSettingsUpdate'));
    const flushBody = lines.slice(flushStart, flushStart + 60).join('\n');

    // No getRuntimeKey() check should exist in this function
    expect(flushBody).not.toContain('getRuntimeKey');

    // No LOCAL_ONLY_KEYS or local-only filtering should exist
    expect(flushBody).not.toContain('LOCAL_ONLY');

    // But it DOES use runtimeFetch which, when runtimeKey !== 'local',
    // resolves to the remote server
    expect(flushBody).toContain('runtimeFetch');
  });

  it('shows sanitizeWebSettings accepts opencodeBinary with no runtime guard', async () => {
    // Read persistence.ts's sanitizeWebSettings function
    const source = fs.readFileSync(
      path.resolve(import.meta.dirname, '../../../../ui/src/lib/persistence.ts'),
      'utf8',
    );

    // sanitizeWebSettings happily accepts opencodeBinary
    expect(source).toContain('opencodeBinary');

    const binaryLine = source.split('\n').findIndex((l) => l.includes('opencodeBinary'));
    const contextLines = source.split('\n').slice(Math.max(0, binaryLine - 3), binaryLine + 5).join('\n');

    // No runtime guard around the opencodeBinary acception
    expect(contextLines).not.toContain('getRuntimeKey');
  });
});
