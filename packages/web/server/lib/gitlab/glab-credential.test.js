import { afterEach, describe, expect, it, vi } from 'vitest';
import { getGlabToken } from './glab-credential.js';

afterEach(() => vi.restoreAllMocks());

const exitError = (fields) => Object.assign(new Error('Command failed: glab'), fields);

describe('glab credential lookup', () => {
  it('reads the stored token for the exact instance host without a shell', async () => {
    const execFile = vi.fn(async () => ({ stdout: 'cli-token\n', stderr: '' }));
    await expect(getGlabToken('https://gitlab.example.com:8443', { execFile, timeoutMs: 1234 })).resolves.toBe('cli-token');
    expect(execFile).toHaveBeenCalledTimes(1);
    expect(execFile).toHaveBeenCalledWith('glab', ['config', 'get', 'token', '--host', 'gitlab.example.com:8443'], {
      encoding: 'utf8', timeout: 1234, windowsHide: true,
    });
  });

  it('falls back to auth status for keyring and environment tokens', async () => {
    const execFile = vi.fn()
      .mockResolvedValueOnce({ stdout: '\n', stderr: '' })
      .mockRejectedValueOnce(exitError({
        code: 1, stdout: '',
        stderr: 'gitlab.example.com\n  ✓ Logged in to gitlab.example.com as me\n  ✓ Token: glpat-keyring\n  x API check failed\n',
      }));
    await expect(getGlabToken('https://gitlab.example.com', { execFile })).resolves.toBe('glpat-keyring');
    expect(execFile).toHaveBeenLastCalledWith('glab', ['auth', 'status', '--hostname', 'gitlab.example.com', '--show-token'], expect.any(Object));
  });

  it('treats a masked or missing token as no login', async () => {
    const execFile = vi.fn()
      .mockResolvedValueOnce({ stdout: '' })
      .mockResolvedValueOnce({ stdout: '', stderr: '  ✓ Token: **************\n' });
    await expect(getGlabToken('https://gitlab.com', { execFile })).resolves.toBeNull();
  });

  it('stays quiet when glab is missing and never logs command output', async () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    const missing = vi.fn(async () => { throw exitError({ code: 'ENOENT' }); });
    await expect(getGlabToken('https://gitlab.com', { execFile: missing })).resolves.toBeNull();
    expect(warn).not.toHaveBeenCalled();

    const hung = vi.fn(async () => { throw exitError({ killed: true, signal: 'SIGTERM', stderr: 'Token: secret-token' }); });
    await expect(getGlabToken('https://gitlab.com', { execFile: hung })).resolves.toBe('secret-token');
    const silent = vi.fn(async () => { throw exitError({ killed: true, signal: 'SIGTERM', stderr: 'secret stderr' }); });
    await expect(getGlabToken('https://gitlab.com', { execFile: silent })).resolves.toBeNull();
    expect(warn).toHaveBeenCalledWith('[gitlab] glab credential lookup failed (timeout)');
    expect(JSON.stringify(warn.mock.calls)).not.toContain('secret');
  });
});
