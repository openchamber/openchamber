import { describe, expect, it, vi } from 'vitest';
import { getGlabToken } from './glab-credential.js';

describe('glab credential lookup', () => {
  it('scopes lookup to the instance host without a shell', async () => {
    const execFile = vi.fn(async () => ({ stdout: 'cli-token\n' }));
    await expect(getGlabToken('https://gitlab.example.com:8443', { execFile, timeoutMs: 1234 })).resolves.toBe('cli-token');
    expect(execFile).toHaveBeenCalledWith('glab', ['auth', 'token', '--hostname', 'gitlab.example.com:8443'], {
      encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'], timeout: 1234, windowsHide: true,
    });
  });

  it('returns null without exposing failed command output', async () => {
    await expect(getGlabToken('https://gitlab.com', { execFile: async () => { throw new Error('secret stderr'); } })).resolves.toBeNull();
  });
});
