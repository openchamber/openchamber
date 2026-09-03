import { EventEmitter } from 'node:events';
import { afterAll, beforeEach, describe, expect, it, mock } from 'bun:test';

const originalSshAuthSock = process.env.SSH_AUTH_SOCK;
process.env.SSH_AUTH_SOCK = '/tmp/openchamber-test-agent.sock';

const spawnCalls = [];
const spawn = mock((command, args, options) => {
  const childProcess = new EventEmitter();
  childProcess.stdout = new EventEmitter();
  childProcess.stderr = new EventEmitter();
  childProcess.kill = mock();
  spawnCalls.push({ command, args, options, childProcess });
  return childProcess;
});

mock.module('child_process', () => ({
  execFile: mock(),
  spawn,
}));

mock.module('vscode', () => ({
  extensions: {
    getExtension: () => undefined,
  },
}));

const { getGitRangeDiff, getGitRangeFiles } = await import('./gitService.ts?range-read-test');
const { createGitExecutionRuntime } = await import('./git-execution-runtime.ts?range-read-test');

afterAll(() => {
  if (originalSshAuthSock === undefined) {
    delete process.env.SSH_AUTH_SOCK;
  } else {
    process.env.SSH_AUTH_SOCK = originalSshAuthSock;
  }
});

const context = {
  isRepository: true,
  requestedDirectory: '/repo',
  topLevel: '/repo',
  gitDir: '/repo/.git',
  commonDir: '/repo/.git',
  commonId: '/repo/.git',
  worktreeId: '/repo',
};

const tick = () => new Promise((resolve) => setTimeout(resolve, 0));

const waitFor = async (predicate) => {
  for (let attempt = 0; attempt < 20; attempt += 1) {
    if (predicate()) {
      return;
    }
    await tick();
  }
};

describe('VS Code Git range process lifecycle', () => {
  beforeEach(() => {
    spawn.mockClear();
    spawnCalls.length = 0;
  });

  it('terminates a timed-out range-file read and releases its lease after close', async () => {
    const runtime = createGitExecutionRuntime({ resolver: { resolve: async () => context } });
    const controller = new AbortController();
    let taskSettled = false;
    let cleanupCount = 0;
    const pending = runtime.withRawRead(
      '/repo',
      async () => {
        try {
          return await getGitRangeFiles('/repo', 'main', 'feature', { signal: controller.signal });
        } finally {
          taskSettled = true;
          cleanupCount += 1;
        }
      },
      { signal: controller.signal, queueTimeoutMs: 25 },
    );

    await waitFor(() => spawnCalls.length === 1);
    const process = spawnCalls[0].childProcess;
    controller.abort('range-file read timed out');

    await expect(pending).rejects.toMatchObject({ code: 'GIT_EXECUTION_CANCELLED' });
    expect(process.kill).toHaveBeenCalledWith('SIGKILL');
    expect(process.kill).toHaveBeenCalledTimes(1);
    expect(taskSettled).toBe(false);
    expect(runtime.coordinator.getStats()).toMatchObject({ active: 1 });

    process.emit('close', null);
    await waitFor(() => taskSettled && runtime.coordinator.getStats().active === 0);

    expect(taskSettled).toBe(true);
    expect(cleanupCount).toBe(1);
    expect(process.kill).toHaveBeenCalledTimes(1);
    expect(runtime.coordinator.getStats()).toMatchObject({ active: 0, pending: 0 });
  });

  it('terminates a timed-out range-diff read and releases its lease after close', async () => {
    const runtime = createGitExecutionRuntime({ resolver: { resolve: async () => context } });
    const controller = new AbortController();
    let taskSettled = false;
    let cleanupCount = 0;
    const pending = runtime.withRawRead(
      '/repo',
      async () => {
        try {
          return await getGitRangeDiff('/repo', 'main', 'feature', 'src/a.ts', 3, {
            signal: controller.signal,
          });
        } finally {
          taskSettled = true;
          cleanupCount += 1;
        }
      },
      { signal: controller.signal, queueTimeoutMs: 25 },
    );

    await waitFor(() => spawnCalls.length === 1);
    const process = spawnCalls[0].childProcess;
    controller.abort('range-diff read timed out');

    await expect(pending).rejects.toMatchObject({ code: 'GIT_EXECUTION_CANCELLED' });
    expect(process.kill).toHaveBeenCalledWith('SIGKILL');
    expect(process.kill).toHaveBeenCalledTimes(1);
    expect(taskSettled).toBe(false);
    expect(runtime.coordinator.getStats()).toMatchObject({ active: 1 });

    process.emit('close', null);
    await waitFor(() => taskSettled && runtime.coordinator.getStats().active === 0);

    expect(taskSettled).toBe(true);
    expect(cleanupCount).toBe(1);
    expect(process.kill).toHaveBeenCalledTimes(1);
    expect(runtime.coordinator.getStats()).toMatchObject({ active: 0, pending: 0 });
  });
});
