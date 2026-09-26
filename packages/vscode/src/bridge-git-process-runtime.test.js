import { EventEmitter } from 'node:events';
import { afterAll, beforeAll, beforeEach, describe, expect, it, mock } from 'bun:test';

const spawnCalls = [];
const getGitExecutablePath = mock();
const execFile = mock();
const spawn = mock((command, args, options) => {
  const childProcess = new EventEmitter();
  childProcess.stdout = new EventEmitter();
  childProcess.stderr = new EventEmitter();
  spawnCalls.push({ command, args, options });
  queueMicrotask(() => childProcess.emit('close', 0));
  return childProcess;
});

mock.module('child_process', () => ({
  execFile,
  spawn,
}));

mock.module('./gitService', () => ({
  getGitExecutablePath,
}));

const { spawnOwnedProcess } = await import('./owned-process');
const {
  createGitProcessRuntime,
  execGit,
  resetGitProcesses,
  stopGitProcesses,
} = await import('./bridge-git-process-runtime');

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
    execFile.mockReset();
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

  it('does not taskkill a Windows PID after its owned root has closed', async () => {
    const originalPlatform = process.platform;
    Object.defineProperty(process, 'platform', { configurable: true, value: 'win32' });
    try {
      const childProcess = new EventEmitter();
      childProcess.stdout = new EventEmitter();
      childProcess.stderr = new EventEmitter();
      childProcess.pid = 1233;
      childProcess.exitCode = 0;
      childProcess.signalCode = null;
      childProcess.kill = mock();
      spawn.mockImplementationOnce(() => childProcess);

      const owned = spawnOwnedProcess('git', ['status'], { cwd: '/repo', env: process.env });
      childProcess.emit('close', 0);

      await expect(owned.terminate()).rejects.toMatchObject({
        code: 'ERR_PROCESS_TREE_TERMINATION',
        cleanupBlocked: true,
        rootClosed: true,
      });
      expect(execFile).not.toHaveBeenCalled();
    } finally {
      Object.defineProperty(process, 'platform', { configurable: true, value: originalPlatform });
    }
  });

  it('does not taskkill a Windows PID after exit is observed but close is late', async () => {
    const originalPlatform = process.platform;
    Object.defineProperty(process, 'platform', { configurable: true, value: 'win32' });
    try {
      const childProcess = new EventEmitter();
      childProcess.stdout = new EventEmitter();
      childProcess.stderr = new EventEmitter();
      childProcess.pid = 1233;
      childProcess.exitCode = null;
      childProcess.signalCode = null;
      childProcess.kill = mock();
      spawn.mockImplementationOnce(() => childProcess);

      const owned = spawnOwnedProcess('git', ['status'], { cwd: '/repo', env: process.env });
      childProcess.exitCode = 0;

      await expect(owned.terminate()).rejects.toMatchObject({
        code: 'ERR_PROCESS_TREE_TERMINATION',
        cleanupBlocked: true,
        rootClosed: true,
      });
      expect(execFile).not.toHaveBeenCalled();
      expect(childProcess.kill).not.toHaveBeenCalled();

      childProcess.emit('close', 0);
    } finally {
      Object.defineProperty(process, 'platform', { configurable: true, value: originalPlatform });
    }
  });

  it('rejects a command when either output stream exceeds its buffer limit', async () => {
    const childProcess = new EventEmitter();
    childProcess.stdout = new EventEmitter();
    childProcess.stderr = new EventEmitter();
    childProcess.kill = mock();
    spawn.mockImplementationOnce(() => childProcess);

    const runtime = createGitProcessRuntime();
    const pending = runtime.execGit(['status'], '/repo', { maxBuffer: 4 });
    for (let attempt = 0; attempt < 5 && spawnCalls.length === 0; attempt += 1) {
      await Promise.resolve();
    }
    childProcess.stderr.emit('data', Buffer.from('12345'));
    childProcess.emit('close', null);

    await expect(pending).resolves.toMatchObject({
      exitCode: 1,
      code: 'ERR_CHILD_PROCESS_STDIO_MAXBUFFER',
      stderr: expect.stringMatching(/maxBuffer/),
    });
    expect(childProcess.kill).toHaveBeenCalledWith('SIGKILL');
  });

  it('settles cancellation when Windows taskkill fails and does not claim tree cleanup', async () => {
    const originalPlatform = process.platform;
    Object.defineProperty(process, 'platform', { configurable: true, value: 'win32' });
    try {
      const childProcess = new EventEmitter();
      childProcess.stdout = new EventEmitter();
      childProcess.stderr = new EventEmitter();
      childProcess.pid = 1234;
      childProcess.exitCode = null;
      childProcess.signalCode = null;
      childProcess.kill = mock();
      spawn.mockImplementationOnce(() => childProcess);
      execFile.mockImplementationOnce((_command, _args, _options, callback) => {
        callback(new Error('taskkill failed'));
      });

      const controller = new AbortController();
      const pending = createGitProcessRuntime().execGit(['status'], '/repo', {
        signal: controller.signal,
      });
      for (let attempt = 0; attempt < 5 && spawnCalls.length === 0; attempt += 1) {
        await Promise.resolve();
      }
      controller.abort();

      await expect(pending).resolves.toMatchObject({
        exitCode: 1,
        stderr: expect.stringMatching(/Failed to terminate.*descendant termination was not confirmed/),
        cleanupBlocked: true,
        descendantsTerminated: false,
      });
      expect(childProcess.kill).toHaveBeenCalledWith('SIGKILL');
    } finally {
      Object.defineProperty(process, 'platform', { configurable: true, value: originalPlatform });
    }
  });

  it('settles max-buffer cleanup with an explicit Windows termination failure', async () => {
    const originalPlatform = process.platform;
    Object.defineProperty(process, 'platform', { configurable: true, value: 'win32' });
    try {
      const childProcess = new EventEmitter();
      childProcess.stdout = new EventEmitter();
      childProcess.stderr = new EventEmitter();
      childProcess.pid = 1235;
      childProcess.exitCode = null;
      childProcess.signalCode = null;
      childProcess.kill = mock();
      spawn.mockImplementationOnce(() => childProcess);
      execFile.mockImplementationOnce((_command, _args, _options, callback) => {
        callback(new Error('taskkill failed during max-buffer cleanup'));
      });

      const pending = createGitProcessRuntime().execGit(['status'], '/repo', { maxBuffer: 1 });
      for (let attempt = 0; attempt < 5 && spawnCalls.length === 0; attempt += 1) {
        await Promise.resolve();
      }
      childProcess.stdout.emit('data', Buffer.from('12'));

      await expect(pending).resolves.toMatchObject({
        exitCode: 1,
        stderr: expect.stringMatching(/Failed to terminate.*descendant termination was not confirmed/),
        cleanupBlocked: true,
        descendantsTerminated: false,
      });
      expect(childProcess.kill).toHaveBeenCalledWith('SIGKILL');
    } finally {
      Object.defineProperty(process, 'platform', { configurable: true, value: originalPlatform });
    }
  });

  it('does not target a reused Windows PID and keeps the runtime blocked', async () => {
    const originalPlatform = process.platform;
    Object.defineProperty(process, 'platform', { configurable: true, value: 'win32' });
    try {
      const childProcess = new EventEmitter();
      childProcess.stdout = new EventEmitter();
      childProcess.stderr = new EventEmitter();
      childProcess.pid = 1236;
      childProcess.exitCode = null;
      childProcess.signalCode = null;
      childProcess.kill = mock();
      spawn.mockImplementationOnce(() => childProcess);
      let finishTaskkill;
      let taskkillCalls = 0;
      execFile.mockImplementation((_command, _args, _options, callback) => {
        taskkillCalls += 1;
        finishTaskkill = () => callback(new Error('taskkill failed during deactivation'));
      });

      const controller = new AbortController();
      const runtime = createGitProcessRuntime();
      const pending = runtime.execGit(['status'], '/repo', { signal: controller.signal });
      for (let attempt = 0; attempt < 5 && spawnCalls.length === 0; attempt += 1) {
        await Promise.resolve();
      }
      controller.abort();
      childProcess.emit('close', null);
      await Promise.resolve();

      const stopping = runtime.stopGitProcesses();
      let stopSettled = false;
      void stopping.then(() => { stopSettled = true; });
      await Promise.resolve();
      expect(stopSettled).toBe(false);
      finishTaskkill();
      await stopping;
      const result = await pending;

      expect(result).toMatchObject({
        exitCode: 1,
        stderr: expect.stringMatching(/Failed to terminate.*descendant termination was not confirmed/),
        cleanupBlocked: true,
        descendantsTerminated: false,
      });
      expect(result.cleanupReconciliation).toBeUndefined();
      expect(childProcess.kill).toHaveBeenCalledTimes(1);
      await expect(runtime.resetGitProcesses()).rejects.toThrow('Cannot reset the Git runtime');
      const blockedSpawnCount = spawnCalls.length;
      await expect(runtime.execGit(['status'], '/repo')).resolves.toMatchObject({
        exitCode: 1,
        cleanupBlocked: true,
      });
      expect(spawnCalls).toHaveLength(blockedSpawnCount);
      expect(taskkillCalls).toBe(1);
    } finally {
      Object.defineProperty(process, 'platform', { configurable: true, value: originalPlatform });
    }
  });

  it('keeps the Git runtime blocked when Windows exit precedes the late close event', async () => {
    const originalPlatform = process.platform;
    Object.defineProperty(process, 'platform', { configurable: true, value: 'win32' });
    try {
      const childProcess = new EventEmitter();
      childProcess.stdout = new EventEmitter();
      childProcess.stderr = new EventEmitter();
      childProcess.pid = 1239;
      childProcess.exitCode = null;
      childProcess.signalCode = null;
      childProcess.kill = mock();
      spawn.mockImplementationOnce(() => childProcess);

      const controller = new AbortController();
      const runtime = createGitProcessRuntime();
      const pending = runtime.execGit(['status'], '/repo', { signal: controller.signal });
      for (let attempt = 0; attempt < 5 && spawnCalls.length === 0; attempt += 1) {
        await Promise.resolve();
      }

      childProcess.exitCode = 0;
      controller.abort();

      await expect(pending).resolves.toMatchObject({
        exitCode: 1,
        cleanupBlocked: true,
        descendantsTerminated: false,
        rootClosed: true,
      });
      expect(execFile).not.toHaveBeenCalled();
      expect(childProcess.kill).not.toHaveBeenCalled();
      await expect(runtime.resetGitProcesses()).rejects.toThrow('Cannot reset the Git runtime');
      await expect(runtime.execGit(['status'], '/repo')).resolves.toMatchObject({
        exitCode: 1,
        cleanupBlocked: true,
      });

      childProcess.emit('close', 0);
      await expect(runtime.resetGitProcesses()).rejects.toThrow('Cannot reset the Git runtime');
    } finally {
      Object.defineProperty(process, 'platform', { configurable: true, value: originalPlatform });
    }
  });

  it('reactivates after the original Windows tree cleanup confirms root close', async () => {
    const originalPlatform = process.platform;
    Object.defineProperty(process, 'platform', { configurable: true, value: 'win32' });
    try {
      const childProcess = new EventEmitter();
      childProcess.stdout = new EventEmitter();
      childProcess.stderr = new EventEmitter();
      childProcess.pid = 1238;
      childProcess.exitCode = null;
      childProcess.signalCode = null;
      childProcess.kill = mock();
      spawn.mockImplementationOnce(() => childProcess);
      let taskkillCalls = 0;
      execFile.mockImplementation((_command, _args, _options, callback) => {
        taskkillCalls += 1;
        callback(null);
      });

      const controller = new AbortController();
      const runtime = createGitProcessRuntime();
      const pending = runtime.execGit(['status'], '/repo', { signal: controller.signal });
      for (let attempt = 0; attempt < 5 && spawnCalls.length === 0; attempt += 1) {
        await Promise.resolve();
      }
      controller.abort();

      const result = await pending;
      expect(result).toMatchObject({
        exitCode: 1,
        cleanupBlocked: true,
        descendantsTerminated: false,
      });
      expect(result.cleanupReconciliation).toBeDefined();
      expect(taskkillCalls).toBe(1);
      await expect(runtime.resetGitProcesses()).rejects.toThrow('Cannot reset the Git runtime');
      await expect(runtime.execGit(['status'], '/repo')).resolves.toMatchObject({
        exitCode: 1,
        cleanupBlocked: true,
      });

      childProcess.emit('close', null);
      await expect(result.cleanupReconciliation.promise).resolves.toBe(true);
      expect(taskkillCalls).toBe(1);
      await expect(runtime.resetGitProcesses()).resolves.toBeUndefined();
      await expect(runtime.execGit(['status'], '/repo')).resolves.toMatchObject({ exitCode: 0 });
    } finally {
      Object.defineProperty(process, 'platform', { configurable: true, value: originalPlatform });
    }
  });

  it('retains a POSIX process lease when group termination fails', async () => {
    const originalKill = process.kill;
    const originalPlatform = process.platform;
    Object.defineProperty(process, 'platform', { configurable: true, value: 'linux' });
    Object.defineProperty(process, 'kill', {
      configurable: true,
      value: (pid, signal) => {
        if (pid === -2237) {
          throw Object.assign(new Error('process-group signal failed'), { code: 'EPERM' });
        }
        return originalKill.call(process, pid, signal);
      },
    });
    try {
      const childProcess = new EventEmitter();
      childProcess.stdout = new EventEmitter();
      childProcess.stderr = new EventEmitter();
      childProcess.pid = 2237;
      childProcess.kill = mock();
      spawn.mockImplementationOnce(() => childProcess);

      const runtime = createGitProcessRuntime();
      const controller = new AbortController();
      const pending = runtime.execGit(['status'], '/repo', { signal: controller.signal });
      for (let attempt = 0; attempt < 5 && spawnCalls.length === 0; attempt += 1) {
        await Promise.resolve();
      }
      controller.abort();
      childProcess.emit('close', null);

      await expect(pending).resolves.toMatchObject({
        exitCode: 1,
        cleanupBlocked: true,
        descendantsTerminated: false,
      });
      await runtime.stopGitProcesses();
      await expect(runtime.resetGitProcesses()).rejects.toThrow('Cannot reset the Git runtime');
      await expect(runtime.execGit(['status'], '/repo')).resolves.toMatchObject({
        exitCode: 1,
        cleanupBlocked: true,
      });
      expect(childProcess.kill).toHaveBeenCalledTimes(1);
    } finally {
      Object.defineProperty(process, 'kill', { configurable: true, value: originalKill });
      Object.defineProperty(process, 'platform', { configurable: true, value: originalPlatform });
    }
  });

  it('reactivates the owning runtime after deactivation', async () => {
    await stopGitProcesses();
    await resetGitProcesses();

    await expect(execGit(['rev-parse'], '/repo')).resolves.toMatchObject({ exitCode: 0 });
  });

});
