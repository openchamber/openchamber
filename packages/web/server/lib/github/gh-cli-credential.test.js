import { beforeEach, describe, expect, mock, test } from 'bun:test';

const execFileSyncMock = mock(() => '');

mock.module('child_process', () => ({
  execFileSync: execFileSyncMock,
}));

const { clearGhCliTokenCache, getGhCliToken } = await import('./gh-cli-credential.js');

const GH_INVOKE_BASE = {
  encoding: 'utf8',
  stdio: ['pipe', 'pipe', 'pipe'],
  timeout: 5000,
  windowsHide: true,
};

describe('gh CLI credential lookup', () => {
  beforeEach(() => {
    execFileSyncMock.mockReset();
    clearGhCliTokenCache();
  });

  test('uses the default gh account and hides the subprocess window on Windows', () => {
    execFileSyncMock.mockReturnValueOnce('token\n');

    expect(getGhCliToken()).toBe('token');
    const [cmd, args, options] = execFileSyncMock.mock.calls[0];
    expect(cmd).toBe('gh');
    expect(args).toEqual(['auth', 'token']);
    expect(options).toMatchObject(GH_INVOKE_BASE);
  });

  test('pins GH_HOST so a GHE host returns that host token', () => {
    execFileSyncMock.mockReturnValueOnce('ghe-token\n');

    expect(getGhCliToken('github.example.com')).toBe('ghe-token');
    const [, , options] = execFileSyncMock.mock.calls[0];
    expect(options.env.GH_HOST).toBe('github.example.com');
  });

  test('caches each host token separately', () => {
    execFileSyncMock.mockReturnValueOnce('github-token\n');
    execFileSyncMock.mockReturnValueOnce('ghe-token\n');

    expect(getGhCliToken()).toBe('github-token');
    expect(getGhCliToken('github.example.com')).toBe('ghe-token');
    expect(execFileSyncMock).toHaveBeenCalledTimes(2);

    // Within the TTL, each host replays its own cached token without re-running gh.
    expect(getGhCliToken()).toBe('github-token');
    expect(getGhCliToken('github.example.com')).toBe('ghe-token');
    expect(execFileSyncMock).toHaveBeenCalledTimes(2);
  });

  test('caches unavailable gh CLI result until cache is cleared', () => {
    execFileSyncMock.mockImplementation(() => {
      throw new Error('gh unavailable');
    });

    expect(getGhCliToken()).toBeNull();
    expect(getGhCliToken()).toBeNull();
    expect(execFileSyncMock).toHaveBeenCalledTimes(1);

    clearGhCliTokenCache();

    expect(getGhCliToken()).toBeNull();
    expect(execFileSyncMock).toHaveBeenCalledTimes(2);
  });
});
