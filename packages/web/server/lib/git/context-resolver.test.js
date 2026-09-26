import { describe, expect, it, vi } from 'vitest';
import fsp from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';

import { createGitContextResolver } from './context-resolver.js';

const tick = () => new Promise((resolve) => setTimeout(resolve, 0));

const waitFor = async (predicate) => {
  for (let attempt = 0; attempt < 20; attempt += 1) {
    if (predicate()) {
      return;
    }
    await tick();
  }
};

describe('GitContextResolver', () => {
  it('uses one structured discovery command and derives linked-worktree identity', async () => {
    const calls = [];
    const resolver = createGitContextResolver({
      pathExists: async () => true,
      runGit: async (cwd, args) => {
        calls.push({ cwd, args });
        return { success: true, stdout: '/repo/worktree\n/repo/.git/worktrees/feature\n/repo/.git\n' };
      },
    });

    const result = await resolver.resolve('/repo/worktree/src');

    expect(result).toEqual({
      isRepository: true,
      requestedDirectory: '/repo/worktree/src',
      topLevel: '/repo/worktree',
      gitDir: '/repo/.git/worktrees/feature',
      commonDir: '/repo/.git',
      commonId: '/repo/.git',
      worktreeId: '/repo/worktree',
    });
    expect(calls).toEqual([{
      cwd: '/repo/worktree/src',
      args: ['rev-parse', '--show-toplevel', '--absolute-git-dir', '--git-common-dir'],
    }]);
  });

  it('returns a non-repository context without inventing an identity', async () => {
    const resolver = createGitContextResolver({
      pathExists: async () => true,
      runGit: async () => ({ success: false, stderr: 'fatal: not a git repository' }),
    });

    await expect(resolver.resolve('/not-a-repo')).resolves.toEqual({
      isRepository: false,
      requestedDirectory: '/not-a-repo',
      reason: 'not-a-repository',
    });
  });

  it('rejects filesystem-root repositories as unsupported before caching or admitting work', async () => {
    const fingerprint = vi.fn();
    const resolver = createGitContextResolver({
      pathExists: async () => true,
      getPathFingerprint: fingerprint,
      runGit: async () => ({ success: true, stdout: '/\n/.git\n/.git\n' }),
    });

    await expect(resolver.resolve('/workspace')).resolves.toEqual({
      isRepository: false,
      requestedDirectory: '/workspace',
      reason: 'unsupported-repository-root',
      unsupportedRoot: 'filesystem-root',
    });
    expect(fingerprint).not.toHaveBeenCalled();
  });

  it('rejects home-root repositories with the same shared context contract', async () => {
    const home = os.homedir();
    const resolver = createGitContextResolver({
      pathExists: async () => true,
      runGit: async () => ({ success: true, stdout: `${home}\n${home}/.git\n${home}/.git\n` }),
    });

    await expect(resolver.resolve(path.join(home, 'project'))).resolves.toMatchObject({
      isRepository: false,
      reason: 'unsupported-repository-root',
      unsupportedRoot: 'home',
    });
  });

  it('shares Windows context aliases whose casing differs', async () => {
    const runGit = vi.fn(async () => ({
      success: true,
      stdout: 'C:\\Users\\Alice\\Repo\nC:\\Users\\Alice\\Repo\\.git\nC:\\Users\\Alice\\Repo\\.git\n',
    }));
    const resolver = createGitContextResolver({
      platform: 'win32',
      pathExists: async () => true,
      realpath: async (value) => value,
      getPathFingerprint: async () => 'stable',
      runGit,
    });

    await resolver.resolve('C:\\Users\\Alice\\Repo\\src');
    await resolver.resolve('c:\\users\\alice\\repo\\SRC');

    expect(runGit).toHaveBeenCalledOnce();
  });

  it('applies the Windows home-root guard without changing the returned path', async () => {
    const resolver = createGitContextResolver({
      platform: 'win32',
      home: 'C:\\Users\\Alice',
      pathExists: async () => true,
      runGit: async () => ({
        success: true,
        stdout: 'c:\\users\\alice\nc:\\users\\alice\\.git\nc:\\users\\alice\\.git\n',
      }),
    });

    await expect(resolver.resolve('C:\\Users\\Alice\\project')).resolves.toMatchObject({
      isRepository: false,
      reason: 'unsupported-repository-root',
      unsupportedRoot: 'home',
    });
  });

  it('returns a missing requested directory as non-repository without invoking Git', async () => {
    const runGit = vi.fn();
    const resolver = createGitContextResolver({
      realpath: async (value) => value,
      pathExists: async () => false,
      runGit,
    });

    await expect(resolver.resolve('/deleted-worktree')).resolves.toEqual({
      isRepository: false,
      requestedDirectory: '/deleted-worktree',
      reason: 'not-a-repository',
    });
    expect(runGit).not.toHaveBeenCalled();
  });

  it('propagates requested-directory stat failures without invoking Git', async () => {
    const statError = Object.assign(new Error('permission denied while checking directory'), {
      code: 'EACCES',
    });
    const runGit = vi.fn();
    const resolver = createGitContextResolver({
      pathExists: async () => { throw statError; },
      runGit,
    });

    await expect(resolver.resolve('/protected-repo')).rejects.toBe(statError);
    expect(runGit).not.toHaveBeenCalled();
  });

  it('accepts a structured non-repository discovery result', async () => {
    const resolver = createGitContextResolver({
      pathExists: async () => true,
      runGit: async () => ({
        success: false,
        code: 'GIT_NOT_A_REPOSITORY',
        reason: 'not-a-repository',
      }),
    });

    await expect(resolver.resolve('/not-a-repo')).resolves.toEqual({
      isRepository: false,
      requestedDirectory: '/not-a-repo',
      reason: 'not-a-repository',
    });
  });

  it('keeps permission failures as structured discovery errors', async () => {
    const resolver = createGitContextResolver({
      pathExists: async () => true,
      runGit: async () => ({
        success: false,
        code: 'EACCES',
        stderr: "fatal: cannot open '.git/HEAD': Permission denied",
      }),
    });

    await expect(resolver.resolve('/protected-repo')).rejects.toMatchObject({
      code: 'EACCES',
      stderr: "fatal: cannot open '.git/HEAD': Permission denied",
      details: {
        operation: 'git-context-discovery',
        cwd: '/protected-repo',
      },
    });
  });

  it('wraps thrown discovery failures with execution context', async () => {
    const error = new Error('permission denied while reading repository metadata');
    error.code = 'EACCES';
    const resolver = createGitContextResolver({
      pathExists: async () => true,
      runGit: async () => { throw error; },
    });

    await expect(resolver.resolve('/protected-repo')).rejects.toMatchObject({
      code: 'EACCES',
      details: {
        operation: 'git-context-discovery',
        cwd: '/protected-repo',
        args: ['rev-parse', '--show-toplevel', '--absolute-git-dir', '--git-common-dir'],
      },
    });
  });

  it('keeps missing Git failures as structured discovery errors', async () => {
    const resolver = createGitContextResolver({
      pathExists: async () => true,
      runGit: async () => ({
        success: false,
        code: 'ENOENT',
        exitCode: 127,
        stderr: 'git: command not found',
      }),
    });

    await expect(resolver.resolve('/repo')).rejects.toMatchObject({
      code: 'ENOENT',
      exitCode: 127,
      stderr: 'git: command not found',
      details: {
        operation: 'git-context-discovery',
        cwd: '/repo',
      },
    });
  });

  it('keeps incomplete discovery output as an error', async () => {
    const resolver = createGitContextResolver({
      pathExists: async () => true,
      runGit: async () => ({
        success: true,
        stdout: '/repo\n/repo/.git\n',
      }),
    });

    await expect(resolver.resolve('/repo')).rejects.toMatchObject({
      message: 'Git context discovery returned incomplete output',
      stdout: '/repo\n/repo/.git\n',
      details: {
        operation: 'git-context-discovery',
        cwd: '/repo',
      },
    });
  });

  it('rejects complete-looking discovery output without a valid repository identity', async () => {
    const resolver = createGitContextResolver({
      pathExists: async () => true,
      runGit: async () => ({
        success: true,
        stdout: 'repository\n.git\n.git\n',
      }),
    });

    await expect(resolver.resolve('/repo')).rejects.toMatchObject({
      message: 'Git context discovery returned a repository root outside the requested directory',
      details: {
        operation: 'git-context-discovery',
        cwd: '/repo',
      },
    });
  });

  it('rejects a partial relative identity mixed with absolute discovery output', async () => {
    const resolver = createGitContextResolver({
      pathExists: async () => true,
      runGit: async () => ({
        success: true,
        stdout: '/repo\n.git\n.git\n',
      }),
    });

    await expect(resolver.resolve('/repo')).rejects.toMatchObject({
      message: 'Git context discovery returned a non-absolute repository identity',
    });
  });

  it('resolves relative common-directory output from the discovery CWD', async () => {
    const resolver = createGitContextResolver({
      pathExists: async () => true,
      runGit: async () => ({
        success: true,
        stdout: '../\n../../.git/worktrees/feature\n./.git\n',
      }),
    });

    await expect(resolver.resolve('/repo/worktree/src')).resolves.toMatchObject({
      topLevel: '/repo/worktree',
      gitDir: '/repo/.git/worktrees/feature',
      commonDir: '/repo/worktree/src/.git',
    });
  });

  it('canonicalizes symlink aliases before caching repository identity', async () => {
    const calls = [];
    const resolver = createGitContextResolver({
      realpath: async (value) => value.replace('/link', ''),
      pathExists: async () => true,
      getPathFingerprint: async () => 'stable',
      runGit: async (cwd) => {
        calls.push(cwd);
        return { success: true, stdout: '/repo/src\n/repo/.git\n/repo/.git\n' };
      },
    });

    await resolver.resolve('/repo/link/src');
    await resolver.resolve('/repo/src');

    expect(calls).toEqual(['/repo/src']);
  });

  it('rediscovers a repository when its identity fingerprint changes at the same path', async () => {
    let fingerprint = 'first';
    let calls = 0;
    const resolver = createGitContextResolver({
      realpath: async (value) => value,
      pathExists: async () => true,
      getPathFingerprint: async () => fingerprint,
      runGit: async () => {
        calls += 1;
        const commonDir = fingerprint === 'first' ? '/repo/.git-one' : '/repo/.git-two';
        return { success: true, stdout: `/repo\n${commonDir}\n${commonDir}\n` };
      },
    });

    await resolver.resolve('/repo');
    fingerprint = 'second';
    const replacement = await resolver.resolve('/repo');

    expect(calls).toBe(2);
    expect(replacement).toMatchObject({
      topLevel: '/repo',
      commonDir: '/repo/.git-two',
      commonId: '/repo/.git-two',
    });
  });

  it('invalidates the default fingerprint when repository metadata is replaced in place', async () => {
    const repository = await fsp.mkdtemp(path.join(os.tmpdir(), 'openchamber-context-replacement-'));
    const gitDir = path.join(repository, '.git');
    await fsp.mkdir(gitDir);
    let calls = 0;
    const resolver = createGitContextResolver({
      runGit: async () => {
        calls += 1;
        return { success: true, stdout: `${repository}\n${gitDir}\n${gitDir}\n` };
      },
    });

    try {
      await resolver.resolve(repository);
      await fsp.rm(gitDir, { recursive: true });
      await fsp.mkdir(gitDir);

      await resolver.resolve(repository);
      expect(calls).toBe(2);
    } finally {
      await fsp.rm(repository, { recursive: true, force: true });
    }
  });

  it('keeps shared discovery alive when one waiter is cancelled', async () => {
    const firstController = new AbortController();
    let releaseDiscovery;
    const discovery = new Promise((resolve) => {
      releaseDiscovery = resolve;
    });
    let calls = 0;
    const resolver = createGitContextResolver({
      realpath: async (value) => value,
      pathExists: async () => true,
      runGit: async () => {
        calls += 1;
        return discovery;
      },
    });

    const first = resolver.resolve('/repo', { signal: firstController.signal });
    await waitFor(() => resolver.getStats().inFlightAliases === 1);
    const second = resolver.resolve('/repo');

    firstController.abort('first waiter no longer needs discovery');
    await expect(first).rejects.toMatchObject({ code: 'GIT_EXECUTION_CANCELLED' });

    releaseDiscovery({
      success: true,
      stdout: '/repo\n/repo/.git\n/repo/.git\n',
    });

    await expect(second).resolves.toMatchObject({
      isRepository: true,
      topLevel: '/repo',
      commonId: '/repo/.git',
    });
    expect(calls).toBe(1);
    expect(resolver.getStats()).toMatchObject({
      inFlightAliases: 0,
      inFlightContexts: 0,
      discovery: { active: 0, pending: 0 },
    });
  });

  it('cleans up shared discovery after its only waiter is cancelled', async () => {
    const controller = new AbortController();
    let releaseDiscovery;
    const discovery = new Promise((resolve) => {
      releaseDiscovery = resolve;
    });
    const resolver = createGitContextResolver({
      realpath: async (value) => value,
      pathExists: async () => true,
      runGit: async () => discovery,
    });

    const request = resolver.resolve('/repo', { signal: controller.signal });
    await waitFor(() => resolver.getStats().inFlightAliases === 1);
    controller.abort();
    await expect(request).rejects.toMatchObject({ code: 'GIT_EXECUTION_CANCELLED' });

    releaseDiscovery({
      success: true,
      stdout: '/repo\n/repo/.git\n/repo/.git\n',
    });
    await waitFor(() => resolver.getStats().inFlightAliases === 0
      && resolver.getStats().inFlightContexts === 0);

    expect(resolver.getStats()).toMatchObject({
      inFlightAliases: 0,
      inFlightContexts: 0,
      discovery: { active: 0, pending: 0 },
    });
  });

  it('aborts the underlying discovery process when its last waiter cancels', async () => {
    const controller = new AbortController();
    let discoverySignal;
    let processAborted = false;
    const resolver = createGitContextResolver({
      realpath: async (value) => value,
      pathExists: async () => true,
      getPathFingerprint: async () => 'stable',
      runGit: async (_cwd, _args, options = {}) => new Promise((_resolve, reject) => {
        discoverySignal = options.signal;
        options.signal?.addEventListener('abort', () => {
          processAborted = true;
          reject(options.signal.reason);
        }, { once: true });
      }),
    });

    const request = resolver.resolve('/repo', { signal: controller.signal });
    await waitFor(() => discoverySignal instanceof AbortSignal);
    controller.abort('request no longer needed');

    await expect(request).rejects.toMatchObject({ code: 'GIT_EXECUTION_CANCELLED' });
    await waitFor(() => processAborted
      && resolver.getStats().inFlightAliases === 0
      && resolver.getStats().inFlightContexts === 0
      && resolver.getStats().discovery.active === 0);

    expect(processAborted).toBe(true);
    expect(resolver.getStats()).toMatchObject({
      inFlightAliases: 0,
      inFlightContexts: 0,
      discovery: { active: 0, pending: 0 },
    });
  });

  it('keeps a cleanup-blocked discovery queued until process ownership reconciles', async () => {
    const controller = new AbortController();
    let releaseCleanup;
    const cleanup = new Promise((resolve) => {
      releaseCleanup = resolve;
    });
    let calls = 0;
    let discoverySignal;
    const resolver = createGitContextResolver({
      realpath: async (value) => value,
      pathExists: async () => true,
      getPathFingerprint: async () => 'stable',
      runGit: async (_cwd, _args, options = {}) => {
        calls += 1;
        discoverySignal = options.signal;
        if (calls === 1) {
          return new Promise((resolve) => {
            options.signal?.addEventListener('abort', () => resolve({
              success: false,
              code: 'ERR_PROCESS_TREE_TERMINATION',
              cleanupBlocked: true,
              descendantsTerminated: false,
              cleanupReconciliation: { promise: cleanup, retire: () => {} },
            }), { once: true });
          });
        }
        return { success: true, stdout: '/repo\n/repo/.git\n/repo/.git\n' };
      },
    });

    const first = resolver.resolve('/repo', { signal: controller.signal });
    await waitFor(() => resolver.getStats().inFlightAliases === 1);
    controller.abort('client disconnected');
    await expect(first).rejects.toMatchObject({ code: 'GIT_EXECUTION_CANCELLED' });
    await waitFor(() => discoverySignal?.aborted === true);

    const retry = resolver.resolve('/repo');
    await tick();
    expect(calls).toBe(1);
    expect(resolver.getStats()).toMatchObject({
      inFlightAliases: 1,
      inFlightContexts: 1,
      discovery: { active: 1, pending: 0 },
    });

    releaseCleanup();
    await expect(retry).rejects.toMatchObject({
      code: 'GIT_EXECUTION_CANCELLED',
      cleanupBlocked: true,
    });
    await waitFor(() => resolver.getStats().inFlightAliases === 0);
    await expect(resolver.resolve('/repo')).resolves.toMatchObject({ isRepository: true });
    expect(calls).toBe(2);
  });

  it('retains settled discovery aliases until cleanup reconciliation releases ownership', async () => {
    let releaseCleanup;
    const cleanup = new Promise((resolve) => {
      releaseCleanup = resolve;
    });
    const cleanupError = Object.assign(new Error('process ownership is unresolved'), {
      cleanupBlocked: true,
      cleanupReconciliation: { promise: cleanup, retire: () => {} },
    });
    const resolver = createGitContextResolver({
      realpath: async (value) => value,
      pathExists: async () => true,
      runGit: async () => ({ success: true, stdout: '' }),
    });
    let discoveries = 0;
    vi.spyOn(resolver, 'discover').mockImplementation(async () => {
      discoveries += 1;
      if (discoveries === 1) throw cleanupError;
      return {
        isRepository: true,
        requestedDirectory: '/repo',
        topLevel: '/repo',
        gitDir: '/repo/.git',
        commonDir: '/repo/.git',
        commonId: '/repo/.git',
        worktreeId: '/repo',
      };
    });
    const aliasDelete = vi.spyOn(resolver.inFlightAliases, 'delete');
    const contextDelete = vi.spyOn(resolver.inFlightContexts, 'delete');

    await expect(resolver.resolve('/repo')).rejects.toBe(cleanupError);
    expect(resolver.getStats()).toMatchObject({
      inFlightAliases: 1,
      inFlightContexts: 1,
      discovery: { active: 0, pending: 0 },
    });

    await expect(resolver.resolve('/repo')).rejects.toBe(cleanupError);
    expect(discoveries).toBe(1);
    expect(aliasDelete).not.toHaveBeenCalled();
    expect(contextDelete).not.toHaveBeenCalled();

    releaseCleanup();
    await waitFor(() => resolver.getStats().inFlightAliases === 0);
    expect(aliasDelete).toHaveBeenCalledTimes(1);
    expect(contextDelete).toHaveBeenCalledTimes(1);

    await expect(resolver.resolve('/repo')).resolves.toMatchObject({ isRepository: true });
    expect(discoveries).toBe(2);
  });

  it('does not restart a discovery whose cleanup is explicitly blocked without reconciliation', async () => {
    const controller = new AbortController();
    let calls = 0;
    let discoverySignal;
    const resolver = createGitContextResolver({
      realpath: async (value) => value,
      pathExists: async () => true,
      runGit: async (_cwd, _args, options = {}) => {
        calls += 1;
        discoverySignal = options.signal;
        return new Promise((resolve) => {
          options.signal?.addEventListener('abort', () => resolve({
            success: false,
            code: 'ERR_PROCESS_TREE_TERMINATION',
            cleanupBlocked: true,
            descendantsTerminated: false,
          }), { once: true });
        });
      },
    });

    const first = resolver.resolve('/repo', { signal: controller.signal });
    await waitFor(() => resolver.getStats().inFlightAliases === 1);
    controller.abort('client disconnected');
    await expect(first).rejects.toMatchObject({ code: 'GIT_EXECUTION_CANCELLED' });
    await waitFor(() => discoverySignal?.aborted === true);

    await expect(resolver.resolve('/repo')).rejects.toMatchObject({
      code: 'GIT_EXECUTION_CANCELLED',
      cleanupBlocked: true,
    });
    expect(calls).toBe(1);
    expect(resolver.getStats()).toMatchObject({
      inFlightAliases: 1,
      inFlightContexts: 1,
      discovery: { active: 0, pending: 0 },
    });
  });

  it('bounds a hung discovery and releases its resolver and queue slots', async () => {
    let discoverySignal;
    const resolver = createGitContextResolver({
      realpath: async (value) => value,
      pathExists: async () => true,
      getPathFingerprint: async () => 'stable',
      discoveryTimeoutMs: 5,
      runGit: async (_cwd, _args, options = {}) => new Promise((_resolve, reject) => {
        discoverySignal = options.signal;
        options.signal?.addEventListener('abort', () => reject(options.signal.reason), { once: true });
      }),
    });

    await expect(resolver.resolve('/repo')).rejects.toMatchObject({ code: 'GIT_EXECUTION_CANCELLED' });
    expect(discoverySignal?.aborted).toBe(true);
    expect(resolver.getStats()).toMatchObject({
      inFlightAliases: 0,
      inFlightContexts: 0,
      discovery: { active: 0, pending: 0 },
    });
  });
});
