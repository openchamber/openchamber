import { describe, expect, it, mock } from 'bun:test';

import { getGitExecutionEnv } from './git-execution-scope';

const calls = [];
const execGit = mock(async (args, cwd, options = {}) => {
  calls.push({ args, cwd, env: getGitExecutionEnv(), signal: options.signal });
  return {
    stdout: '',
    stderr: 'fatal: permission denied while reading repository metadata',
    exitCode: 1,
    code: 'EACCES',
  };
});

mock.module('./bridge-git-process-runtime', () => ({ execGit }));

const { createGitExecutionRuntime } = await import('./git-execution-runtime');

describe('VS Code Git execution runtime discovery', () => {
  it('runs discovery as a read and preserves process error codes', async () => {
    calls.length = 0;
    const directory = process.cwd();

    const runtime = createGitExecutionRuntime();

    await expect(runtime.discover(directory)).rejects.toMatchObject({
      code: 'EACCES',
      details: {
        operation: 'git-context-discovery',
        cwd: directory,
      },
    });
    expect(calls).toEqual([{
      args: ['rev-parse', '--show-toplevel', '--absolute-git-dir', '--git-common-dir'],
      cwd: directory,
      env: { GIT_OPTIONAL_LOCKS: '0' },
      signal: expect.any(AbortSignal),
    }]);
  });

  it('falls back to the service adapter when the raw discovery executable is unavailable', async () => {
    const resolver = {
      resolve: mock(async () => {
        throw {
          code: 'ENOENT',
          details: { operation: 'git-context-discovery' },
        };
      }),
    };
    const runtime = createGitExecutionRuntime({ resolver });
    const task = mock(async (lease) => lease.kind);

    await expect(runtime.runServiceOperation('getGitStatus', '/repo', task)).resolves.toBe('read');
    expect(task).toHaveBeenCalledWith(expect.objectContaining({
      commonId: '/repo',
      worktreeId: '/repo',
      kind: 'read',
    }));
  });

  it('passes Gitignore waiter cancellation and queue deadlines to coordinated reads', async () => {
    const resolver = {
      resolve: mock(async () => ({
        isRepository: true,
        requestedDirectory: '/repo',
        topLevel: '/repo',
        gitDir: '/repo/.git',
        commonDir: '/repo/.git',
        commonId: '/repo/.git',
        worktreeId: '/repo',
      })),
    };
    const coordinator = {
      run: mock(async (options, task) => task({ active: true, ...options })),
    };
    const runtime = createGitExecutionRuntime({ resolver, coordinator });
    const controller = new AbortController();

    await expect(runtime.withRawRead(
      '/repo',
      async () => 'read',
      { signal: controller.signal, queueTimeoutMs: 25 },
    )).resolves.toBe('read');

    expect(coordinator.run).toHaveBeenCalledWith(
      expect.objectContaining({
        kind: 'read',
        signal: controller.signal,
        queueTimeoutMs: 25,
      }),
      expect.any(Function),
    );
  });
});
