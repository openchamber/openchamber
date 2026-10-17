import { beforeEach, describe, expect, mock, test } from 'bun:test';

const execFileSyncMock = mock(() => '');

mock.module('child_process', () => ({
  execFileSync: execFileSyncMock,
}));

const { getGhCliToken } = await import('./gh-cli-credential.js');

const GH_INVOKE_BASE = {
  encoding: 'utf8',
  stdio: ['pipe', 'pipe', 'pipe'],
  timeout: 5000,
  windowsHide: true,
};

describe('gh CLI credential lookup', () => {
  beforeEach(() => {
    execFileSyncMock.mockReset();
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

  test('reroutes each host through its own gh invocation', () => {
    execFileSyncMock
      .mockReturnValueOnce('github-token\n')
      .mockReturnValueOnce('ghe-token\n')
      .mockReturnValueOnce('github-token\n')
      .mockReturnValueOnce('ghe-token\n');

    expect(getGhCliToken()).toBe('github-token');
    expect(getGhCliToken('github.example.com')).toBe('ghe-token');

    // The default github.com caller and the enterprise host each get their own
    // token, passed through the expected per-host invocation shape.
    const [, , githubOptions] = execFileSyncMock.mock.calls[0];
    const [, , gheOptions] = execFileSyncMock.mock.calls[1];
    expect(githubOptions.env.GH_HOST).toBe('github.com');
    expect(gheOptions.env.GH_HOST).toBe('github.example.com');

    // Tokens are not cached: a second round re-runs gh and again returns each
    // host its own token.
    expect(getGhCliToken()).toBe('github-token');
    expect(getGhCliToken('github.example.com')).toBe('ghe-token');
    expect(execFileSyncMock).toHaveBeenCalledTimes(4);
  });

  test('rechecks unavailable gh CLI authentication on every operation', () => {
    execFileSyncMock.mockImplementation(() => {
      throw new Error('gh unavailable');
    });

    expect(getGhCliToken()).toBeNull();
    expect(getGhCliToken()).toBeNull();
    expect(execFileSyncMock).toHaveBeenCalledTimes(2);
  });
});
