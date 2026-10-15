import { describe, expect, it, vi } from 'vitest';
import { join } from 'node:path';
import { chmodSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { resolveCliAuth } from './cli-credentials.js';
import { DEFAULT_PROJECT_ID, resolveAntigravityAuth } from './auth.js';
import { fetchQuota } from './index.js';

const credential = (auth_method = 'consumer') => JSON.stringify({ auth_method, token: { refresh_token: 'synthetic-refresh' } });
const cliAuth = { sourceId: 'antigravity-cli', refreshToken: 'synthetic-refresh' };

describe('Antigravity CLI credentials', () => {
  it.each(['consumer', 'oauth-personal', undefined])('accepts personal auth method %s', (method) => {
    const raw = method === undefined ? JSON.stringify({ token: { refresh_token: 'synthetic-refresh' } }) : credential(method);
    expect(resolveCliAuth({ platform: 'linux', readFile: () => raw })?.refreshToken).toBe('synthetic-refresh');
  });

  it.each(['', '{sensitive malformed JSON', 'null', '[]', '{}', '{"token":{"refresh_token":" "}}', credential('service-account'), credential('wif')])('rejects invalid or non-personal credentials without logging', (raw) => {
    const warn = vi.spyOn(console, 'warn');
    try {
      expect(resolveCliAuth({ platform: 'linux', readFile: () => raw })).toBeNull();
      expect(warn).not.toHaveBeenCalled();
    } finally { warn.mockRestore(); }
  });

  it('treats missing or unreadable files as unconfigured', () => {
    expect(resolveCliAuth({ platform: 'linux', readFile: () => { throw new Error('sensitive read error'); } })).toBeNull();
  });

  it.each([
    [{ HOME: '/custom' }, join('/custom', '.gemini')],
    [{ HOME: '/custom', GEMINI_HOME: '/gemini' }, '/gemini'],
    [{ HOME: ' ', GEMINI_HOME: ' ' }, join('/native', '.gemini')]
  ])('respects home overrides %j', (env, expectedHome) => {
    const readFile = vi.fn(() => credential());
    resolveCliAuth({ env, nativeHome: '/native', platform: 'linux', readFile });
    expect(readFile).toHaveBeenCalledWith(join(expectedHome, 'antigravity-cli', 'antigravity-oauth-token'), 'utf8');
  });

  it('uses only the native Windows credential when present', () => {
    const readFile = vi.fn(() => credential());
    const readKeyring = vi.fn(() => credential('wif'));
    expect(resolveCliAuth({ env: {}, nativeHome: '/native', platform: 'win32', readFile, readKeyring })).toBeNull();
    expect(readKeyring).toHaveBeenCalledOnce();
    expect(readFile).not.toHaveBeenCalled();
    expect(resolveCliAuth({ env: {}, nativeHome: '/native', platform: 'win32', readFile, readKeyring: () => credential() })?.refreshToken).toBe('synthetic-refresh');
  });

  it('falls back to the file for an absent native credential', () => {
    expect(resolveCliAuth({ env: {}, nativeHome: '/native', platform: 'win32', readFile: () => credential(), readKeyring: () => undefined })?.refreshToken).toBe('synthetic-refresh');
  });

  it.each([{ HOME: '/custom' }, { GEMINI_HOME: '/custom' }, { HOME: '/custom', GEMINI_HOME: '/native/.gemini' }])('does not borrow native credentials with overrides %j', (env) => {
    const readKeyring = vi.fn();
    resolveCliAuth({ env, nativeHome: '/native', platform: 'win32', readFile: () => credential(), readKeyring });
    expect(readKeyring).not.toHaveBeenCalled();
  });
});

// POSIX can execute a synthetic .exe script at the exact PowerShell path.
// This exercises execFileSync and output decoding without reading a real login.
describe.skipIf(process.platform === 'win32')('Windows credential subprocess protocol', () => {
  const withNativeOutput = (output, status, check) => {
    const root = mkdtempSync(join(tmpdir(), 'agy-native-reader-'));
    try {
      const directory = join(root, 'System32', 'WindowsPowerShell', 'v1.0');
      mkdirSync(directory, { recursive: true });
      const executable = join(directory, 'powershell.exe');
      writeFileSync(executable, `#!${process.execPath}\nprocess.stdout.write(${JSON.stringify(output)}); process.exit(${status});\n`);
      chmodSync(executable, 0o700);
      const readFile = vi.fn(() => credential());
      const auth = resolveCliAuth({ env: { SystemRoot: root }, nativeHome: root, platform: 'win32', readFile });
      check(auth, readFile);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  };

  it('uses a valid native personal login without reading the file', () => {
    withNativeOutput(`credential:${Buffer.from(credential()).toString('base64')}`, 0, (auth, readFile) => {
      expect(auth?.refreshToken).toBe('synthetic-refresh');
      expect(readFile).not.toHaveBeenCalled();
    });
  });

  it('allows disk fallback only for confirmed native absence', () => {
    withNativeOutput('absent', 0, (auth, readFile) => {
      expect(auth?.refreshToken).toBe('synthetic-refresh');
      expect(readFile).toHaveBeenCalledOnce();
    });
  });

  it.each([
    ['empty output', '', 0],
    ['empty blob', 'credential:', 0],
    ['oversized blob', `credential:${Buffer.alloc(2561).toString('base64')}`, 0],
    ['invalid UTF-8', `credential:${Buffer.from([0xff]).toString('base64')}`, 0],
    ['malformed base64', 'credential:@@@', 0],
    ['malformed JSON', `credential:${Buffer.from('{synthetic-invalid').toString('base64')}`, 0],
    ['non-consumer login', `credential:${Buffer.from(credential('wif')).toString('base64')}`, 0],
    ['native size or read error', '', 2],
    ['failed process with absence output', 'absent', 2]
  ])('fails closed for %s without reading a different disk login', (_label, output, status) => {
    withNativeOutput(output, status, (auth, readFile) => {
      expect(auth).toBeNull();
      expect(readFile).not.toHaveBeenCalled();
    });
  });

  it('fails closed when PowerShell cannot start or SystemRoot is unavailable', () => {
    const readFile = vi.fn(() => credential());
    for (const env of [{}, { SystemRoot: '/nonexistent-agy-synthetic-system-root' }]) {
      expect(resolveCliAuth({ env, nativeHome: '/native', platform: 'win32', readFile })).toBeNull();
    }
    expect(readFile).not.toHaveBeenCalled();
  });
});

describe('Antigravity source precedence', () => {
  it('keeps the selected accounts-file login ahead of the CLI', () => {
    const readCliAuth = vi.fn(() => cliAuth);
    const auth = resolveAntigravityAuth({ accountPaths: ['accounts'], readAccounts: () => ({ activeIndex: 1, accounts: [{ refreshToken: 'first' }, { refreshToken: 'selected', projectId: 'existing-project' }] }), readCliAuth });
    expect(auth).toMatchObject({ sourceId: 'antigravity', refreshToken: 'selected', projectId: 'existing-project' });
    expect(readCliAuth).not.toHaveBeenCalled();
  });

  it('reads all account locations before falling back', () => {
    const readCliAuth = vi.fn(() => cliAuth);
    const readAccounts = vi.fn((path) => path === 'second' ? { accounts: [{ refreshToken: 'existing' }] } : null);
    expect(resolveAntigravityAuth({ accountPaths: ['first', 'second'], readAccounts, readCliAuth })?.refreshToken).toBe('existing');
    expect(readCliAuth).not.toHaveBeenCalled();
    expect(resolveAntigravityAuth({ accountPaths: ['first'], readAccounts, readCliAuth })).toBe(cliAuth);
  });
});

describe('Antigravity quota fallback behavior', () => {
  const dependencies = (auth = cliAuth) => ({ resolveAuth: () => auth, refreshToken: async () => 'synthetic-access', fetchSummary: vi.fn(async () => null), fetchModels: vi.fn(async () => null) });

  it('keeps missing credentials distinct from refresh failures', async () => {
    const missing = dependencies(null);
    const refreshToken = vi.fn();
    expect(await fetchQuota({ ...missing, refreshToken })).toMatchObject({ ok: false, configured: false });
    expect(refreshToken).not.toHaveBeenCalled();
    const failed = dependencies();
    expect(await fetchQuota({ ...failed, refreshToken: async () => null })).toMatchObject({ ok: false, configured: true, error: 'Failed to refresh Antigravity token' });
    expect(failed.fetchSummary).not.toHaveBeenCalled();
  });

  it.each([
    [cliAuth, undefined],
    [{ ...cliAuth, projectId: 'explicit-project' }, 'explicit-project'],
    [{ sourceId: 'antigravity', refreshToken: 'existing' }, DEFAULT_PROJECT_ID]
  ])('uses the source-specific project and fails on empty quota', async (auth, project) => {
    const deps = dependencies(auth);
    expect(await fetchQuota(deps)).toMatchObject({ ok: false, configured: true, error: 'Failed to fetch Antigravity quota' });
    expect(deps.fetchModels).toHaveBeenCalledWith('synthetic-access', project);
    expect(deps.fetchSummary).toHaveBeenCalledWith('synthetic-access', project);
  });

  it('returns live account-scoped limits through the existing result contract', async () => {
    const deps = dependencies();
    const result = await fetchQuota({
      ...deps,
      fetchSummary: async () => ({ groups: [{ displayName: 'Gemini Models', buckets: [{ window: 'weekly', remainingFraction: 0.4 }] }] }),
      fetchModels: async () => ({ models: { 'gemini-test': {} } })
    });
    expect(result).toMatchObject({ ok: true, configured: true, providerId: 'antigravity', usage: { windows: {}, models: { 'gemini-test': { windows: { weekly: { remainingPercent: 40, usedPercent: 60 } } } } } });
    expect(JSON.stringify(result)).not.toContain('synthetic');
  });
});
