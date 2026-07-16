import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

// @ts-expect-error Bun provides this module at test runtime; the extension tsconfig intentionally omits Bun globals.
import { describe, expect, it } from 'bun:test';

import { createGitExecutionCoordinator } from './git-execution-coordinator';
import { createGitContextResolver } from './git-context-resolver';
import { GIT_EXECUTION_ERROR_CODES } from './git-execution-errors';
import { createGitExecutionRuntime } from './git-execution-runtime';
import { getGitExecutionEnv, runWithGitExecutionScope } from './git-execution-scope';

const runGit = (cwd: string, args: string[]): string => execFileSync('git', args, {
  cwd,
  encoding: 'utf8',
  stdio: ['ignore', 'pipe', 'pipe'],
});

const canRunGit = (): boolean => {
  try {
    execFileSync('git', ['--version'], { stdio: 'ignore' });
    return true;
  } catch {
    return false;
  }
};

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

  it.skipIf(process.platform === 'win32')(
    'passes a manually configured POSIX fsmonitor hook through the real raw observation path',
    async () => {
      if (!canRunGit()) return;

      const fixture = fs.mkdtempSync(path.join(os.tmpdir(), 'openchamber-vscode-fsmonitor-'));
      const repo = path.join(fixture, 'repo');
      const isolatedGlobalConfig = path.join(fixture, 'isolated global config');
      const previousGlobalConfig = process.env.GIT_CONFIG_GLOBAL;
      const previousNoSystemConfig = process.env.GIT_CONFIG_NOSYSTEM;

      try {
        fs.mkdirSync(repo);
        fs.writeFileSync(isolatedGlobalConfig, '');
        process.env.GIT_CONFIG_GLOBAL = isolatedGlobalConfig;
        process.env.GIT_CONFIG_NOSYSTEM = '1';
        runGit(repo, ['init', '-b', 'main']);
        runGit(repo, ['config', '--local', 'user.email', 'test@example.com']);
        runGit(repo, ['config', '--local', 'user.name', 'Test User']);
        runGit(repo, ['config', '--local', 'commit.gpgsign', 'false']);
        fs.writeFileSync(path.join(repo, 'README.md'), '# Test\n');
        runGit(repo, ['add', 'README.md']);
        runGit(repo, ['commit', '-m', 'Initial commit']);
        expect(runGit(repo, ['status', '--porcelain=v1', '-uall'])).toBe('');

        const hookPath = path.join(repo, '.git', 'openchamber-fsmonitor-hook');
        const markerPath = path.join(repo, '.git', 'openchamber-fsmonitor-marker');
        fs.writeFileSync(hookPath, `#!/bin/sh
marker_path="\${0%/*}/openchamber-fsmonitor-marker"
printf '%s\\n' "$1" >> "$marker_path"
if [ "$1" = "2" ]; then
  printf '%s\\000/\\000' "$2"
else
  printf '/\\000'
fi
`, { encoding: 'utf8', mode: 0o755 });
        fs.chmodSync(hookPath, 0o755);
        runGit(repo, ['config', '--local', 'core.fsmonitor', hookPath]);
        const configuredFsmonitor = runGit(repo, ['config', '--local', '--get', 'core.fsmonitor']);
        expect(configuredFsmonitor).toBe(`${hookPath}\n`);
        expect(fs.existsSync(markerPath)).toBe(false);

        const runtime = createGitExecutionRuntime();
        const result = await runtime.runRawObservation(
          ['status', '--porcelain=v1', '-b', '-uall'],
          repo,
        );

        expect(result.exitCode).toBe(0);
        expect(result.stdout.trim()).toBe('## main');
        expect(fs.existsSync(markerPath)).toBe(true);
        const invocations = fs.readFileSync(markerPath, 'utf8').trim().split('\n');
        expect(invocations.length).toBeGreaterThan(0);
        expect(invocations.every((version) => version === '1' || version === '2')).toBe(true);
        expect(runGit(repo, ['config', '--local', '--get', 'core.fsmonitor'])).toBe(configuredFsmonitor);
        expect(runtime.getStats()).toMatchObject({
          resolver: { inFlightAliases: 0, inFlightContexts: 0, discovery: { active: 0, pending: 0 } },
          coordinator: {
            active: 0,
            pending: 0,
            activeNetwork: 0,
            statusInFlight: 0,
            clonePending: 0,
            cloneDestinations: 0,
          },
        });
      } finally {
        if (previousGlobalConfig === undefined) delete process.env.GIT_CONFIG_GLOBAL;
        else process.env.GIT_CONFIG_GLOBAL = previousGlobalConfig;
        if (previousNoSystemConfig === undefined) delete process.env.GIT_CONFIG_NOSYSTEM;
        else process.env.GIT_CONFIG_NOSYSTEM = previousNoSystemConfig;
        fs.rmSync(fixture, { recursive: true, force: true });
      }
    }
  );

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
