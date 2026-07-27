import { describe, expect, it } from 'bun:test';
import {
  extractClaudeOAuthAccessToken,
  extractClaudeOAuthCredentials,
  hasClaudeCliOAuthCredentials,
  listClaudeCredentialsCandidates,
  readClaudeCliOAuthAccessToken,
  readClaudeCliOAuthCredentials,
  readClaudeCodeOAuthTokenFromEnv,
} from './claude-cli-auth.js';

describe('claude-cli-auth', () => {
  it('extracts camelCase claudeAiOauth accessToken', () => {
    expect(extractClaudeOAuthAccessToken({
      claudeAiOauth: { accessToken: ' sk-ant-oat01-test ' },
    })).toBe('sk-ant-oat01-test');
  });

  it('extracts snake_case claude_ai_oauth access_token', () => {
    expect(extractClaudeOAuthAccessToken({
      claude_ai_oauth: { access_token: 'sk-ant-oat01-snake' },
    })).toBe('sk-ant-oat01-snake');
  });

  it('extracts refresh token and expiry with access token', () => {
    expect(extractClaudeOAuthCredentials({
      claudeAiOauth: {
        accessToken: 'access',
        refreshToken: 'refresh',
        expiresAt: 1_700_000_000_000,
      },
    })).toEqual({
      accessToken: 'access',
      refreshToken: 'refresh',
      expiresAt: 1_700_000_000_000,
    });
  });

  it('returns null for empty or missing oauth blocks', () => {
    expect(extractClaudeOAuthAccessToken(null)).toBeNull();
    expect(extractClaudeOAuthAccessToken({})).toBeNull();
    expect(extractClaudeOAuthAccessToken({ claudeAiOauth: { accessToken: '  ' } })).toBeNull();
  });

  it('prefers CLAUDE_CODE_OAUTH_TOKEN over credentials files', () => {
    expect(readClaudeCodeOAuthTokenFromEnv({ CLAUDE_CODE_OAUTH_TOKEN: ' env-token ' })).toBe('env-token');
    expect(readClaudeCliOAuthAccessToken({
      env: { CLAUDE_CODE_OAUTH_TOKEN: 'env-token' },
      homeDir: '/home/u',
      existsSync: () => true,
      readFile: () => JSON.stringify({ claudeAiOauth: { accessToken: 'file-token' } }),
    })).toBe('env-token');
    expect(readClaudeCliOAuthCredentials({
      env: { CLAUDE_CODE_OAUTH_TOKEN: 'env-token' },
      homeDir: '/home/u',
      existsSync: () => true,
      readFile: () => JSON.stringify({ claudeAiOauth: { accessToken: 'file-token' } }),
    })).toMatchObject({
      accessToken: 'env-token',
      source: 'env',
      refreshToken: null,
    });
  });

  it('includes CLAUDE_CONFIG_DIR candidates first', () => {
    const candidates = listClaudeCredentialsCandidates('/home/u', {
      CLAUDE_CONFIG_DIR: '/custom/claude',
    });
    expect(candidates[0]).toBe('/custom/claude/.credentials.json');
    expect(candidates).toContain('/home/u/.claude/.credentials.json');
  });

  it('reads the first valid credentials candidate via injectable FS', () => {
    const homeDir = '/home/u';
    const primary = listClaudeCredentialsCandidates(homeDir, {})[0];
    const files = new Map([
      [primary, JSON.stringify({
        claudeAiOauth: { accessToken: 'cli-token' },
      })],
    ]);

    expect(readClaudeCliOAuthAccessToken({
      homeDir,
      env: {},
      existsSync: (filePath) => files.has(filePath),
      readFile: (filePath) => {
        const value = files.get(filePath);
        if (value == null) throw Object.assign(new Error('ENOENT'), { code: 'ENOENT' });
        return value;
      },
    })).toBe('cli-token');

    expect(hasClaudeCliOAuthCredentials({
      homeDir,
      env: {},
      existsSync: () => false,
      readFile: () => '',
    })).toBe(false);
  });

  it('skips malformed credentials and continues to the next candidate', () => {
    const homeDir = '/home/u';
    const [first, second] = listClaudeCredentialsCandidates(homeDir, {});
    const files = new Map([
      [first, '{not-json'],
      [second, JSON.stringify({ claudeAiOauth: { accessToken: 'second-token' } })],
    ]);

    expect(readClaudeCliOAuthAccessToken({
      homeDir,
      env: {},
      existsSync: (filePath) => files.has(filePath),
      readFile: (filePath) => files.get(filePath) ?? '',
    })).toBe('second-token');
  });
});
