import { EventEmitter } from 'node:events';
import { afterAll, beforeAll, beforeEach, describe, expect, it, mock } from 'bun:test';

const spawnCalls = [];
const getGitExecutablePath = mock();
const spawn = mock((command, args, options) => {
  const childProcess = new EventEmitter();
  childProcess.stdout = new EventEmitter();
  childProcess.stderr = new EventEmitter();
  spawnCalls.push({ command, args, options });
  queueMicrotask(() => childProcess.emit('close', 0));
  return childProcess;
});

mock.module('child_process', () => ({
  execFile: mock(),
  spawn,
}));

mock.module('./gitService', () => ({
  getGitExecutablePath,
}));

const { createGitProcessRuntime } = await import('./bridge-git-process-runtime');

describe('VS Code Git process runtime executable selection', () => {
  const originalSshAuthSock = process.env.SSH_AUTH_SOCK;

  beforeAll(() => {
    process.env.SSH_AUTH_SOCK = '/tmp/openchamber-test-agent.sock';
  });

  afterAll(() => {
    if (originalSshAuthSock === undefined) {
      delete process.env.SSH_AUTH_SOCK;
    } else {
      process.env.SSH_AUTH_SOCK = originalSshAuthSock;
    }
  });

  beforeEach(() => {
    getGitExecutablePath.mockReset();
    getGitExecutablePath.mockResolvedValue(undefined);
    spawn.mockClear();
    spawnCalls.length = 0;
  });

  it('uses the configured Git executable for discovery', async () => {
    getGitExecutablePath.mockResolvedValue('/custom/bin/git');
    const runtime = createGitProcessRuntime();

    await expect(runtime.execGit(['rev-parse'], '/repo')).resolves.toEqual({
      stdout: '',
      stderr: '',
      exitCode: 0,
    });
    expect(spawnCalls[0]).toMatchObject({
      command: '/custom/bin/git',
      args: ['rev-parse'],
      options: { cwd: '/repo' },
    });
  });

  it('keeps the raw Git fallback when no configured executable is available', async () => {
    const runtime = createGitProcessRuntime();

    await expect(runtime.execGit(['rev-parse'], '/repo')).resolves.toEqual({
      stdout: '',
      stderr: '',
      exitCode: 0,
    });
    expect(spawnCalls[0]).toMatchObject({
      command: 'git',
      args: ['rev-parse'],
      options: { cwd: '/repo' },
    });
  });

  it('kills an active process on abort and settles only after child exit', async () => {
    const childProcess = new EventEmitter();
    childProcess.stdout = new EventEmitter();
    childProcess.stderr = new EventEmitter();
    childProcess.kill = mock();
    spawn.mockImplementationOnce(() => childProcess);

    const controller = new AbortController();
    const runtime = createGitProcessRuntime();
    const pending = runtime.execGit(['status'], '/repo', { signal: controller.signal });
    for (let attempt = 0; attempt < 5 && spawnCalls.length === 0; attempt += 1) {
      await Promise.resolve();
    }

    controller.abort('cancelled by test');
    expect(childProcess.kill).toHaveBeenCalledWith('SIGKILL');

    let settled = false;
    void pending.then(() => { settled = true; });
    await Promise.resolve();
    expect(settled).toBe(false);

    childProcess.emit('close', null);
    await expect(pending).resolves.toMatchObject({ exitCode: 1 });
    childProcess.emit('error', new Error('late child error'));
    expect(childProcess.kill).toHaveBeenCalledTimes(1);
  });
});
