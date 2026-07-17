import path from 'node:path';

import { describe, expect, it } from 'vitest';

import { createGitContextResolver } from './context-resolver.js';
import { GIT_EXECUTION_ERROR_CODES } from './execution-errors.js';

const deferred = () => {
  let resolve;
  let reject;
  const promise = new Promise((resolvePromise, rejectPromise) => {
    resolve = resolvePromise;
    reject = rejectPromise;
  });
  return { promise, resolve, reject };
};

const passThroughRealpath = async (value) => value;

describe('GitContextResolver', () => {
  it('canonicalizes subdirectories and relative common-dir output', async () => {
    const calls = [];
    const resolver = createGitContextResolver({
      realpath: passThroughRealpath,
      runGit: async (cwd, args) => {
        calls.push({ cwd, args });
        return {
          success: true,
          stdout: ['/repo', '../../.git', '../../.git'].join('\n'),
        };
      },
    });

    const context = await resolver.resolve('/repo/packages/app');

    expect(context).toMatchObject({
      isRepository: true,
      requestedDirectory: '/repo/packages/app',
      topLevel: '/repo',
      gitDir: '/repo/.git',
      commonDir: '/repo/.git',
      commonId: '/repo/.git',
    });
    expect(calls).toHaveLength(1);
    expect(calls[0].args).toEqual([
      'rev-parse',
      '--show-toplevel',
      '--absolute-git-dir',
      '--git-common-dir',
    ]);
  });

  it('converges symlink aliases and separates linked worktree identities', async () => {
    let calls = 0;
    const realpath = async (value) => {
      if (value === '/repo-link') return '/repo';
      if (value === '/linked-link') return '/linked';
      return value;
    };
    const runGit = async (cwd) => {
      calls += 1;
      if (cwd === '/linked') {
        return {
          success: true,
          stdout: ['/linked', '/repo/.git/worktrees/linked', '/repo/.git'].join('\n'),
        };
      }
      return {
        success: true,
        stdout: ['/repo', '/repo/.git', '/repo/.git'].join('\n'),
      };
    };
    const resolver = createGitContextResolver({ realpath, runGit });

    const [root, alias, linked, linkedAlias] = await Promise.all([
      resolver.resolve('/repo'),
      resolver.resolve('/repo-link'),
      resolver.resolve('/linked'),
      resolver.resolve('/linked-link'),
    ]);

    expect(alias.worktreeId).toBe(root.worktreeId);
    expect(linkedAlias.worktreeId).toBe(linked.worktreeId);
    expect(linked.commonId).toBe(root.commonId);
    expect(linked.worktreeId).not.toBe(root.worktreeId);
    expect(calls).toBe(2);
  });

  it('normalizes Windows identity casing while preserving canonical paths', async () => {
    const resolver = createGitContextResolver({
      platform: 'win32',
      pathImpl: path.win32,
      realpath: passThroughRealpath,
      runGit: async () => ({
        success: true,
        stdout: [
          'C:\\Repo\\WT',
          'C:\\Repo\\.git\\worktrees\\WT',
          '..\\..\\.git',
        ].join('\n'),
      }),
    });

    const context = await resolver.resolve('C:\\REPO\\WT\\SUB');

    expect(context.commonDir).toBe('C:\\REPO\\.git');
    expect(context.commonId).toBe('c:\\repo\\.git');
    expect(context.worktreeId).toContain('c:\\\\repo\\\\.git\\\\worktrees\\\\wt');
    expect(context.worktreeId).toContain('c:\\\\repo\\\\wt');
  });

  it('returns false only for confirmed non-repositories', async () => {
    const nonRepository = createGitContextResolver({
      realpath: passThroughRealpath,
      runGit: async () => ({
        success: false,
        exitCode: 128,
        stderr: 'fatal: not a git repository (or any parent up to mount point)',
      }),
    });
    const infrastructureFailure = createGitContextResolver({
      realpath: passThroughRealpath,
      runGit: async () => ({
        success: false,
        exitCode: 1,
        stderr: 'spawn git EACCES',
      }),
    });

    await expect(nonRepository.resolve('/tmp/plain')).resolves.toEqual({
      isRepository: false,
      requestedDirectory: '/tmp/plain',
      reason: 'not-a-repository',
    });
    await expect(infrastructureFailure.resolve('/tmp/repo')).rejects.toThrow('spawn git EACCES');
  });

  it('single-flights discovery and keeps waiter cancellation local', async () => {
    const gate = deferred();
    let calls = 0;
    const resolver = createGitContextResolver({
      realpath: passThroughRealpath,
      runGit: async () => {
        calls += 1;
        return gate.promise;
      },
    });
    const abortController = new AbortController();

    const first = resolver.resolve('/repo');
    const cancelled = resolver.resolve('/repo', { signal: abortController.signal });
    const third = resolver.resolve('/repo');
    abortController.abort();
    gate.resolve({ success: true, stdout: ['/repo', '/repo/.git', '/repo/.git'].join('\n') });

    await expect(cancelled).rejects.toMatchObject({ code: GIT_EXECUTION_ERROR_CODES.CANCELLED });
    const [firstContext, thirdContext] = await Promise.all([first, third]);
    expect(firstContext).toEqual(thirdContext);
    expect(calls).toBe(1);
    expect(resolver.getStats()).toMatchObject({
      inFlightAliases: 0,
      inFlightContexts: 0,
      discovery: { active: 0, pending: 0 },
    });
  });

  it('bounds discovery concurrency, aliases, and queue cleanup', async () => {
    const gates = [deferred(), deferred()];
    let active = 0;
    let maxActive = 0;
    let callIndex = 0;
    const resolver = createGitContextResolver({
      realpath: passThroughRealpath,
      discoveryConcurrency: 1,
      maxPendingDiscoveries: 1,
      maxInFlightAliases: 2,
      runGit: async (cwd) => {
        const index = callIndex;
        callIndex += 1;
        active += 1;
        maxActive = Math.max(maxActive, active);
        await gates[index].promise;
        active -= 1;
        return { success: true, stdout: [cwd, `${cwd}/.git`, `${cwd}/.git`].join('\n') };
      },
    });

    const first = resolver.resolve('/repo-a');
    const second = resolver.resolve('/repo-b');
    const overloaded = resolver.resolve('/repo-c');

    await expect(overloaded).rejects.toMatchObject({ code: GIT_EXECUTION_ERROR_CODES.OVERLOADED });
    gates[0].resolve();
    await first;
    gates[1].resolve();
    await second;

    expect(maxActive).toBe(1);
    expect(resolver.getStats()).toMatchObject({
      inFlightAliases: 0,
      inFlightContexts: 0,
      discovery: { active: 0, pending: 0 },
    });
  });

  it('bounds canonical in-flight context identities', async () => {
    const gate = deferred();
    const resolver = createGitContextResolver({
      realpath: passThroughRealpath,
      discoveryConcurrency: 2,
      maxInFlightAliases: 3,
      maxInFlightContexts: 1,
      runGit: async (cwd) => {
        await gate.promise;
        return { success: true, stdout: [cwd, `${cwd}/.git`, `${cwd}/.git`].join('\n') };
      },
    });

    const first = resolver.resolve('/repo-a');
    const overloaded = resolver.resolve('/repo-b');
    await expect(overloaded).rejects.toMatchObject({ code: GIT_EXECUTION_ERROR_CODES.OVERLOADED });
    gate.resolve();
    await first;
    expect(resolver.getStats()).toMatchObject({ inFlightAliases: 0, inFlightContexts: 0 });
  });
});
