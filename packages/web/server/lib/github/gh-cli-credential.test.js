import { beforeEach, describe, expect, mock, test } from 'bun:test';

// The real `child_process.execFile` is callback-based, so the mock must invoke
// its callback: promisify(execFile) settles through the callback, and an async
// mock would never call it (bun's promisify hangs on a promise-returning fn).
// mockReset() also clears the implementation, so beforeEach re-applies it.
const execFileMock = mock((_cmd, _args, _options, callback) => callback(null, { stdout: 'token\n' }));

mock.module('child_process', () => ({
  execFile: execFileMock,
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
    execFileMock.mockReset();
    execFileMock.mockImplementation((_cmd, _args, _options, callback) => callback(null, { stdout: 'token\n' }));
  });

  test('uses the default gh account and hides the subprocess window on Windows', async () => {
    expect(await getGhCliToken()).toBe('token');
    const [cmd, args, options] = execFileMock.mock.calls[0];
    expect(cmd).toBe('gh');
    expect(args).toEqual(['auth', 'token']);
    expect(options).toMatchObject({ ...GH_INVOKE_BASE, env: { GH_HOST: 'github.com' } });
  });

  test('pins GH_HOST so a GHE host returns that host token', async () => {
    execFileMock.mockImplementationOnce((_cmd, _args, _options, callback) => callback(null, { stdout: 'ghe-token\n' }));

    expect(await getGhCliToken('github.example.com')).toBe('ghe-token');
    const [, , options] = execFileMock.mock.calls[0];
    expect(options.env.GH_HOST).toBe('github.example.com');
  });

  test('reroutes each host through its own gh invocation', async () => {
    execFileMock
      .mockImplementationOnce((_cmd, _args, _options, callback) => callback(null, { stdout: 'github-token\n' }))
      .mockImplementationOnce((_cmd, _args, _options, callback) => callback(null, { stdout: 'ghe-token\n' }))
      .mockImplementationOnce((_cmd, _args, _options, callback) => callback(null, { stdout: 'github-token\n' }))
      .mockImplementationOnce((_cmd, _args, _options, callback) => callback(null, { stdout: 'ghe-token\n' }));

    expect(await getGhCliToken()).toBe('github-token');
    expect(await getGhCliToken('github.example.com')).toBe('ghe-token');

    // The default github.com caller and the enterprise host each get their own
    // token, passed through the expected per-host invocation shape.
    const [, , githubOptions] = execFileMock.mock.calls[0];
    const [, , gheOptions] = execFileMock.mock.calls[1];
    expect(githubOptions.env.GH_HOST).toBe('github.com');
    expect(gheOptions.env.GH_HOST).toBe('github.example.com');

    // Tokens are not cached: a second round re-runs gh and again returns each
    // host its own token.
    expect(await getGhCliToken()).toBe('github-token');
    expect(await getGhCliToken('github.example.com')).toBe('ghe-token');
    expect(execFileMock).toHaveBeenCalledTimes(4);
  });

  test('rechecks unavailable gh CLI authentication on every operation', async () => {
    execFileMock.mockImplementation((_cmd, _args, _options, callback) => callback(new Error('gh unavailable')));

    expect(await getGhCliToken()).toBeNull();
    expect(await getGhCliToken()).toBeNull();
    expect(execFileMock).toHaveBeenCalledTimes(2);
  });
});
