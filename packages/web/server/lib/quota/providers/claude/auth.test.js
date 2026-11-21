import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import os from 'os';
import path from 'path';

const execFileSync = vi.fn();
const files = new Map();
const openCodeAuth = vi.fn(() => ({}));

vi.mock('child_process', () => ({ execFileSync: (...args) => execFileSync(...args) }));

vi.mock('fs', () => {
  const fs = {
    existsSync: (filePath) => files.has(filePath),
    readFileSync: (filePath) => {
      if (!files.has(filePath)) throw new Error('ENOENT');
      return files.get(filePath);
    },
  };
  return { ...fs, default: fs };
});

vi.mock('../../../opencode/auth.js', () => ({ readOpenCodeCredentials: async () => openCodeAuth() }));

import { configureClaudeCredentialEnvironment, findClaudeCredential, loadClaudeCredential, readClaudeCredentialContext } from './auth.js';

const claudeCodeBlob = (accessToken) => JSON.stringify({
  mcpOAuth: { 'linear|abc': { accessToken: 'unrelated-mcp-token' } },
  claudeAiOauth: {
    accessToken,
    refreshToken: `${accessToken}-refresh`,
    expiresAt: 1786735755912,
    subscriptionType: 'max',
  },
});

const withPlatform = (platform, run) => {
  const original = Object.getOwnPropertyDescriptor(process, 'platform');
  Object.defineProperty(process, 'platform', { value: platform, configurable: true });
  try {
    return run();
  } finally {
    Object.defineProperty(process, 'platform', original);
  }
};

beforeEach(() => {
  files.clear();
  execFileSync.mockReset();
  execFileSync.mockImplementation(() => { throw new Error('no keychain entry'); });
  openCodeAuth.mockReturnValue({});
  vi.stubEnv('CLAUDE_CONFIG_DIR', undefined);
  vi.stubEnv('CLAUDE_CODE_OAUTH_TOKEN', undefined);
});

afterEach(() => {
  vi.unstubAllEnvs();
  configureClaudeCredentialEnvironment(() => process.env);
});

const findLocal = () => findClaudeCredential(openCodeAuth());

describe('Claude credential discovery', () => {
  it('prefers the macOS Keychain over a stale credentials file', () => {
    execFileSync.mockReturnValue(claudeCodeBlob('keychain-token'));
    files.set(path.join(os.homedir(), '.claude', '.credentials.json'), claudeCodeBlob('file-token'));

    const credential = withPlatform('darwin', findLocal);

    expect(credential.accessToken).toBe('keychain-token');
    expect(credential.refreshToken).toBe('keychain-token-refresh');
    expect(credential.planLabel).toBe('max');
    expect(credential.source).toBe('keychain');
  });

  it('reads the credentials file on Linux, where there is no Keychain', () => {
    files.set(path.join(os.homedir(), '.claude', '.credentials.json'), claudeCodeBlob('file-token'));

    const credential = withPlatform('linux', findLocal);

    expect(execFileSync).not.toHaveBeenCalled();
    expect(credential.accessToken).toBe('file-token');
    expect(credential.source).toBe('credentials-file');
  });

  it('honours CLAUDE_CONFIG_DIR when locating the credentials file', () => {
    process.env.CLAUDE_CONFIG_DIR = '/tmp/claude-home';
    files.set(path.join(path.resolve('/tmp/claude-home'), '.credentials.json'), claudeCodeBlob('custom-dir-token'));

    expect(withPlatform('linux', findLocal).accessToken).toBe('custom-dir-token');
  });

  it('reads the custom home Keychain service, using the exact override string', () => {
    // Verified with Claude Code 2.1.325: the trailing slash is part of the hash.
    process.env.CLAUDE_CONFIG_DIR = '/custom/claude';
    execFileSync.mockReturnValue(claudeCodeBlob('selected-token'));
    expect(withPlatform('darwin', findLocal).accessToken).toBe('selected-token');
    expect(execFileSync.mock.calls[0][1]).toEqual(['find-generic-password', '-s', 'Claude Code-credentials-7427f042', '-w']);

    process.env.CLAUDE_CONFIG_DIR += '/';
    withPlatform('darwin', findLocal);
    expect(execFileSync.mock.calls[1][1][2]).toBe('Claude Code-credentials-801f8946');
  });

  it('uses the injected home live for both discovery paths and sanitizes reader failures', async () => {
    let configDir = '/first';
    configureClaudeCredentialEnvironment(() => ({ CLAUDE_CONFIG_DIR: configDir }));
    files.set('/first/.credentials.json', claudeCodeBlob('first-token'));
    files.set('/second/.credentials.json', claudeCodeBlob('second-token'));
    expect(withPlatform('linux', findLocal).accessToken).toBe('first-token');
    configDir = '/second';
    expect((await loadClaudeCredential()).accessToken).toBe('second-token');
    configureClaudeCredentialEnvironment(() => { throw new Error('private value'); });
    expect(readClaudeCredentialContext()).toEqual({ configDir: null, error: 'Cannot read Claude usage environment settings.' });
    expect(findLocal()).toBeNull();
    expect(await loadClaudeCredential()).toBeNull();
  });

  it('uses the selected home file after an unreadable or malformed Keychain entry', () => {
    process.env.CLAUDE_CONFIG_DIR = '/custom/claude';
    files.set('/custom/claude/.credentials.json', claudeCodeBlob('selected-file'));
    expect(withPlatform('darwin', findLocal).accessToken).toBe('selected-file');
    execFileSync.mockReturnValue('{"mcpOAuth":{}}');
    expect(withPlatform('darwin', findLocal).accessToken).toBe('selected-file');
    files.clear();
    expect(withPlatform('darwin', findLocal)).toBeNull();
  });

  it('never substitutes another account when an explicit home has no credential', async () => {
    process.env.CLAUDE_CONFIG_DIR = '/missing/claude-home';
    process.env.CLAUDE_CODE_OAUTH_TOKEN = 'other-env-token';
    openCodeAuth.mockReturnValue({ anthropic: { access: 'other-opencode-token' } });
    execFileSync.mockImplementation((_command, args) => {
      if (args[2] === 'Claude Code-credentials') return claudeCodeBlob('default-token');
      throw new Error('missing selected entry');
    });

    expect(withPlatform('darwin', findLocal)).toBeNull();
    openCodeAuth.mockClear();
    expect(await loadClaudeCredential()).toBeNull();
    expect(openCodeAuth).not.toHaveBeenCalled();
    expect(execFileSync.mock.calls.every(([, args]) => args[2] !== 'Claude Code-credentials')).toBe(true);
  });

  it('falls back to the OpenCode auth entry when Claude Code is not signed in', () => {
    openCodeAuth.mockReturnValue({ anthropic: { access: 'opencode-token', refresh: 'opencode-refresh', expires: 1786735755912 } });

    const credential = withPlatform('linux', findLocal);

    expect(credential.accessToken).toBe('opencode-token');
    expect(credential.source).toBe('opencode-auth');
    expect(credential.planLabel).toBeNull();
  });

  it('falls back to CLAUDE_CODE_OAUTH_TOKEN last, without a refresh token', () => {
    process.env.CLAUDE_CODE_OAUTH_TOKEN = 'env-token';

    const credential = withPlatform('linux', findLocal);

    expect(credential.accessToken).toBe('env-token');
    expect(credential.refreshToken).toBeNull();
    expect(credential.source).toBe('env');
  });

  it('ignores a Keychain blob that only holds unrelated MCP tokens', () => {
    execFileSync.mockReturnValue(JSON.stringify({ mcpOAuth: { 'linear|abc': { accessToken: 'unrelated' } } }));

    expect(withPlatform('darwin', findLocal)).toBeNull();
  });

  it('returns null when every source is empty', () => {
    expect(withPlatform('darwin', findLocal)).toBeNull();
  });

  it('asks OpenCode only when the local Claude Code sources are empty', async () => {
    openCodeAuth.mockClear();
    openCodeAuth.mockReturnValue({ anthropic: { access: 'opencode-token', refresh: 'opencode-refresh', expires: 1 } });
    files.set(path.join(os.homedir(), '.claude', '.credentials.json'), claudeCodeBlob('file-token'));
    expect((await withPlatform('linux', loadClaudeCredential)).source).toBe('credentials-file');
    expect(openCodeAuth).not.toHaveBeenCalled();

    files.clear();
    expect((await withPlatform('linux', loadClaudeCredential)).source).toBe('opencode-auth');
  });
});
