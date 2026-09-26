import { describe, expect, it } from 'vitest';
import { EventEmitter } from 'node:events';
import fsp from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';

import {
  createGitExecutionCoordinator,
  GIT_OPERATION_KIND,
} from './execution-coordinator.js';
import {
  GIT_EXECUTION_ERROR_CODES,
} from './execution-errors.js';
import { killProcessTree } from './process-tree.js';

const context = (worktreeId = 'worktree') => ({
  isRepository: true,
  commonId: 'common',
  worktreeId,
});

const tick = () => new Promise((resolve) => setTimeout(resolve, 0));

const waitFor = async (predicate) => {
  for (let attempt = 0; attempt < 20; attempt += 1) {
    if (predicate()) {
      return;
    }
    await tick();
  }
};

describe('GitExecutionCoordinator', () => {
  it('serializes conflicting worktree operations while allowing unrelated worktrees to progress', async () => {
    const coordinator = createGitExecutionCoordinator({ globalConcurrency: 4 });
    let release;
    const active = coordinator.run(
      { context: context('first'), kind: GIT_OPERATION_KIND.WORKTREE_WRITE },
      () => new Promise((resolve) => { release = resolve; }),
    );
    const blocked = coordinator.run(
      { context: context('first'), kind: GIT_OPERATION_KIND.READ },
      () => 'blocked',
    );
    const unrelated = coordinator.run(
      { context: context('second'), kind: GIT_OPERATION_KIND.WORKTREE_WRITE },
      () => 'unrelated',
    );

    await tick();
    expect(coordinator.getStats().pending).toBe(1);
    await expect(unrelated).resolves.toBe('unrelated');
    release('active');
    await expect(active).resolves.toBe('active');
    await expect(blocked).resolves.toBe('blocked');
  });

  it('preserves falsy rejection reasons and releases state after failure', async () => {
    const coordinator = createGitExecutionCoordinator({ globalConcurrency: 1 });
    await expect(coordinator.run(
      { context: context(), kind: GIT_OPERATION_KIND.WORKTREE_WRITE },
      () => Promise.reject(0),
    )).rejects.toBe(0);
    expect(coordinator.getStats()).toMatchObject({ active: 0, pending: 0 });
  });

  it('does not invalidate generations when a mutation expires in the queue', async () => {
    const coordinator = createGitExecutionCoordinator({ globalConcurrency: 1 });
    let release;
    const active = coordinator.run(
      { context: context(), kind: GIT_OPERATION_KIND.READ },
      () => new Promise((resolve) => { release = resolve; }),
    );
    const before = coordinator.getGeneration(context());
    const expired = coordinator.run(
      { context: context(), kind: GIT_OPERATION_KIND.WORKTREE_WRITE, queueTimeoutMs: 0 },
      () => 'never',
    );

    await expect(expired).rejects.toMatchObject({
      code: GIT_EXECUTION_ERROR_CODES.QUEUE_TIMEOUT,
    });
    expect(coordinator.getGeneration(context())).toEqual(before);
    release('active');
    await active;
  });

  it('rejects cancelled admission without retaining a newly created worktree', async () => {
    const controller = new AbortController();
    controller.abort();
    const coordinator = createGitExecutionCoordinator({ globalConcurrency: 1 });
    await expect(coordinator.run({
      context: context('cancelled'),
      kind: GIT_OPERATION_KIND.READ,
      signal: controller.signal,
    }, () => 'never')).rejects.toMatchObject({
      code: GIT_EXECUTION_ERROR_CODES.CANCELLED,
    });
    expect(coordinator.getStats()).toMatchObject({ contexts: 0, worktrees: 0 });
  });

  it('settles an admitted read promptly while retaining its lease until cancellation cleanup completes', async () => {
    const coordinator = createGitExecutionCoordinator({ globalConcurrency: 1 });
    const controller = new AbortController();
    let finishCleanup;
    const pending = coordinator.run({
      context: context(),
      kind: GIT_OPERATION_KIND.READ,
      signal: controller.signal,
    }, () => new Promise((resolve) => {
      controller.signal.addEventListener('abort', () => {
        finishCleanup = () => resolve('cleaned');
      }, { once: true });
    }));
    await waitFor(() => coordinator.getStats().active === 1);

    controller.abort('read cancelled');

    await expect(pending).rejects.toMatchObject({
      code: GIT_EXECUTION_ERROR_CODES.CANCELLED,
    });
    expect(coordinator.getStats()).toMatchObject({ active: 1, pending: 0 });
    finishCleanup?.();
    await waitFor(() => coordinator.getStats().active === 0);
    expect(coordinator.getStats()).toMatchObject({ active: 0, pending: 0 });
  });

  it('can defer an admitted read cancellation until its owned cleanup result is known', async () => {
    const coordinator = createGitExecutionCoordinator({ globalConcurrency: 1 });
    const controller = new AbortController();
    const cleanupBlocked = {
      code: 'ERR_PROCESS_TREE_TERMINATION',
      cleanupBlocked: true,
      descendantsTerminated: false,
    };
    let started = false;
    let settled = false;
    const pending = coordinator.run({
      context: context(),
      kind: GIT_OPERATION_KIND.READ,
      signal: controller.signal,
      waitForCleanup: true,
    }, () => {
      started = true;
      return new Promise((resolve) => {
        controller.signal.addEventListener('abort', () => {
          setTimeout(() => resolve(cleanupBlocked), 10);
        }, { once: true });
      });
    });
    await waitFor(() => started);

    controller.abort('optional Gitignore filter timed out');
    void pending.then(
      () => { settled = true; },
      () => { settled = true; },
    );
    await tick();
    expect(settled).toBe(false);
    expect(coordinator.getStats()).toMatchObject({ active: 1, pending: 0 });

    await expect(pending).resolves.toMatchObject(cleanupBlocked);
    expect(coordinator.getStats()).toMatchObject({ active: 1, pending: 0 });
  });

  it('coalesces full and light status work in the safe direction', async () => {
    const coordinator = createGitExecutionCoordinator({ globalConcurrency: 2 });
    let release;
    let calls = 0;
    const full = coordinator.runStatus({ context: context(), mode: 'full' }, () => {
      calls += 1;
      return new Promise((resolve) => { release = resolve; });
    });
    const light = coordinator.runStatus({ context: context(), mode: 'light' }, (mode) => {
      calls += 1;
      return mode;
    });
    await tick();
    expect(calls).toBe(1);
    release({ files: [], full: true });
    await expect(full).resolves.toEqual({ files: [], full: true });
    await expect(light).resolves.toEqual({ files: [], full: true });
  });

  it('cancels a shared status source once its last waiter leaves and retains state until cleanup', async () => {
    const coordinator = createGitExecutionCoordinator({ globalConcurrency: 2 });
    const firstController = new AbortController();
    const secondController = new AbortController();
    let sourceSignal;
    let releaseSource;
    let cleanupCount = 0;
    let sourceReleased = false;
    let sourceAbortCount = 0;
    const source = coordinator.runStatus({
      context: context(),
      mode: 'full',
      signal: firstController.signal,
    }, (_statusMode, signal) => {
      sourceSignal = signal;
      signal?.addEventListener('abort', () => { sourceAbortCount += 1; }, { once: true });
      return new Promise((resolve) => {
        signal?.addEventListener('abort', () => {
          releaseSource = () => {
            if (sourceReleased) return;
            sourceReleased = true;
            cleanupCount += 1;
            resolve({ files: [] });
          };
        }, { once: true });
      });
    });
    const shared = coordinator.runStatus({
      context: context(),
      mode: 'light',
      signal: secondController.signal,
    }, () => 'never');

    try {
      await waitFor(() => coordinator.getStats().active === 1);
      firstController.abort('first waiter left');
      await expect(source).rejects.toMatchObject({ code: GIT_EXECUTION_ERROR_CODES.CANCELLED });
      expect(sourceSignal).toBeInstanceOf(AbortSignal);
      expect(sourceSignal.aborted).toBe(false);
      expect(coordinator.getStats()).toMatchObject({ active: 1, statusInFlight: 1 });

      secondController.abort('last waiter left');
      await expect(shared).rejects.toMatchObject({ code: GIT_EXECUTION_ERROR_CODES.CANCELLED });
      expect(sourceSignal.aborted).toBe(true);
      expect(sourceAbortCount).toBe(1);
      expect(coordinator.getStats()).toMatchObject({ active: 1, statusInFlight: 1 });
      releaseSource?.();
      await waitFor(() => coordinator.getStats().active === 0
        && coordinator.getStats().statusInFlight === 0);
      expect(cleanupCount).toBe(1);
    } finally {
      releaseSource?.();
      await Promise.allSettled([source, shared]);
    }

    await waitFor(() => coordinator.getStats().active === 0
      && coordinator.getStats().statusInFlight === 0);
    expect(coordinator.getStats()).toMatchObject({ active: 0, statusInFlight: 0 });
  });

  it('retains the status lease when process cleanup is unconfirmed', async () => {
    const coordinator = createGitExecutionCoordinator({ globalConcurrency: 2 });
    const cleanupBlocked = {
      code: 'ERR_PROCESS_TREE_TERMINATION',
      cleanupBlocked: true,
      descendantsTerminated: false,
    };
    const blocked = coordinator.runStatus({ context: context(), mode: 'full' }, () => (
      Promise.reject(cleanupBlocked)
    ));

    await expect(blocked).rejects.toMatchObject(cleanupBlocked);
    expect(coordinator.getStats()).toMatchObject({ active: 1, statusInFlight: 1 });

    let replacementStarted = false;
    const replacement = coordinator.runStatus({ context: context(), mode: 'light' }, () => {
      replacementStarted = true;
      return 'must-not-start';
    });
    await expect(replacement).rejects.toMatchObject(cleanupBlocked);
    expect(replacementStarted).toBe(false);
    expect(coordinator.getStats()).toMatchObject({ active: 1, statusInFlight: 1 });
  });

  it('reconciles a late status close exactly once', async () => {
    const coordinator = createGitExecutionCoordinator({ globalConcurrency: 2 });
    let close;
    const cleanupReconciliation = {
      promise: new Promise((resolve) => { close = resolve; }),
      retire: () => close?.(),
    };
    const blocked = coordinator.runStatus({ context: context(), mode: 'full' }, () => Promise.reject({
      code: 'ERR_PROCESS_TREE_TERMINATION',
      cleanupBlocked: true,
      descendantsTerminated: false,
      cleanupReconciliation,
    }));

    await expect(blocked).rejects.toMatchObject({ cleanupBlocked: true });
    expect(coordinator.getStats()).toMatchObject({ active: 1, statusInFlight: 1 });
    close();
    await waitFor(() => coordinator.getStats().active === 0
      && coordinator.getStats().statusInFlight === 0);
    expect(coordinator.getStats()).toMatchObject({ active: 0, statusInFlight: 0 });
  });

  it('does not reuse a status source that is before a queued mutation', async () => {
    const coordinator = createGitExecutionCoordinator({ globalConcurrency: 2 });
    const calls = [];
    let releaseStatus;
    const first = coordinator.runStatus({ context: context(), mode: 'full' }, () => {
      calls.push('status-before');
      return new Promise((resolve) => { releaseStatus = resolve; });
    });
    await waitFor(() => coordinator.getStats().active === 1);

    const mutation = coordinator.run(
      { context: context(), kind: GIT_OPERATION_KIND.WORKTREE_WRITE },
      () => {
        calls.push('mutation');
        return 'mutated';
      },
    );
    const later = coordinator.runStatus({ context: context(), mode: 'light' }, () => {
      calls.push('status-after');
      return { version: 'after' };
    });
    let laterSettled = false;
    void later.then(
      () => { laterSettled = true; },
      () => { laterSettled = true; },
    );

    await tick();
    expect(laterSettled).toBe(false);
    expect(calls).toEqual(['status-before']);

    releaseStatus({ version: 'before' });
    await expect(first).resolves.toEqual({ version: 'before' });
    await expect(mutation).resolves.toBe('mutated');
    await expect(later).resolves.toEqual({ version: 'after' });
    expect(calls).toEqual(['status-before', 'mutation', 'status-after']);
  });

  it('does not coalesce status sources across worktrees in one repository', async () => {
    const coordinator = createGitExecutionCoordinator({ globalConcurrency: 2 });
    const calls = [];
    let releaseFirst;
    const first = coordinator.runStatus({ context: context('first'), mode: 'full' }, () => {
      calls.push('first');
      return new Promise((resolve) => { releaseFirst = resolve; });
    });
    await waitFor(() => coordinator.getStats().active === 1);

    const second = coordinator.runStatus({ context: context('second'), mode: 'full' }, () => {
      calls.push('second');
      return 'second';
    });

    await expect(second).resolves.toBe('second');
    expect(calls).toEqual(['first', 'second']);
    releaseFirst('first');
    await expect(first).resolves.toBe('first');
  });

  it('keeps a clone destination reserved after releasing network capacity', async () => {
    const coordinator = createGitExecutionCoordinator({
      globalConcurrency: 2,
      globalNetworkConcurrency: 1,
      canonicalizeCloneDestination: async (destination) => path.resolve(destination),
    });
    let release;
    const first = coordinator.runClone({ destination: '/tmp/clone' }, (lease) => {
      lease.releaseNetwork();
      return new Promise((resolve) => { release = resolve; });
    });
    const second = coordinator.runClone({ destination: '/tmp/clone' }, () => 'second');
    await waitFor(() => coordinator.getStats().clonePending === 1);
    expect(coordinator.getStats()).toMatchObject({ active: 1, clonePending: 1, activeNetwork: 0 });
    release('first');
    await expect(first).resolves.toBe('first');
    await expect(second).resolves.toBe('second');
  });

  it('keeps a clone lease and destination reserved when process cleanup is unconfirmed', async () => {
    const coordinator = createGitExecutionCoordinator({
      globalConcurrency: 2,
      globalNetworkConcurrency: 1,
      canonicalizeCloneDestination: async (destination) => path.resolve(destination),
    });
    const blocked = coordinator.runClone({ destination: '/tmp/blocked-clone' }, () => ({
      ok: false,
      cleanupBlocked: true,
      descendantsTerminated: false,
    }));

    await expect(blocked).resolves.toMatchObject({
      cleanupBlocked: true,
      descendantsTerminated: false,
    });
    expect(coordinator.getStats()).toMatchObject({
      active: 1,
      activeNetwork: 1,
      clonePending: 0,
      cloneDestinations: 1,
    });

    const controller = new AbortController();
    const queued = coordinator.runClone({
      destination: '/tmp/blocked-clone',
      signal: controller.signal,
    }, () => 'must-not-start');
    await waitFor(() => coordinator.getStats().clonePending === 1);
    expect(coordinator.getStats()).toMatchObject({ active: 1, activeNetwork: 1, cloneDestinations: 1 });
    controller.abort();
    await expect(queued).rejects.toMatchObject({ code: GIT_EXECUTION_ERROR_CODES.CANCELLED });
    expect(coordinator.getStats()).toMatchObject({
      active: 1,
      activeNetwork: 1,
      clonePending: 0,
      cloneDestinations: 1,
    });
  });

  it('reconciles a late clone close and releases its destination once', async () => {
    const coordinator = createGitExecutionCoordinator({
      globalConcurrency: 2,
      canonicalizeCloneDestination: async (destination) => path.resolve(destination),
    });
    let close;
    const cleanupReconciliation = {
      promise: new Promise((resolve) => { close = resolve; }),
      retire: () => close?.(),
    };
    const blocked = coordinator.runClone({ destination: '/tmp/late-clone' }, () => ({
      cleanupBlocked: true,
      descendantsTerminated: false,
      cleanupReconciliation,
    }));

    await expect(blocked).resolves.toMatchObject({ cleanupBlocked: true });
    expect(coordinator.getStats()).toMatchObject({ active: 1, cloneDestinations: 1, activeNetwork: 1 });
    close();
    await waitFor(() => coordinator.getStats().active === 0
      && coordinator.getStats().cloneDestinations === 0);
    expect(coordinator.getStats()).toMatchObject({ active: 0, cloneDestinations: 0, activeNetwork: 0 });
  });

  it('counts active clones against the global concurrency limit', async () => {
    const coordinator = createGitExecutionCoordinator({
      globalConcurrency: 1,
      canonicalizeCloneDestination: async (destination) => path.resolve(destination),
    });
    let releaseClone;
    let cloneStarted = false;
    const clone = coordinator.runClone({ destination: '/tmp/clone' }, (lease) => {
      cloneStarted = true;
      lease.releaseNetwork();
      return new Promise((resolve) => { releaseClone = resolve; });
    });
    await waitFor(() => cloneStarted);
    const operation = coordinator.run(
      { context: context(), kind: GIT_OPERATION_KIND.READ },
      () => 'operation',
    );

    await waitFor(() => coordinator.getStats().pending === 1);
    expect(coordinator.getStats()).toMatchObject({ active: 1, pending: 1, activeNetwork: 0 });

    releaseClone('clone');
    await expect(clone).resolves.toBe('clone');
    await expect(operation).resolves.toBe('operation');
  });

  it('rejects a queued clone cancellation without settling the active clone', async () => {
    const coordinator = createGitExecutionCoordinator({
      globalConcurrency: 1,
      globalNetworkConcurrency: 1,
      canonicalizeCloneDestination: async (destination) => path.resolve(destination),
    });
    let releaseActive;
    const active = coordinator.runClone({ destination: '/tmp/active-clone' }, () => (
      new Promise((resolve) => { releaseActive = resolve; })
    ));
    await waitFor(() => coordinator.getStats().active === 1);

    const controller = new AbortController();
    const queued = coordinator.runClone({
      destination: '/tmp/queued-clone',
      signal: controller.signal,
    }, () => 'never');
    await waitFor(() => coordinator.getStats().clonePending === 1);

    controller.abort();
    await expect(queued).rejects.toMatchObject({ code: GIT_EXECUTION_ERROR_CODES.CANCELLED });
    expect(coordinator.getStats()).toMatchObject({
      active: 1,
      activeNetwork: 1,
      clonePending: 0,
      cloneDestinations: 1,
    });

    releaseActive('active');
    await expect(active).resolves.toBe('active');
    expect(coordinator.getStats()).toMatchObject({ active: 0, activeNetwork: 0, cloneDestinations: 0 });
  });

  it('coalesces symlinked clone destination aliases without merging distinct destinations', async () => {
    const root = await fsp.mkdtemp(path.join(os.tmpdir(), 'openchamber-git-coordinator-'));
    try {
      const realParent = path.join(root, 'real-parent');
      const aliasParent = path.join(root, 'alias-parent');
      await fsp.mkdir(realParent);
      await fsp.symlink(realParent, aliasParent, 'dir');

      const coordinator = createGitExecutionCoordinator({ globalConcurrency: 4 });
      let release;
      const first = coordinator.runClone({ destination: path.join(realParent, 'clone') }, () => (
        new Promise((resolve) => { release = resolve; })
      ));
      await waitFor(() => coordinator.getStats().active === 1);

      const alias = coordinator.runClone({ destination: path.join(aliasParent, 'clone') }, () => 'alias');
      let distinctStarted = false;
      const distinct = coordinator.runClone({ destination: path.join(realParent, 'other-clone') }, () => {
        distinctStarted = true;
        return 'distinct';
      });

      await expect(distinct).resolves.toBe('distinct');
      await waitFor(() => coordinator.getStats().clonePending === 1);
      expect(distinctStarted).toBe(true);
      expect(coordinator.getStats()).toMatchObject({ active: 1, clonePending: 1 });
      release('first');
      await expect(first).resolves.toBe('first');
      await expect(alias).resolves.toBe('alias');
      expect(coordinator.getStats()).toMatchObject({ active: 0, clonePending: 0, cloneDestinations: 0 });
    } finally {
      await fsp.rm(root, { recursive: true, force: true });
    }
  });

  it('deduplicates Windows clone destinations by casing without changing the supplied path', async () => {
    let release;
    const coordinator = createGitExecutionCoordinator({
      platform: 'win32',
      canonicalizeCloneDestination: async (destination) => destination,
      globalConcurrency: 4,
    });
    const first = coordinator.runClone({ destination: 'C:\\Work\\Skills' }, () => (
      new Promise((resolve) => { release = resolve; })
    ));
    await waitFor(() => coordinator.getStats().active === 1);

    const alias = coordinator.runClone({ destination: 'c:\\work\\skills' }, () => 'alias');
    await waitFor(() => coordinator.getStats().clonePending === 1);
    expect(coordinator.getStats()).toMatchObject({ active: 1, clonePending: 1, cloneDestinations: 1 });

    release('first');
    await expect(first).resolves.toBe('first');
    await expect(alias).resolves.toBe('alias');
    expect(coordinator.getStats()).toMatchObject({ active: 0, clonePending: 0, cloneDestinations: 0 });
  });

  it('evicts an idle Windows worktree when invalidated through a casing alias', async () => {
    const coordinator = createGitExecutionCoordinator({ platform: 'win32' });
    await expect(coordinator.run({
      context: context('C:\\Work\\Repo'),
      kind: GIT_OPERATION_KIND.READ,
    }, () => 'read')).resolves.toBe('read');

    expect(coordinator.invalidateWorktrees('common', ['c:\\work\\repo'])).toBe(1);
    expect(coordinator.getStats()).toMatchObject({ contexts: 0, worktrees: 0 });
  });

  it('holds the execution lease until POSIX process cleanup closes', async () => {
    const coordinator = createGitExecutionCoordinator();
    const child = new EventEmitter();
    child.pid = 987655;
    child.kill = () => {};
    const running = coordinator.run({
      context: context(),
      kind: GIT_OPERATION_KIND.READ,
    }, () => killProcessTree(child, { platform: 'linux', terminationTimeoutMs: 30 }));

    await waitFor(() => coordinator.getStats().active === 1);
    child.emit('close', 137, 'SIGKILL');
    await running;
    expect(coordinator.getStats()).toMatchObject({ active: 0 });
  });
});
