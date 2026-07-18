import { describe, expect, it } from 'vitest';

import { createGitContextResolver } from './context-resolver.js';
import {
  GIT_OPERATION_KIND,
  GIT_READ_ONLY_ENV,
  createGitExecutionCoordinator,
} from './execution-coordinator.js';
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

const context = (common, worktree) => ({
  isRepository: true,
  commonId: `/repos/${common}/.git`,
  worktreeId: JSON.stringify([`/repos/${common}/.git/worktrees/${worktree}`, `/repos/${common}/${worktree}`]),
});

const flushMicrotasks = async () => {
  await Promise.resolve();
  await Promise.resolve();
  await Promise.resolve();
};

const expectExactRejection = async (promise, expectedReason) => {
  let rejected = false;
  let actualReason;
  try {
    await promise;
  } catch (error) {
    rejected = true;
    actualReason = error;
  }
  expect(rejected).toBe(true);
  expect(actualReason).toBe(expectedReason);
};

describe('GitExecutionCoordinator conflicts and fairness', () => {
  it('blocks same-worktree read/write overlap while unrelated worktrees progress', async () => {
    const coordinator = createGitExecutionCoordinator({ globalConcurrency: 3 });
    const readGate = deferred();
    const events = [];
    const worktreeA = context('shared', 'a');
    const worktreeB = context('shared', 'b');

    const readA = coordinator.run({ context: worktreeA, kind: GIT_OPERATION_KIND.READ }, async () => {
      events.push('read-a:start');
      await readGate.promise;
      events.push('read-a:end');
    });
    const writeA = coordinator.run({ context: worktreeA, kind: GIT_OPERATION_KIND.WORKTREE_WRITE }, async () => {
      events.push('write-a');
    });
    const writeB = coordinator.run({ context: worktreeB, kind: GIT_OPERATION_KIND.WORKTREE_WRITE }, async () => {
      events.push('write-b');
    });

    await flushMicrotasks();
    expect(events).toEqual(['read-a:start', 'write-b']);
    readGate.resolve();
    await Promise.all([readA, writeA, writeB]);
    expect(events).toEqual(['read-a:start', 'write-b', 'read-a:end', 'write-a']);
  });

  it('treats topology mutations as barriers without total FIFO for earlier local work', async () => {
    const coordinator = createGitExecutionCoordinator({ globalConcurrency: 3 });
    const localGate = deferred();
    const commonGate = deferred();
    const events = [];
    const worktreeA = context('shared', 'a');
    const worktreeB = context('shared', 'b');

    const local = coordinator.run({ context: worktreeA, kind: GIT_OPERATION_KIND.WORKTREE_WRITE }, async () => {
      events.push('local:start');
      await localGate.promise;
      events.push('local:end');
    });
    const topology = coordinator.run({ context: worktreeA, kind: GIT_OPERATION_KIND.TOPOLOGY_WRITE }, async () => {
      events.push('topology:start');
      await commonGate.promise;
      events.push('topology:end');
    });
    const laterRead = coordinator.run({ context: worktreeB, kind: GIT_OPERATION_KIND.READ }, async () => {
      events.push('read-b');
    });

    await flushMicrotasks();
    expect(events).toEqual(['local:start']);
    localGate.resolve();
    await flushMicrotasks();
    expect(events).toEqual(['local:start', 'local:end', 'topology:start']);
    commonGate.resolve();
    await Promise.all([local, topology, laterRead]);
    expect(events).toEqual(['local:start', 'local:end', 'topology:start', 'topology:end', 'read-b']);
    expect(coordinator.getGeneration(worktreeA).common).toBe(2);
  });

  it('serializes common mutations while unrelated worktree observations progress', async () => {
    const coordinator = createGitExecutionCoordinator({ globalConcurrency: 4 });
    const firstGate = deferred();
    const events = [];
    const worktreeA = context('shared', 'a');
    const worktreeB = context('shared', 'b');

    const firstCommon = coordinator.run({
      context: worktreeA,
      kind: GIT_OPERATION_KIND.COMMON_WRITE,
      targetWorktree: true,
    }, async () => {
      events.push('common-a:start');
      await firstGate.promise;
      events.push('common-a:end');
    });
    const secondCommon = coordinator.run({
      context: worktreeB,
      kind: GIT_OPERATION_KIND.COMMON_WRITE,
    }, async () => {
      events.push('common-b');
    });
    const readB = coordinator.run({ context: worktreeB, kind: GIT_OPERATION_KIND.READ }, async () => {
      events.push('read-b');
    });

    await flushMicrotasks();
    expect(events).toEqual(['common-a:start', 'read-b']);
    firstGate.resolve();
    await Promise.all([firstCommon, secondCommon, readB]);
    expect(events).toEqual(['common-a:start', 'read-b', 'common-a:end', 'common-b']);
  });

  it('prevents a queued writer from being starved by later reads', async () => {
    const coordinator = createGitExecutionCoordinator({ globalConcurrency: 4, readsPerCommonContext: 4 });
    const firstReadGate = deferred();
    const writerGate = deferred();
    const events = [];
    const worktree = context('shared', 'a');

    const firstRead = coordinator.run({ context: worktree, kind: GIT_OPERATION_KIND.READ }, async () => {
      events.push('read-0:start');
      await firstReadGate.promise;
      events.push('read-0:end');
    });
    const writer = coordinator.run({ context: worktree, kind: GIT_OPERATION_KIND.WORKTREE_WRITE }, async () => {
      events.push('writer:start');
      await writerGate.promise;
      events.push('writer:end');
    });
    const laterReads = Array.from({ length: 12 }, (_, index) => coordinator.run({
      context: worktree,
      kind: GIT_OPERATION_KIND.READ,
    }, async () => {
      events.push(`read-${index + 1}`);
    }));

    await flushMicrotasks();
    expect(events).toEqual(['read-0:start']);
    firstReadGate.resolve();
    await flushMicrotasks();
    expect(events).toEqual(['read-0:start', 'read-0:end', 'writer:start']);
    writerGate.resolve();
    await Promise.all([firstRead, writer, ...laterReads]);
    expect(events.indexOf('writer:end')).toBeLessThan(events.indexOf('read-1'));
  });

  it('uses a lease for compatible compound work and rejects incompatible re-entry', async () => {
    const coordinator = createGitExecutionCoordinator();
    const worktree = context('shared', 'a');

    await expect(coordinator.run({
      context: worktree,
      kind: GIT_OPERATION_KIND.WORKTREE_WRITE,
    }, async (lease) => coordinator.run({
      context: worktree,
      kind: GIT_OPERATION_KIND.READ,
      lease,
    }, async () => 'nested-read'))).resolves.toBe('nested-read');

    await expect(coordinator.run({
      context: worktree,
      kind: GIT_OPERATION_KIND.READ,
    }, async (lease) => coordinator.run({
      context: worktree,
      kind: GIT_OPERATION_KIND.WORKTREE_WRITE,
      lease,
    }, async () => 'unsafe-write'))).rejects.toMatchObject({
      code: GIT_EXECUTION_ERROR_CODES.REENTRANCY,
    });

    await expect(coordinator.run({
      context: worktree,
      kind: GIT_OPERATION_KIND.COMMON_WRITE,
      targetWorktree: true,
      network: true,
    }, async (lease) => coordinator.run({
      context: worktree,
      kind: GIT_OPERATION_KIND.COMMON_WRITE,
      targetWorktree: true,
      network: true,
      lease,
    }, async () => 'nested-common-network'))).resolves.toBe('nested-common-network');

    await expect(coordinator.run({
      context: worktree,
      kind: GIT_OPERATION_KIND.TOPOLOGY_WRITE,
    }, async (lease) => coordinator.run({
      context: worktree,
      kind: GIT_OPERATION_KIND.READ,
      network: true,
      lease,
    }, async () => 'unsafe-network'))).rejects.toMatchObject({
      code: GIT_EXECUTION_ERROR_CODES.REENTRANCY,
    });
  });
});

describe('GitExecutionCoordinator network resources', () => {
  it('caps network work per common context and globally without blocking local observations', async () => {
    const coordinator = createGitExecutionCoordinator({
      globalConcurrency: 6,
      networkPerCommonContext: 1,
      globalNetworkConcurrency: 2,
    });
    const gate = deferred();
    const events = [];
    let activeNetwork = 0;
    let maxActiveNetwork = 0;
    const activeByCommon = new Map();
    let maxForOneCommon = 0;

    const networkTask = (name, operationContext) => coordinator.run({
      context: operationContext,
      kind: GIT_OPERATION_KIND.READ,
      network: true,
    }, async () => {
      events.push(name);
      activeNetwork += 1;
      maxActiveNetwork = Math.max(maxActiveNetwork, activeNetwork);
      const commonActive = (activeByCommon.get(operationContext.commonId) || 0) + 1;
      activeByCommon.set(operationContext.commonId, commonActive);
      maxForOneCommon = Math.max(maxForOneCommon, commonActive);
      await gate.promise;
      activeNetwork -= 1;
      activeByCommon.set(operationContext.commonId, commonActive - 1);
    });

    const sharedA = context('shared', 'a');
    const sharedB = context('shared', 'b');
    const first = networkTask('network-shared-a', sharedA);
    const second = networkTask('network-shared-b', sharedB);
    const other = networkTask('network-other', context('other', 'a'));
    const third = networkTask('network-third', context('third', 'a'));
    const localRead = coordinator.run({ context: sharedB, kind: GIT_OPERATION_KIND.READ }, async () => {
      events.push('local-read');
    });

    await flushMicrotasks();
    expect(events).toContain('network-shared-a');
    expect(events).toContain('network-other');
    expect(events).toContain('local-read');
    expect(events).not.toContain('network-shared-b');
    expect(events).not.toContain('network-third');
    expect(coordinator.getStats().activeNetwork).toBe(2);

    gate.resolve();
    await Promise.all([first, second, other, third, localRead]);
    expect(maxActiveNetwork).toBe(2);
    expect(maxForOneCommon).toBe(1);
    expect(coordinator.getStats()).toMatchObject({ activeNetwork: 0, pending: 0 });
  });
});

describe('GitExecutionCoordinator bounds and lifecycle', () => {
  it('preserves falsy rejection reasons and releases operation and clone capacity', async () => {
    const coordinator = createGitExecutionCoordinator({
      canonicalizeCloneDestination: async (destination) => destination,
    });
    const worktree = context('shared', 'falsy-rejection');
    const reasons = [undefined, null, false, 0, ''];

    for (const [index, reason] of reasons.entries()) {
      await expectExactRejection(coordinator.run({
        context: worktree,
        kind: GIT_OPERATION_KIND.WORKTREE_WRITE,
      }, () => Promise.reject(reason)), reason);
      await expectExactRejection(coordinator.runClone({
        destination: `/tmp/falsy-rejection-${index}`,
      }, () => Promise.reject(reason)), reason);
    }

    expect(coordinator.getStats()).toMatchObject({
      active: 0,
      pending: 0,
      activeNetwork: 0,
      statusInFlight: 0,
      clonePending: 0,
      cloneDestinations: 0,
    });
  });

  it('rejects a falsy worktree identity at the internal state boundary', () => {
    const coordinator = createGitExecutionCoordinator();
    const state = coordinator.ensureContext('/repos/shared/.git');

    expect(() => coordinator.ensureWorktree(state, '')).toThrow(TypeError);
    expect(() => coordinator.ensureWorktree(state, '')).toThrow(
      'A worktree identity is required for local Git execution',
    );
    expect(state.worktrees.size).toBe(0);
  });

  it('rejects public worktree-scoped admission without running tasks', async () => {
    const coordinator = createGitExecutionCoordinator();
    const invalidContext = { isRepository: true, commonId: '/repos/shared/.git', worktreeId: '' };
    let taskCalls = 0;
    const task = async () => {
      taskCalls += 1;
    };

    for (const kind of [GIT_OPERATION_KIND.READ, GIT_OPERATION_KIND.WORKTREE_WRITE]) {
      await expect(coordinator.run({ context: invalidContext, kind }, task)).rejects.toThrow(TypeError);
    }

    expect(taskCalls).toBe(0);
    expect(coordinator.getStats()).toMatchObject({ contexts: 0, worktrees: 0, active: 0, pending: 0 });
  });

  it('rejects pre-aborted entry points without retaining state', async () => {
    const calls = { run: 0, status: 0, clone: 0, canonicalize: 0 };
    const coordinator = createGitExecutionCoordinator({
      canonicalizeCloneDestination: async (destination) => {
        calls.canonicalize += 1;
        return destination;
      },
    });
    const controller = new AbortController();
    controller.abort();
    const worktree = context('shared', 'pre-aborted');

    await expect(coordinator.run({
      context: worktree,
      kind: GIT_OPERATION_KIND.READ,
      signal: controller.signal,
    }, async () => {
      calls.run += 1;
    })).rejects.toMatchObject({ code: GIT_EXECUTION_ERROR_CODES.CANCELLED });
    await expect(coordinator.runStatus({ context: worktree, signal: controller.signal }, async () => {
      calls.status += 1;
    })).rejects.toMatchObject({ code: GIT_EXECUTION_ERROR_CODES.CANCELLED });
    await expect(coordinator.runClone({ destination: '/tmp/pre-aborted', signal: controller.signal }, async () => {
      calls.clone += 1;
    })).rejects.toMatchObject({ code: GIT_EXECUTION_ERROR_CODES.CANCELLED });

    expect(calls).toEqual({ run: 0, status: 0, clone: 0, canonicalize: 0 });
    expect(coordinator.getStats()).toMatchObject({
      active: 0,
      pending: 0,
      activeNetwork: 0,
      contexts: 0,
      worktrees: 0,
      statusInFlight: 0,
      clonePending: 0,
      cloneDestinations: 0,
    });
  });

  it('applies per-context backpressure and cleans queued cancellation', async () => {
    const coordinator = createGitExecutionCoordinator({
      globalConcurrency: 1,
      maxQueuePerContext: 2,
      maxGlobalQueue: 10,
    });
    const gate = deferred();
    const worktree = context('shared', 'a');
    const active = coordinator.run({ context: worktree, kind: GIT_OPERATION_KIND.READ }, () => gate.promise);
    const controller = new AbortController();
    const cancelled = coordinator.run({
      context: worktree,
      kind: GIT_OPERATION_KIND.WORKTREE_WRITE,
      signal: controller.signal,
      label: 'queued write',
    }, async () => 'never');
    const queued = coordinator.run({ context: worktree, kind: GIT_OPERATION_KIND.READ }, async () => 'queued');
    const overloaded = coordinator.run({ context: worktree, kind: GIT_OPERATION_KIND.READ }, async () => 'overloaded');

    const admittedGeneration = coordinator.getGeneration(worktree).worktree;
    expect(admittedGeneration).toBe(1);
    await expect(overloaded).rejects.toMatchObject({ code: GIT_EXECUTION_ERROR_CODES.OVERLOADED });
    controller.abort();
    await expect(cancelled).rejects.toMatchObject({ code: GIT_EXECUTION_ERROR_CODES.CANCELLED });
    expect(coordinator.getGeneration(worktree).worktree).toBe(2);
    gate.resolve();
    await expect(active).resolves.toBeUndefined();
    await expect(queued).resolves.toBe('queued');
    expect(coordinator.getStats()).toMatchObject({ active: 0, pending: 0, statusInFlight: 0 });
  });

  it('invalidates mutation generations on ordinary failure', async () => {
    const coordinator = createGitExecutionCoordinator();
    const worktree = context('shared', 'failed-write');

    await expect(coordinator.run({
      context: worktree,
      kind: GIT_OPERATION_KIND.WORKTREE_WRITE,
    }, async () => {
      throw new Error('write failed');
    })).rejects.toThrow('write failed');

    expect(coordinator.getGeneration(worktree).worktree).toBe(2);
    expect(coordinator.getStats()).toMatchObject({ active: 0, pending: 0 });
  });

  it('times out only queued work and cleans its generation state', async () => {
    let timeoutCallback = null;
    const coordinator = createGitExecutionCoordinator({
      globalConcurrency: 1,
      setTimer: (callback) => {
        timeoutCallback = callback;
        return 1;
      },
      clearTimer: () => {},
    });
    const gate = deferred();
    const worktree = context('shared', 'timeout');
    const active = coordinator.run({ context: worktree, kind: GIT_OPERATION_KIND.READ }, () => gate.promise);
    const timedOut = coordinator.run({
      context: worktree,
      kind: GIT_OPERATION_KIND.WORKTREE_WRITE,
      queueTimeoutMs: 25,
      label: 'queued mutation',
    }, async () => 'never');

    expect(timeoutCallback).toBeTypeOf('function');
    timeoutCallback();
    await expect(timedOut).rejects.toMatchObject({
      code: GIT_EXECUTION_ERROR_CODES.QUEUE_TIMEOUT,
      details: { queueTimeoutMs: 25, scope: 'execution-queue' },
    });
    expect(coordinator.getGeneration(worktree).worktree).toBe(2);
    gate.resolve();
    await active;
    expect(coordinator.getStats()).toMatchObject({ active: 0, pending: 0 });
  });

  it('applies global queue backpressure across common contexts', async () => {
    const coordinator = createGitExecutionCoordinator({
      globalConcurrency: 1,
      maxGlobalQueue: 1,
    });
    const gate = deferred();
    const active = coordinator.run({
      context: context('one', 'a'),
      kind: GIT_OPERATION_KIND.READ,
    }, () => gate.promise);
    const queued = coordinator.run({
      context: context('two', 'b'),
      kind: GIT_OPERATION_KIND.READ,
    }, async () => 'queued');
    const overloaded = coordinator.run({
      context: context('three', 'c'),
      kind: GIT_OPERATION_KIND.READ,
    }, async () => 'overloaded');

    await expect(overloaded).rejects.toMatchObject({ code: GIT_EXECUTION_ERROR_CODES.OVERLOADED });
    expect(coordinator.contexts.has(context('three', 'c').commonId)).toBe(false);
    gate.resolve('active');
    await expect(active).resolves.toBe('active');
    await expect(queued).resolves.toBe('queued');
    expect(coordinator.getStats()).toMatchObject({ active: 0, pending: 0 });
  });

  it('bounds retained context/worktree maps and evicts idle state', async () => {
    let now = 0;
    const coordinator = createGitExecutionCoordinator({
      maxContexts: 1,
      maxWorktrees: 1,
      idleTtlMs: 10,
      now: () => now,
    });
    const first = context('one', 'a');
    const second = context('two', 'b');

    await coordinator.run({ context: first, kind: GIT_OPERATION_KIND.READ }, async () => 'first');
    expect(coordinator.getStats()).toMatchObject({ contexts: 1, worktrees: 1 });
    await expect(coordinator.run({ context: second, kind: GIT_OPERATION_KIND.READ }, async () => 'second'))
      .resolves.toBe('second');
    expect([...coordinator.contexts.keys()]).toEqual([second.commonId]);

    now = 11;
    expect(coordinator.getStats()).toMatchObject({ contexts: 1, worktrees: 1 });
  });

  it('evicts the oldest idle worktree within one common context without count drift', async () => {
    let now = 0;
    const coordinator = createGitExecutionCoordinator({ maxWorktrees: 1, now: () => now });
    const first = context('shared', 'a');
    const second = context('shared', 'b');

    await coordinator.run({ context: first, kind: GIT_OPERATION_KIND.WORKTREE_WRITE }, async () => 'first');
    now = 1;
    await coordinator.run({ context: second, kind: GIT_OPERATION_KIND.WORKTREE_WRITE }, async () => 'second');

    expect([...coordinator.contexts.get(first.commonId).worktrees.keys()]).toEqual([second.worktreeId]);
    expect(coordinator.getGeneration(first).worktree).toBe(0);
    expect(coordinator.getGeneration(second).worktree).toBe(2);
    expect(coordinator.getStats()).toMatchObject({ contexts: 1, worktrees: 1 });
  });

  it('removes a newly created worktree state when admission fails', async () => {
    const coordinator = createGitExecutionCoordinator({ globalConcurrency: 1, maxQueuePerContext: 1 });
    const gate = deferred();
    const admitted = context('shared', 'admitted');
    const rejected = context('shared', 'rejected');
    const active = coordinator.run({ context: admitted, kind: GIT_OPERATION_KIND.READ }, () => gate.promise);
    const queued = coordinator.run({ context: admitted, kind: GIT_OPERATION_KIND.READ }, async () => 'queued');

    await expect(coordinator.run({ context: rejected, kind: GIT_OPERATION_KIND.READ }, async () => 'never'))
      .rejects.toMatchObject({ code: GIT_EXECUTION_ERROR_CODES.OVERLOADED });
    expect(coordinator.contexts.get(admitted.commonId).worktrees.has(rejected.worktreeId)).toBe(false);
    expect(coordinator.getStats().worktrees).toBe(1);

    gate.resolve();
    await Promise.all([active, queued]);
    expect(coordinator.getStats()).toMatchObject({ active: 0, pending: 0, worktrees: 1 });
  });

  it('keeps diagnostics side-effect-free while throttled drain pruning evicts expired idle state', async () => {
    let now = 0;
    const coordinator = createGitExecutionCoordinator({
      idleTtlMs: 10,
      idlePruneIntervalMs: 1,
      now: () => now,
    });
    const first = context('one', 'a');

    await coordinator.run({ context: first, kind: GIT_OPERATION_KIND.READ }, async () => 'first');
    const retainedState = coordinator.contexts.get(first.commonId);

    now = 11;
    expect(coordinator.getStats()).toMatchObject({ contexts: 1, worktrees: 1, idleContexts: 1 });
    expect(coordinator.getStats()).toMatchObject({ contexts: 1, worktrees: 1, idleContexts: 1 });
    expect(coordinator.contexts.get(first.commonId)).toBe(retainedState);

    coordinator.drain();
    expect(coordinator.getStats()).toMatchObject({ contexts: 0, worktrees: 0, idleContexts: 0 });
  });

  it('prunes every eligible context from one snapshot pass', async () => {
    const coordinator = createGitExecutionCoordinator();
    const worktrees = [context('one', 'a'), context('two', 'b'), context('three', 'c')];

    await Promise.all(worktrees.map((entry) => coordinator.run({
      context: entry,
      kind: GIT_OPERATION_KIND.READ,
    }, async () => entry.worktreeId)));
    expect(coordinator.getStats()).toMatchObject({ contexts: 3, worktrees: 3, idleContexts: 3 });

    coordinator.pruneIdle({ force: true });
    expect(coordinator.getStats()).toMatchObject({ contexts: 0, worktrees: 0, idleContexts: 0 });
  });

  it('throttles idle pruning but performs it during ordinary admission', async () => {
    let now = 0;
    const coordinator = createGitExecutionCoordinator({
      idleTtlMs: 10,
      idlePruneIntervalMs: 1,
      now: () => now,
    });
    const first = context('one', 'a');
    const second = context('two', 'b');

    await coordinator.run({ context: first, kind: GIT_OPERATION_KIND.READ }, async () => 'first');
    await coordinator.run({ context: second, kind: GIT_OPERATION_KIND.READ }, async () => 'second');
    expect(coordinator.contexts.has(second.commonId)).toBe(true);

    now = 11;
    await coordinator.run({ context: first, kind: GIT_OPERATION_KIND.READ }, async () => 'first-again');
    expect(coordinator.contexts.has(first.commonId)).toBe(true);
    expect(coordinator.contexts.has(second.commonId)).toBe(false);
  });

  it('invalidates only requested idle worktree identities after topology changes', async () => {
    const coordinator = createGitExecutionCoordinator();
    const first = context('shared', 'a');
    const second = context('shared', 'b');
    await coordinator.run({ context: first, kind: GIT_OPERATION_KIND.READ }, async () => 'first');
    await coordinator.run({ context: second, kind: GIT_OPERATION_KIND.READ }, async () => 'second');

    expect(coordinator.invalidateWorktrees(first.commonId, [first.worktreeId])).toBe(1);
    expect(coordinator.contexts.get(first.commonId).worktrees.has(first.worktreeId)).toBe(false);
    expect(coordinator.contexts.get(first.commonId).worktrees.has(second.worktreeId)).toBe(true);
    expect(coordinator.getStats().worktrees).toBe(1);
    expect(coordinator.invalidateWorktrees(first.commonId, [first.worktreeId, first.worktreeId])).toBe(0);
    expect(coordinator.getStats().worktrees).toBe(1);
    expect(coordinator.invalidateWorktrees(first.commonId, [second.worktreeId, second.worktreeId])).toBe(1);
    expect(coordinator.invalidateWorktrees(first.commonId, [second.worktreeId])).toBe(0);
    expect(coordinator.getStats().worktrees).toBe(0);
  });

  it('enforces the status in-flight map bound', async () => {
    const coordinator = createGitExecutionCoordinator({ maxStatusInFlight: 1 });
    const gate = deferred();
    const firstContext = context('one', 'a');
    const secondContext = context('two', 'b');
    const first = coordinator.runStatus({ context: firstContext }, () => gate.promise);
    const overloaded = coordinator.runStatus({ context: secondContext }, async () => 'second');

    await expect(overloaded).rejects.toMatchObject({ code: GIT_EXECUTION_ERROR_CODES.OVERLOADED });
    gate.resolve('first');
    await expect(first).resolves.toBe('first');
    expect(coordinator.getStats().statusInFlight).toBe(0);
  });

  it('defines optional locks as a read-only per-operation environment', () => {
    expect(GIT_READ_ONLY_ENV).toEqual({ GIT_OPTIONAL_LOCKS: '0' });
    expect(Object.isFrozen(GIT_READ_ONLY_ENV)).toBe(true);
  });
});

describe('GitExecutionCoordinator clone reservations', () => {
  it('dispatches clones from mixed pending sources after the clone queue is copied', async () => {
    const coordinator = createGitExecutionCoordinator({
      globalConcurrency: 2,
      canonicalizeCloneDestination: async (destination) => destination,
    });
    const gate = deferred();
    const events = [];
    const worktree = context('shared', 'copy-source');

    const active = coordinator.run({
      context: worktree,
      kind: GIT_OPERATION_KIND.WORKTREE_WRITE,
    }, async () => {
      events.push('active:start');
      await gate.promise;
      events.push('active:end');
    });
    const blocked = coordinator.run({
      context: worktree,
      kind: GIT_OPERATION_KIND.READ,
    }, async () => {
      events.push('blocked');
    });
    await flushMicrotasks();

    const findRunnableIndex = coordinator.findRunnableIndex.bind(coordinator);
    let copiedCloneQueue = false;
    coordinator.findRunnableIndex = (state) => {
      if (!copiedCloneQueue && coordinator.clonePending.length > 0) {
        coordinator.clonePending = [...coordinator.clonePending];
        copiedCloneQueue = true;
      }
      return findRunnableIndex(state);
    };

    const clone = coordinator.runClone({ destination: '/tmp/copied-source' }, async () => {
      events.push('clone');
      return 'cloned';
    });
    await expect(clone).resolves.toBe('cloned');
    expect(copiedCloneQueue).toBe(true);
    expect(events).toEqual(['active:start', 'clone']);

    gate.resolve();
    await Promise.all([active, blocked]);
    expect(events).toEqual(['active:start', 'clone', 'active:end', 'blocked']);
    expect(coordinator.getStats()).toMatchObject({ active: 0, pending: 0, clonePending: 0 });
  });

  it('serializes canonical destinations and shares the global network cap', async () => {
    const coordinator = createGitExecutionCoordinator({
      globalConcurrency: 4,
      globalNetworkConcurrency: 2,
      canonicalizeCloneDestination: async (destination) => destination.replace('/alias/..', ''),
    });
    const gate = deferred();
    const activeDestinations = new Set();
    let maxActive = 0;
    const events = [];

    const clone = (destination, name) => coordinator.runClone({ destination }, async (lease) => {
      expect(activeDestinations.has(lease.destinationId)).toBe(false);
      activeDestinations.add(lease.destinationId);
      maxActive = Math.max(maxActive, activeDestinations.size);
      events.push(name);
      await gate.promise;
      activeDestinations.delete(lease.destinationId);
      return name;
    });

    const first = clone('/tmp/target', 'first');
    const sameDestination = clone('/tmp/alias/../target', 'same-destination');
    const other = clone('/tmp/other', 'other');
    const third = clone('/tmp/third', 'third');
    await flushMicrotasks();

    expect(events).toEqual(['first', 'other']);
    expect(coordinator.getStats()).toMatchObject({
      active: 2,
      activeNetwork: 2,
      pending: 2,
      clonePending: 2,
      cloneDestinations: 3,
    });

    gate.resolve();
    await expect(Promise.all([first, sameDestination, other, third])).resolves.toEqual([
      'first',
      'same-destination',
      'other',
      'third',
    ]);
    expect(maxActive).toBe(2);
    expect(coordinator.getStats()).toMatchObject({
      active: 0,
      activeNetwork: 0,
      pending: 0,
      clonePending: 0,
      cloneDestinations: 0,
    });
  });

  it('keeps the destination reserved after clone network work is released', async () => {
    const coordinator = createGitExecutionCoordinator({
      globalConcurrency: 2,
      globalNetworkConcurrency: 1,
      canonicalizeCloneDestination: async (destination) => destination,
    });
    const firstGate = deferred();
    const secondGate = deferred();
    const events = [];

    const first = coordinator.runClone({ destination: '/tmp/one' }, async (lease) => {
      events.push('first:clone');
      lease.releaseNetwork();
      events.push('first:local');
      await firstGate.promise;
    });
    const second = coordinator.runClone({ destination: '/tmp/two' }, async () => {
      events.push('second:clone');
      await secondGate.promise;
    });

    await flushMicrotasks();
    expect(events).toEqual(['first:clone', 'first:local', 'second:clone']);
    expect(coordinator.getStats()).toMatchObject({ active: 2, activeNetwork: 1, cloneDestinations: 2 });

    firstGate.resolve();
    secondGate.resolve();
    await Promise.all([first, second]);
    expect(coordinator.getStats()).toMatchObject({ active: 0, activeNetwork: 0, cloneDestinations: 0 });
  });

  it('bounds destinations and cleans a cancelled queued reservation', async () => {
    const coordinator = createGitExecutionCoordinator({
      globalConcurrency: 1,
      maxCloneDestinations: 1,
      canonicalizeCloneDestination: async (destination) => destination,
    });
    const gate = deferred();
    const active = coordinator.runClone({ destination: '/tmp/one' }, () => gate.promise);
    await flushMicrotasks();

    await expect(coordinator.runClone({ destination: '/tmp/two' }, async () => 'two'))
      .rejects.toMatchObject({ code: GIT_EXECUTION_ERROR_CODES.OVERLOADED });

    const controller = new AbortController();
    const cancelled = coordinator.runClone({
      destination: '/tmp/one',
      signal: controller.signal,
    }, async () => 'never');
    await flushMicrotasks();
    controller.abort();
    await expect(cancelled).rejects.toMatchObject({ code: GIT_EXECUTION_ERROR_CODES.CANCELLED });

    gate.resolve('done');
    await expect(active).resolves.toBe('done');
    expect(coordinator.getStats()).toMatchObject({ clonePending: 0, cloneDestinations: 0 });
  });
});

describe('GitExecutionCoordinator status semantics', () => {
  const projectStatus = (bundle, requestedShape) => bundle[requestedShape];

  it('lets full status satisfy light but never lets light satisfy full', async () => {
    const coordinator = createGitExecutionCoordinator({ readsPerCommonContext: 2 });
    const worktree = context('shared', 'a');
    const fullGate = deferred();
    let calls = 0;
    const full = coordinator.runStatus({ context: worktree, shape: 'full', projectResult: projectStatus }, async () => {
      calls += 1;
      return fullGate.promise;
    });
    const lightFromFull = coordinator.runStatus({ context: worktree, shape: 'light', projectResult: projectStatus }, async () => {
      calls += 1;
      return { light: 'unexpected' };
    });
    fullGate.resolve({ full: 'full-result', light: 'light-projection' });

    await expect(full).resolves.toBe('full-result');
    await expect(lightFromFull).resolves.toBe('light-projection');
    expect(calls).toBe(1);

    const lightGate = deferred();
    const nextLight = coordinator.runStatus({ context: worktree, shape: 'light', projectResult: projectStatus }, async () => {
      calls += 1;
      return lightGate.promise;
    });
    const nextFull = coordinator.runStatus({ context: worktree, shape: 'full', projectResult: projectStatus }, async () => {
      calls += 1;
      return { full: 'second-full', light: 'second-light' };
    });
    lightGate.resolve({ light: 'first-light' });

    await expect(nextLight).resolves.toBe('first-light');
    await expect(nextFull).resolves.toBe('second-full');
    expect(calls).toBe(3);
  });

  it('does not cache failures and removes failed in-flight work', async () => {
    const coordinator = createGitExecutionCoordinator();
    const worktree = context('shared', 'a');
    let calls = 0;

    await expect(coordinator.runStatus({ context: worktree }, async () => {
      calls += 1;
      throw new Error('status failed');
    })).rejects.toThrow('status failed');
    expect(coordinator.getStats().statusInFlight).toBe(0);
    await expect(coordinator.runStatus({ context: worktree }, async () => {
      calls += 1;
      return 'recovered';
    })).resolves.toBe('recovered');
    expect(calls).toBe(2);
  });

  it('cancels one waiter without cancelling shared status work', async () => {
    const coordinator = createGitExecutionCoordinator();
    const worktree = context('shared', 'a');
    const gate = deferred();
    const controller = new AbortController();
    let calls = 0;
    const cancelled = coordinator.runStatus({ context: worktree, signal: controller.signal }, async () => {
      calls += 1;
      return gate.promise;
    });
    const surviving = coordinator.runStatus({ context: worktree }, async () => {
      calls += 1;
      return 'unexpected';
    });

    controller.abort();
    await expect(cancelled).rejects.toMatchObject({ code: GIT_EXECUTION_ERROR_CODES.CANCELLED });
    gate.resolve('shared-result');
    await expect(surviving).resolves.toBe('shared-result');
    expect(calls).toBe(1);
  });

  it('uses mutation admission and completion generations to split status work', async () => {
    const coordinator = createGitExecutionCoordinator({ globalConcurrency: 2 });
    const worktree = context('shared', 'a');
    const firstStatusGate = deferred();
    let statusCalls = 0;
    const firstStatus = coordinator.runStatus({ context: worktree }, async () => {
      statusCalls += 1;
      return firstStatusGate.promise;
    });
    const mutation = coordinator.run({
      context: worktree,
      kind: GIT_OPERATION_KIND.WORKTREE_WRITE,
    }, async () => 'mutated');
    const secondStatus = coordinator.runStatus({ context: worktree }, async () => {
      statusCalls += 1;
      return 'after-mutation';
    });

    expect(coordinator.getGeneration(worktree).worktree).toBe(1);
    firstStatusGate.resolve('before-mutation');
    await expect(firstStatus).resolves.toBe('before-mutation');
    await expect(mutation).resolves.toBe('mutated');
    await expect(secondStatus).resolves.toBe('after-mutation');
    expect(statusCalls).toBe(2);
    expect(coordinator.getGeneration(worktree).worktree).toBe(2);
  });
});

describe('Git execution pathological fan-out correctness guard', () => {
  it('coordinates a synthetic 30,000-caller burst across bounded state', async () => {
    const worktreeCount = 300;
    const commonCount = 200;
    const callerCount = 30_000;
    const observationCount = 29_400;
    const aliases = Array.from({ length: worktreeCount }, (_, index) => `/aliases/worktree-${index}`);
    const discoveryByAlias = new Map(aliases.map((alias, index) => {
      const commonIndex = index % commonCount;
      return [alias, {
        topLevel: `/repos/common-${commonIndex}/worktrees/worktree-${index}`,
        gitDir: `/repos/common-${commonIndex}/.git/worktrees/worktree-${index}`,
        commonDir: `/repos/common-${commonIndex}/.git`,
      }];
    }));
    let discoveryCalls = 0;
    let discoveryActive = 0;
    let maxDiscoveryActive = 0;
    const resolver = createGitContextResolver({
      realpath: async (value) => value,
      runGit: async (cwd) => {
        discoveryCalls += 1;
        discoveryActive += 1;
        maxDiscoveryActive = Math.max(maxDiscoveryActive, discoveryActive);
        await Promise.resolve();
        discoveryActive -= 1;
        const discovered = discoveryByAlias.get(cwd);
        return {
          success: true,
          stdout: [discovered.topLevel, discovered.gitDir, discovered.commonDir].join('\n'),
        };
      },
    });

    let seed = 0x2233;
    const nextSeededIndex = () => {
      seed = (Math.imul(seed, 1664525) + 1013904223) >>> 0;
      return seed % worktreeCount;
    };
    const callerWorktrees = [
      ...Array.from({ length: worktreeCount }, (_, index) => index),
      ...Array.from({ length: callerCount - worktreeCount }, nextSeededIndex),
    ];
    const contexts = await Promise.all(callerWorktrees.map((index) => resolver.resolve(aliases[index])));

    expect(discoveryCalls).toBe(worktreeCount);
    expect(maxDiscoveryActive).toBeLessThanOrEqual(2);
    expect(new Set(contexts.map((resolved) => resolved.commonId)).size).toBe(commonCount);
    expect(new Set(contexts.map((resolved) => resolved.worktreeId)).size).toBe(worktreeCount);
    expect(resolver.getStats()).toMatchObject({
      inFlightAliases: 0,
      inFlightContexts: 0,
      discovery: { active: 0, pending: 0 },
    });

    const coordinator = createGitExecutionCoordinator();
    let statusOperations = 0;
    let activeOperations = 0;
    let maxActiveOperations = 0;
    const activeReadsByCommon = new Map();
    let maxReadsForOneCommon = 0;
    let activeNetwork = 0;
    let maxActiveNetwork = 0;
    const activeNetworkByCommon = new Map();
    let maxNetworkForOneCommon = 0;
    const projectStatus = (bundle, requestedShape) => bundle[requestedShape];
    const observations = contexts.slice(0, observationCount).map((resolvedContext, index) => coordinator.runStatus({
      context: resolvedContext,
      shape: index < worktreeCount ? 'full' : 'light',
      projectResult: projectStatus,
    }, async () => {
      statusOperations += 1;
      activeOperations += 1;
      maxActiveOperations = Math.max(maxActiveOperations, activeOperations);
      const commonActive = (activeReadsByCommon.get(resolvedContext.commonId) || 0) + 1;
      activeReadsByCommon.set(resolvedContext.commonId, commonActive);
      maxReadsForOneCommon = Math.max(maxReadsForOneCommon, commonActive);
      await Promise.resolve();
      activeOperations -= 1;
      if (commonActive === 1) {
        activeReadsByCommon.delete(resolvedContext.commonId);
      } else {
        activeReadsByCommon.set(resolvedContext.commonId, commonActive - 1);
      }
      return { full: 'full', light: 'light' };
    }));

    const mutationContexts = contexts.slice(observationCount);
    const expectedCommonGenerations = new Map();
    const expectedWorktreeGenerations = new Map();
    const contextByCommon = new Map();
    const contextByWorktree = new Map();
    const mutations = mutationContexts.map((resolvedContext, index) => {
      const commonMutation = index % 2 === 1;
      const network = commonMutation && index % 10 === 1;
      contextByCommon.set(resolvedContext.commonId, resolvedContext);
      contextByWorktree.set(resolvedContext.worktreeId, resolvedContext);
      if (commonMutation) {
        expectedCommonGenerations.set(
          resolvedContext.commonId,
          (expectedCommonGenerations.get(resolvedContext.commonId) || 0) + 2,
        );
      } else {
        expectedWorktreeGenerations.set(
          resolvedContext.worktreeId,
          (expectedWorktreeGenerations.get(resolvedContext.worktreeId) || 0) + 2,
        );
      }
      return coordinator.run({
        context: resolvedContext,
        kind: commonMutation ? GIT_OPERATION_KIND.COMMON_WRITE : GIT_OPERATION_KIND.WORKTREE_WRITE,
        targetWorktree: commonMutation && index % 4 === 1,
        network,
      }, async () => {
        activeOperations += 1;
        maxActiveOperations = Math.max(maxActiveOperations, activeOperations);
        if (network) {
          activeNetwork += 1;
          maxActiveNetwork = Math.max(maxActiveNetwork, activeNetwork);
          const commonActive = (activeNetworkByCommon.get(resolvedContext.commonId) || 0) + 1;
          activeNetworkByCommon.set(resolvedContext.commonId, commonActive);
          maxNetworkForOneCommon = Math.max(maxNetworkForOneCommon, commonActive);
        }
        await Promise.resolve();
        if (network) {
          activeNetwork -= 1;
          activeNetworkByCommon.set(
            resolvedContext.commonId,
            (activeNetworkByCommon.get(resolvedContext.commonId) || 1) - 1,
          );
        }
        activeOperations -= 1;
        return 'mutated';
      });
    });

    const results = await Promise.all([...observations, ...mutations]);
    const stats = coordinator.getStats();
    expect(results).toHaveLength(callerCount);
    expect(results.slice(0, worktreeCount).every((value) => value === 'full')).toBe(true);
    expect(results.slice(worktreeCount, observationCount).every((value) => value === 'light')).toBe(true);
    expect(results.slice(observationCount).every((value) => value === 'mutated')).toBe(true);
    expect(statusOperations).toBe(worktreeCount);
    expect(maxActiveOperations).toBeLessThanOrEqual(stats.limits.globalConcurrency);
    expect(maxReadsForOneCommon).toBeLessThanOrEqual(2);
    expect(maxActiveNetwork).toBeLessThanOrEqual(2);
    expect(maxNetworkForOneCommon).toBeLessThanOrEqual(1);
    for (const [commonId, expected] of expectedCommonGenerations) {
      expect(coordinator.getGeneration(contextByCommon.get(commonId)).common).toBe(expected);
    }
    for (const [worktreeId, expected] of expectedWorktreeGenerations) {
      expect(coordinator.getGeneration(contextByWorktree.get(worktreeId)).worktree).toBe(expected);
    }
    expect(stats.limits).toMatchObject({
      readsPerCommonContext: 2,
      maxQueuePerContext: 64,
      maxGlobalQueue: 2048,
      maxContexts: 512,
      maxWorktrees: 4096,
      maxStatusInFlight: 2048,
      networkPerCommonContext: 1,
      globalNetworkConcurrency: 2,
      maxCloneQueue: 256,
      maxCloneQueuePerDestination: 16,
      maxCloneDestinations: 256,
    });
    expect(stats.limits.globalConcurrency).toBeGreaterThanOrEqual(2);
    expect(stats.limits.globalConcurrency).toBeLessThanOrEqual(8);
    expect(stats).toMatchObject({ active: 0, pending: 0, statusInFlight: 0 });
    expect(stats.contexts).toBeLessThanOrEqual(commonCount);
    expect(stats.worktrees).toBeLessThanOrEqual(worktreeCount);
    expect([...coordinator.contexts.keys()].some((key) => key.includes('session'))).toBe(false);
  }, 15_000);
});
