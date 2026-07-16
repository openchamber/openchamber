// @ts-expect-error Bun provides this module at test runtime; the extension tsconfig intentionally omits Bun globals.
import { describe, expect, it } from 'bun:test';

import { createGitExecutionCoordinator } from './git-execution-coordinator';
import { createGitContextResolver } from './git-context-resolver';
import { GIT_EXECUTION_ERROR_CODES } from './git-execution-errors';
import { createGitExecutionRuntime } from './git-execution-runtime';
import { getGitExecutionEnv, runWithGitExecutionScope } from './git-execution-scope';

const deferred = <T = void>() => {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((resolvePromise) => {
    resolve = resolvePromise;
  });
  return { promise, resolve };
};

describe('VS Code Git execution runtime', () => {
  it('uses optional locks for raw discovery and observations only', async () => {
    const calls: Array<{ args: string[]; cwd: string; optionalLocks?: string }> = [];
    const runtime = createGitExecutionRuntime({
      realpath: async (value) => value,
      executeGit: async (args, cwd, options) => {
        calls.push({ args, cwd, optionalLocks: options?.env?.GIT_OPTIONAL_LOCKS });
        if (args[0] === 'rev-parse' && args.includes('--show-toplevel')) {
          return { stdout: ['/repo', '/repo/.git', '/repo/.git'].join('\n'), stderr: '', exitCode: 0 };
        }
        return { stdout: ' M src/a.ts\n', stderr: '', exitCode: 0 };
      },
    });

    const result = await runtime.runRawObservation(['status', '--porcelain'], '/repo');
    expect(result.stdout).toContain('src/a.ts');
    expect(calls).toHaveLength(2);
    expect(calls.every((call) => call.optionalLocks === '0')).toBe(true);
    expect(runtime.getStats()).toMatchObject({
      resolver: { inFlightAliases: 0, inFlightContexts: 0 },
      coordinator: { active: 0, pending: 0 },
    });
  });

  it('bounds built-in-capable work under a canonical fallback when PATH discovery fails', async () => {
    const coordinator = createGitExecutionCoordinator({ globalConcurrency: 2 });
    const runtime = createGitExecutionRuntime({
      coordinator,
      realpath: async (value) => value,
      executeGit: async () => ({ stdout: '', stderr: 'spawn git EACCES', exitCode: 1 }),
    });
    const gate = deferred();
    const events: string[] = [];

    const first = runtime.runServiceOperation('stageGitFiles', '/repo', async () => {
      events.push('first:start');
      await gate.promise;
      events.push('first:end');
    });
    const second = runtime.runServiceOperation('stageGitFiles', '/repo', async () => {
      events.push('second');
    });

    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(events).toEqual(['first:start']);
    gate.resolve();
    await Promise.all([first, second]);
    expect(events).toEqual(['first:start', 'first:end', 'second']);
    expect(runtime.getStats().coordinator).toMatchObject({ active: 0, pending: 0, contexts: 1, worktrees: 1 });
  });

  it('scopes optional-lock environment without leaking it into mutation compounds', async () => {
    expect(getGitExecutionEnv()).toEqual({});
    await runWithGitExecutionScope(true, async () => {
      expect(getGitExecutionEnv()).toEqual({ GIT_OPTIONAL_LOCKS: '0' });
      await runWithGitExecutionScope(false, async () => {
        expect(getGitExecutionEnv()).toEqual({});
      });
      expect(getGitExecutionEnv()).toEqual({ GIT_OPTIONAL_LOCKS: '0' });
    });
    expect(getGitExecutionEnv()).toEqual({});
  });

  it('preserves structured discovery overload instead of bypassing it with a fallback identity', async () => {
    const gate = deferred<{ success: true; stdout: string }>();
    const resolver = createGitContextResolver({
      realpath: async (value) => value,
      maxInFlightAliases: 1,
      discoveryConcurrency: 1,
      runGit: async (cwd) => {
        await gate.promise;
        return { success: true, stdout: [cwd, `${cwd}/.git`, `${cwd}/.git`].join('\n') };
      },
    });
    const runtime = createGitExecutionRuntime({ resolver });

    const first = runtime.resolveExecutionContext('/repo-a');
    await expect(runtime.resolveExecutionContext('/repo-b')).rejects.toMatchObject({
      code: GIT_EXECUTION_ERROR_CODES.OVERLOADED,
    });
    gate.resolve({ success: true, stdout: '' });
    await first;
  });

  it('keeps unresolved bootstrap fallback behind the owning common-context topology lease', async () => {
    const coordinator = createGitExecutionCoordinator({ globalConcurrency: 2 });
    const runtime = createGitExecutionRuntime({
      coordinator,
      realpath: async (value) => value,
      executeGit: async () => ({ stdout: '', stderr: 'discovery failed', exitCode: 1 }),
    });
    const outerContext = {
      isRepository: true as const,
      commonId: '/repo/.git',
      worktreeId: JSON.stringify(['/repo/.git', '/repo']),
    };
    const outerGate = deferred();
    const events: string[] = [];
    let background!: Promise<void>;

    const outer = coordinator.run({
      context: outerContext,
      kind: 'topology-write',
    }, async () => {
      events.push('outer:start');
      background = runtime.runInternalOperationWithCommonFallback(
        'worktreeBootstrap',
        '/repo/worktree',
        outerContext.commonId,
        async () => {
          events.push('bootstrap');
        },
      );
      await outerGate.promise;
      events.push('outer:end');
    });

    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(events).toEqual(['outer:start']);
    outerGate.resolve();
    await outer;
    await background;
    expect(events).toEqual(['outer:start', 'outer:end', 'bootstrap']);
  });
});
