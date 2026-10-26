import { afterAll, afterEach, beforeEach, describe, expect, mock, spyOn, test } from 'bun:test';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

// The real `child_process.execFile` is callback-based, so the mock must invoke
// its callback: promisify(execFile) settles through the callback, and an async
// mock would never call it (bun's promisify hangs on a promise-returning fn).
// mockReset() also clears the implementation, so beforeEach re-applies it.
const execFileMock = mock((_cmd, _args, _options, callback) => callback(null, { stdout: 'token\n' }));

mock.module('child_process', () => ({
  execFile: execFileMock,
}));

const { forgetGhCliToken, getGhCliToken } = await import('./gh-cli-credential.js');

const GH_INVOKE_BASE = {
  encoding: 'utf8',
  stdio: ['pipe', 'pipe', 'pipe'],
  timeout: 5000,
  windowsHide: true,
};

const answerWith = (stdout) => (_cmd, _args, _options, callback) => callback(null, { stdout });
const failWith = (fields) => (_cmd, _args, _options, callback) => callback(Object.assign(new Error('gh failed'), fields));

// A real gh config dir: every test starts from a hosts.yml no earlier test
// has seen, so no reused answer carries over between tests.
const configDir = mkdtempSync(join(tmpdir(), 'oc-gh-config-'));
const previousConfigDir = process.env.GH_CONFIG_DIR;
let generation = 0;
let clock = null;
const writeHostsFile = () => {
  generation += 1;
  writeFileSync(join(configDir, 'hosts.yml'), `github.com:\n    user: user-${'x'.repeat(generation)}\n`);
};

describe('gh CLI credential lookup', () => {
  beforeEach(() => {
    process.env.GH_CONFIG_DIR = configDir;
    writeHostsFile();
    execFileMock.mockReset();
    execFileMock.mockImplementation(answerWith('token\n'));
  });

  afterEach(() => {
    clock?.mockRestore();
    clock = null;
  });

  afterAll(() => {
    if (previousConfigDir === undefined) delete process.env.GH_CONFIG_DIR;
    else process.env.GH_CONFIG_DIR = previousConfigDir;
    rmSync(configDir, { recursive: true, force: true });
  });

  test('uses the default gh account and hides the subprocess window on Windows', async () => {
    expect(await getGhCliToken()).toBe('token');
    const [cmd, args, options] = execFileMock.mock.calls[0];
    expect(cmd).toBe('gh');
    expect(args).toEqual(['auth', 'token']);
    expect(options).toMatchObject({ ...GH_INVOKE_BASE, env: { GH_HOST: 'github.com' } });
  });

  test('pins GH_HOST so a GHE host returns that host token', async () => {
    execFileMock.mockImplementationOnce(answerWith('ghe-token\n'));

    expect(await getGhCliToken('github.example.com')).toBe('ghe-token');
    const [, , options] = execFileMock.mock.calls[0];
    expect(options.env.GH_HOST).toBe('github.example.com');
  });

  test('reuses each host token without running gh again', async () => {
    execFileMock
      .mockImplementationOnce(answerWith('github-token\n'))
      .mockImplementationOnce(answerWith('ghe-token\n'));

    expect(await getGhCliToken()).toBe('github-token');
    expect(await getGhCliToken('github.example.com')).toBe('ghe-token');
    expect(await getGhCliToken('GitHub.com')).toBe('github-token');
    expect(await getGhCliToken('github.example.com')).toBe('ghe-token');

    expect(execFileMock).toHaveBeenCalledTimes(2);
    expect(execFileMock.mock.calls[0][2].env.GH_HOST).toBe('github.com');
    expect(execFileMock.mock.calls[1][2].env.GH_HOST).toBe('github.example.com');
  });

  test('concurrent lookups share one gh run', async () => {
    const tokens = await Promise.all([getGhCliToken(), getGhCliToken(), getGhCliToken()]);

    expect(tokens).toEqual(['token', 'token', 'token']);
    expect(execFileMock).toHaveBeenCalledTimes(1);
  });

  test('asks gh again once a login, logout or account switch rewrites hosts.yml', async () => {
    execFileMock
      .mockImplementationOnce(answerWith('first-account\n'))
      .mockImplementationOnce(failWith({ code: 1 }))
      .mockImplementationOnce(answerWith('second-account\n'));

    expect(await getGhCliToken()).toBe('first-account');
    writeHostsFile();
    expect(await getGhCliToken()).toBeNull();
    expect(await getGhCliToken()).toBeNull();
    writeHostsFile();
    expect(await getGhCliToken()).toBe('second-account');
    expect(execFileMock).toHaveBeenCalledTimes(3);
  });

  test('asks gh again after the reuse limit', async () => {
    const start = Date.now();
    clock = spyOn(Date, 'now').mockReturnValue(start);
    execFileMock
      .mockImplementationOnce(answerWith('old-token\n'))
      .mockImplementationOnce(answerWith('new-token\n'));

    expect(await getGhCliToken()).toBe('old-token');
    clock.mockReturnValue(start + 4 * 60_000);
    expect(await getGhCliToken()).toBe('old-token');
    clock.mockReturnValue(start + 5 * 60_000);
    expect(await getGhCliToken()).toBe('new-token');
    expect(execFileMock).toHaveBeenCalledTimes(2);
  });

  test('keeps "no token" for 30 s, so an unlocked keyring is seen soon', async () => {
    const start = Date.now();
    clock = spyOn(Date, 'now').mockReturnValue(start);
    execFileMock
      .mockImplementationOnce(failWith({ code: 1 }))
      .mockImplementationOnce(answerWith('unlocked-token\n'));

    expect(await getGhCliToken()).toBeNull();
    clock.mockReturnValue(start + 29_000);
    expect(await getGhCliToken()).toBeNull();
    expect(execFileMock).toHaveBeenCalledTimes(1);
    clock.mockReturnValue(start + 30_000);
    expect(await getGhCliToken()).toBe('unlocked-token');
    // A token, unlike "no token", stays past 30 s up to the 5 minute limit.
    clock.mockReturnValue(start + 30_000 + 4 * 60_000);
    expect(await getGhCliToken()).toBe('unlocked-token');
    expect(execFileMock).toHaveBeenCalledTimes(2);
  });

  test('asks gh again after GitHub refused the reused token', async () => {
    execFileMock
      .mockImplementationOnce(answerWith('refused-token\n'))
      .mockImplementationOnce(answerWith('fresh-token\n'));

    expect(await getGhCliToken()).toBe('refused-token');
    forgetGhCliToken('github.com', 'another-token');
    expect(await getGhCliToken()).toBe('refused-token');
    forgetGhCliToken('', 'refused-token');
    expect(await getGhCliToken()).toBe('fresh-token');
    expect(execFileMock).toHaveBeenCalledTimes(2);
  });

  test('never reuses a run that failed to give an answer', async () => {
    execFileMock
      .mockImplementationOnce(failWith({ code: 'ENOENT' }))
      .mockImplementationOnce(failWith({ code: null, killed: true, signal: 'SIGTERM' }))
      .mockImplementationOnce(answerWith('token\n'));

    expect(await getGhCliToken()).toBeNull();
    expect(await getGhCliToken()).toBeNull();
    expect(await getGhCliToken()).toBe('token');
    expect(await getGhCliToken()).toBe('token');
    expect(execFileMock).toHaveBeenCalledTimes(3);
  });
});
