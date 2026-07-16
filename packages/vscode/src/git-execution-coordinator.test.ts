// @ts-expect-error Bun provides this module at test runtime; the extension tsconfig intentionally omits Bun globals.
import { describe, expect, it } from 'bun:test';

import { createGitContextResolver } from './git-context-resolver';
import {
  GIT_OPERATION_KIND,
  GIT_READ_ONLY_ENV,
  createGitExecutionCoordinator,
  type GitExecutionContext,
} from './git-execution-coordinator';
import { GIT_EXECUTION_ERROR_CODES } from './git-execution-errors';

const deferred = <T = void>() => {
  let resolve!: (value: T) => void;
  let reject!: (error: unknown) => void;
  const promise = new Promise<T>((resolvePromise, rejectPromise) => {
    resolve = resolvePromise;
    reject = rejectPromise;
  });
  return { promise, resolve, reject };
};

const context = (common: string, worktree: string): GitExecutionContext => ({
  isRepository: true,
  commonId: `/repos/${common}/.git`,
  worktreeId: JSON.stringify([`/repos/${common}/.git/worktrees/${worktree}`, `/repos/${common}/${worktree}`]),
});

const flushMicrotasks = async () => {
  await Promise.resolve();
  await Promise.resolve();
  await Promise.resolve();
};

describe('VS Code Git execution conflicts and fairness', () => {
  it('blocks same-worktree read/write overlap while unrelated worktrees progress', async () => {
    const coordinator = createGitExecutionCoordinator({ globalConcurrency: 3 });
    const readGate = deferred();
    const events: string[] = [];
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

  it('makes topology a barrier and prevents queued-writer starvation', async () => {
    const coordinator = createGitExecutionCoordinator({ globalConcurrency: 4, readsPerCommonContext: 4 });
    const firstReadGate = deferred();
    const topologyGate = deferred();
    const events: string[] = [];
    const worktreeA = context('shared', 'a');
    const worktreeB = context('shared', 'b');

    const firstRead = coordinator.run({ context: worktreeA, kind: GIT_OPERATION_KIND.READ }, async () => {
      events.push('read:start');
      await firstReadGate.promise;
      events.push('read:end');
    });
    const topology = coordinator.run({ context: worktreeA, kind: GIT_OPERATION_KIND.TOPOLOGY_WRITE }, async () => {
      events.push('topology:start');
      await topologyGate.promise;
      events.push('topology:end');
    });
    const laterReads = Array.from({ length: 8 }, (_, index) => coordinator.run({
      context: index % 2 === 0 ? worktreeA : worktreeB,
      kind: GIT_OPERATION_KIND.READ,
    }, async () => events.push(`later:${index}`)));

    await flushMicrotasks();
    expect(events).toEqual(['read:start']);
    firstReadGate.resolve();
    await flushMicrotasks();
    expect(events).toEqual(['read:start', 'read:end', 'topology:start']);
    topologyGate.resolve();
    await Promise.all([firstRead, topology, ...laterReads]);
    expect(events.indexOf('topology:end')).toBeLessThan(events.indexOf('later:0'));
    expect(coordinator.getGeneration(worktreeA).common).toBe(2);
  });

  it('uses leases for compatible compound work and rejects unsafe re-entry', async () => {
    const coordinator = createGitExecutionCoordinator();
    const worktree = context('shared', 'a');

    await expect(coordinator.run({
      context: worktree,
      kind: GIT_OPERATION_KIND.WORKTREE_WRITE,
    }, (lease) => coordinator.run({
      context: worktree,
      kind: GIT_OPERATION_KIND.READ,
      lease,
    }, async () => 'nested-read'))).resolves.toBe('nested-read');

    await expect(coordinator.run({
      context: worktree,
      kind: GIT_OPERATION_KIND.READ,
    }, (lease) => coordinator.run({
      context: worktree,
      kind: GIT_OPERATION_KIND.WORKTREE_WRITE,
      lease,
    }, async () => 'unsafe-write'))).rejects.toMatchObject({
      code: GIT_EXECUTION_ERROR_CODES.REENTRANCY,
    });
  });

  it('caps network work per common context and globally without blocking local reads', async () => {
    const coordinator = createGitExecutionCoordinator({
      globalConcurrency: 6,
      networkPerCommonContext: 1,
      globalNetworkConcurrency: 2,
    });
    const gate = deferred();
    const events: string[] = [];
    let activeNetwork = 0;
    let maxActiveNetwork = 0;
    const activeByCommon = new Map<string, number>();
    let maxForOneCommon = 0;

    const networkTask = (name: string, operationContext: GitExecutionContext) => coordinator.run({
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
    gate.resolve();
    await Promise.all([first, second, other, third, localRead]);
    expect(maxActiveNetwork).toBe(2);
    expect(maxForOneCommon).toBe(1);
    expect(coordinator.getStats()).toMatchObject({ activeNetwork: 0, pending: 0 });
  });
});

describe('VS Code Git execution bounds, clones, and status', () => {
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

  it('applies backpressure and cleans queued cancellation generations', async () => {
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

    expect(coordinator.getGeneration(worktree).worktree).toBe(1);
    await expect(overloaded).rejects.toMatchObject({ code: GIT_EXECUTION_ERROR_CODES.OVERLOADED });
    controller.abort();
    await expect(cancelled).rejects.toMatchObject({ code: GIT_EXECUTION_ERROR_CODES.CANCELLED });
    expect(coordinator.getGeneration(worktree).worktree).toBe(2);
    gate.resolve();
    await active;
    await expect(queued).resolves.toBe('queued');
    expect(coordinator.getStats()).toMatchObject({ active: 0, pending: 0 });
  });

  it('times out only queued work and advances its mutation generation', async () => {
    let timeoutCallback: (() => void) | null = null;
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

    expect(timeoutCallback).not.toBeNull();
    timeoutCallback!();
    await expect(timedOut).rejects.toMatchObject({
      code: GIT_EXECUTION_ERROR_CODES.QUEUE_TIMEOUT,
      details: { queueTimeoutMs: 25, scope: 'execution-queue' },
    });
    expect(coordinator.getGeneration(worktree).worktree).toBe(2);
    gate.resolve();
    await active;
    expect(coordinator.getStats()).toMatchObject({ active: 0, pending: 0 });
  });

  it('evicts the oldest idle worktree within one common context without count drift', async () => {
    let now = 0;
    const coordinator = createGitExecutionCoordinator({ maxWorktrees: 1, now: () => now });
    const first = context('shared', 'a');
    const second = context('shared', 'b');

    await coordinator.run({ context: first, kind: GIT_OPERATION_KIND.WORKTREE_WRITE }, async () => 'first');
    now = 1;
    await coordinator.run({ context: second, kind: GIT_OPERATION_KIND.WORKTREE_WRITE }, async () => 'second');

    expect(coordinator.getGeneration(first)).toEqual({ common: 0, worktree: 0 });
    expect(coordinator.getGeneration(second)).toEqual({ common: 0, worktree: 2 });
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
    expect(coordinator.getGeneration(rejected)).toEqual({ common: 0, worktree: 0 });
    expect(coordinator.getStats().worktrees).toBe(1);

    gate.resolve();
    await Promise.all([active, queued]);
    expect(coordinator.getStats()).toMatchObject({ active: 0, pending: 0, worktrees: 1 });
  });

  it('decrements worktree totals only for successful invalidation', async () => {
    const coordinator = createGitExecutionCoordinator();
    const first = context('shared', 'a');
    const second = context('shared', 'b');
    await coordinator.run({ context: first, kind: GIT_OPERATION_KIND.READ }, async () => 'first');
    await coordinator.run({ context: second, kind: GIT_OPERATION_KIND.READ }, async () => 'second');

    expect(coordinator.invalidateWorktrees(first.commonId, [first.worktreeId, first.worktreeId])).toBe(1);
    expect(coordinator.invalidateWorktrees(first.commonId, [first.worktreeId])).toBe(0);
    expect(coordinator.getStats().worktrees).toBe(1);
    expect(coordinator.invalidateWorktrees(first.commonId, [second.worktreeId, second.worktreeId])).toBe(1);
    expect(coordinator.invalidateWorktrees(first.commonId, [second.worktreeId])).toBe(0);
    expect(coordinator.getStats().worktrees).toBe(0);
  });

  it('serializes clone destinations and releases network separately from destination ownership', async () => {
    const coordinator = createGitExecutionCoordinator({
      globalConcurrency: 3,
      globalNetworkConcurrency: 1,
      canonicalizeCloneDestination: async (destination) => destination.replace('/alias/..', ''),
    });
    const firstGate = deferred();
    const secondGate = deferred();
    const events: string[] = [];

    const first = coordinator.runClone({ destination: '/tmp/target' }, async (lease) => {
      events.push('first:network');
      lease.releaseNetwork();
      events.push('first:local');
      await firstGate.promise;
    });
    const same = coordinator.runClone({ destination: '/tmp/alias/../target' }, async () => {
      events.push('same');
    });
    const other = coordinator.runClone({ destination: '/tmp/other' }, async () => {
      events.push('other:network');
      await secondGate.promise;
    });

    await flushMicrotasks();
    expect(events).toEqual(['first:network', 'first:local', 'other:network']);
    expect(coordinator.getStats()).toMatchObject({ active: 2, activeNetwork: 1, clonePending: 1 });
    firstGate.resolve();
    secondGate.resolve();
    await Promise.all([first, same, other]);
    expect(events.indexOf('same')).toBeGreaterThan(events.indexOf('first:local'));
    expect(coordinator.getStats()).toMatchObject({ active: 0, activeNetwork: 0, cloneDestinations: 0 });
  });

  it('bounds clone destinations and cleans a cancelled queued reservation', async () => {
    const coordinator = createGitExecutionCoordinator({
      globalConcurrency: 1,
      maxCloneDestinations: 1,
      canonicalizeCloneDestination: async (destination) => destination,
    });
    const gate = deferred<string>();
    const active = coordinator.runClone({ destination: '/tmp/one' }, () => gate.promise);
    await flushMicrotasks();

    await expect(coordinator.runClone({ destination: '/tmp/two' }, async () => 'two'))
      .rejects.toMatchObject({ code: GIT_EXECUTION_ERROR_CODES.OVERLOADED });

    const controller = new AbortController();
    const cancelled = coordinator.runClone({
      destination: '/tmp/one',
      signal: controller.signal,
    }, async () => 'never');
    controller.abort();
    await expect(cancelled).rejects.toMatchObject({ code: GIT_EXECUTION_ERROR_CODES.CANCELLED });
    gate.resolve('done');
    await expect(active).resolves.toBe('done');
    expect(coordinator.getStats()).toMatchObject({ clonePending: 0, cloneDestinations: 0 });
  });

  it('lets full status satisfy light, never the reverse, and removes failures', async () => {
    const coordinator = createGitExecutionCoordinator({ readsPerCommonContext: 2 });
    const worktree = context('shared', 'status');
    const projectStatus = (bundle: Record<'full' | 'light', string>, requestedShape: 'full' | 'light') => bundle[requestedShape];
    const fullGate = deferred<Record<'full' | 'light', string>>();
    let calls = 0;
    const full = coordinator.runStatus({ context: worktree, shape: 'full', projectResult: projectStatus }, async () => {
      calls += 1;
      return fullGate.promise;
    });
    const light = coordinator.runStatus({ context: worktree, shape: 'light', projectResult: projectStatus }, async () => {
      calls += 1;
      return { full: 'unexpected', light: 'unexpected' };
    });
    fullGate.resolve({ full: 'full-result', light: 'light-projection' });
    await expect(full).resolves.toBe('full-result');
    await expect(light).resolves.toBe('light-projection');
    expect(calls).toBe(1);

    const lightGate = deferred<Record<'full' | 'light', string>>();
    const nextLight = coordinator.runStatus({ context: worktree, shape: 'light', projectResult: projectStatus }, async () => {
      calls += 1;
      return lightGate.promise;
    });
    const nextFull = coordinator.runStatus({ context: worktree, shape: 'full', projectResult: projectStatus }, async () => {
      calls += 1;
      return { full: 'second-full', light: 'second-light' };
    });
    lightGate.resolve({ full: 'unused', light: 'first-light' });
    await expect(nextLight).resolves.toBe('first-light');
    await expect(nextFull).resolves.toBe('second-full');
    expect(calls).toBe(3);

    await expect(coordinator.runStatus({ context: worktree }, async () => {
      calls += 1;
      throw new Error('status failed');
    })).rejects.toThrow('status failed');
    expect(coordinator.getStats().statusInFlight).toBe(0);
    await expect(coordinator.runStatus({ context: worktree }, async () => {
      calls += 1;
      return 'recovered';
    })).resolves.toBe('recovered');
    expect(calls).toBe(5);
  });

  it('enforces the status in-flight map bound', async () => {
    const coordinator = createGitExecutionCoordinator({ maxStatusInFlight: 1 });
    const gate = deferred<string>();
    const first = coordinator.runStatus({ context: context('one', 'a') }, () => gate.promise);
    const overloaded = coordinator.runStatus({ context: context('two', 'b') }, async () => 'second');

    await expect(overloaded).rejects.toMatchObject({ code: GIT_EXECUTION_ERROR_CODES.OVERLOADED });
    gate.resolve('first');
    await expect(first).resolves.toBe('first');
    expect(coordinator.getStats().statusInFlight).toBe(0);
  });

  it('uses mutation admission and completion generations to split status work', async () => {
    const coordinator = createGitExecutionCoordinator({ globalConcurrency: 2 });
    const worktree = context('shared', 'generation');
    const firstGate = deferred<string>();
    let statusCalls = 0;
    const firstStatus = coordinator.runStatus({ context: worktree }, async () => {
      statusCalls += 1;
      return firstGate.promise;
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
    firstGate.resolve('before-mutation');
    await expect(firstStatus).resolves.toBe('before-mutation');
    await expect(mutation).resolves.toBe('mutated');
    await expect(secondStatus).resolves.toBe('after-mutation');
    expect(statusCalls).toBe(2);
    expect(coordinator.getGeneration(worktree).worktree).toBe(2);
  });

  it('cancels one status waiter without cancelling shared work', async () => {
    const coordinator = createGitExecutionCoordinator();
    const worktree = context('shared', 'waiters');
    const gate = deferred<string>();
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

  it('keeps optional locks read-only and diagnostics side-effect-free', async () => {
    let now = 0;
    const coordinator = createGitExecutionCoordinator({ idleTtlMs: 10, idlePruneIntervalMs: 1, now: () => now });
    await coordinator.run({ context: context('one', 'a'), kind: GIT_OPERATION_KIND.READ }, async () => 'done');
    now = 11;
    expect(coordinator.getStats().contexts).toBe(1);
    expect(coordinator.getStats().contexts).toBe(1);
    coordinator.pruneIdle();
    expect(coordinator.getStats().contexts).toBe(0);
    expect(GIT_READ_ONLY_ENV).toEqual({ GIT_OPTIONAL_LOCKS: '0' });
    expect(Object.isFrozen(GIT_READ_ONLY_ENV)).toBe(true);
  });
});

describe('VS Code Git execution pathological fan-out correctness guard', () => {
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
        const discovered = discoveryByAlias.get(cwd)!;
        return { success: true, stdout: [discovered.topLevel, discovered.gitDir, discovered.commonDir].join('\n') };
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
    const resolved = await Promise.all(callerWorktrees.map((index) => resolver.resolve(aliases[index]!)));
    const contexts = resolved.filter((entry): entry is Extract<typeof entry, { isRepository: true }> => entry.isRepository);

    expect(contexts).toHaveLength(callerCount);
    expect(discoveryCalls).toBe(worktreeCount);
    expect(discoveryActive).toBe(0);
    expect(maxDiscoveryActive).toBeLessThanOrEqual(2);
    expect(new Set(contexts.map((entry) => entry.commonId)).size).toBe(commonCount);
    expect(new Set(contexts.map((entry) => entry.worktreeId)).size).toBe(worktreeCount);
    expect(contexts.every((entry) => !/(?:session|ses_)/i.test(`${entry.commonId}\n${entry.worktreeId}`))).toBe(true);
    const resolverStats = resolver.getStats();
    expect(resolverStats).toMatchObject({
      inFlightAliases: 0,
      inFlightContexts: 0,
      discovery: { active: 0, pending: 0, concurrency: 2, maxPending: 2048 },
    });
    expect(resolverStats.inFlightAliases).toBeLessThanOrEqual(resolverStats.maxInFlightAliases);
    expect(resolverStats.inFlightContexts).toBeLessThanOrEqual(resolverStats.maxInFlightContexts);
    expect(resolverStats.discovery.pending).toBeLessThanOrEqual(resolverStats.discovery.maxPending);

    const coordinator = createGitExecutionCoordinator();
    let statusOperations = 0;
    let mutationOperations = 0;
    let networkOperations = 0;
    let activeOperations = 0;
    let maxActiveOperations = 0;
    const activeReadsByCommon = new Map<string, number>();
    let maxReadsForOneCommon = 0;
    let activeNetwork = 0;
    let maxActiveNetwork = 0;
    const activeNetworkByCommon = new Map<string, number>();
    let maxNetworkForOneCommon = 0;
    const projectStatus = (bundle: Record<'full' | 'light', string>, requestedShape: 'full' | 'light') => bundle[requestedShape];

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
      activeReadsByCommon.set(resolvedContext.commonId, commonActive - 1);
      return { full: 'full', light: 'light' };
    }));

    const mutationContexts = contexts.slice(observationCount);
    const expectedCommonGenerations = new Map<string, number>();
    const expectedWorktreeGenerations = new Map<string, number>();
    const contextByCommon = new Map<string, GitExecutionContext>();
    const contextByWorktree = new Map<string, GitExecutionContext>();
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
        mutationOperations += 1;
        activeOperations += 1;
        maxActiveOperations = Math.max(maxActiveOperations, activeOperations);
        if (network) {
          networkOperations += 1;
          activeNetwork += 1;
          maxActiveNetwork = Math.max(maxActiveNetwork, activeNetwork);
          const commonActive = (activeNetworkByCommon.get(resolvedContext.commonId) || 0) + 1;
          activeNetworkByCommon.set(resolvedContext.commonId, commonActive);
          maxNetworkForOneCommon = Math.max(maxNetworkForOneCommon, commonActive);
        }
        await Promise.resolve();
        if (network) {
          activeNetwork -= 1;
          activeNetworkByCommon.set(resolvedContext.commonId, (activeNetworkByCommon.get(resolvedContext.commonId) || 1) - 1);
        }
        activeOperations -= 1;
        return 'mutated';
      });
    });

    const results = await Promise.all([...observations, ...mutations]);
    const stats = coordinator.getStats();
    expect(results).toHaveLength(callerCount);
    expect(results.slice(0, observationCount)).toHaveLength(observationCount);
    expect(results.slice(observationCount)).toEqual(Array.from({ length: 600 }, () => 'mutated'));
    expect(statusOperations).toBe(worktreeCount);
    expect(mutations).toHaveLength(600);
    expect(mutationOperations).toBe(600);
    expect(networkOperations).toBe(60);
    expect(networkOperations).toBeGreaterThan(0);
    expect(maxActiveOperations).toBeLessThanOrEqual(stats.limits.globalConcurrency);
    expect(maxReadsForOneCommon).toBeLessThanOrEqual(2);
    expect(maxActiveNetwork).toBeGreaterThan(0);
    expect(maxActiveNetwork).toBeLessThanOrEqual(2);
    expect(maxNetworkForOneCommon).toBeLessThanOrEqual(1);
    for (const [commonId, expected] of expectedCommonGenerations) {
      expect(coordinator.getGeneration(contextByCommon.get(commonId)!).common).toBe(expected);
    }
    for (const [worktreeId, expected] of expectedWorktreeGenerations) {
      expect(coordinator.getGeneration(contextByWorktree.get(worktreeId)!).worktree).toBe(expected);
    }
    expect(stats.limits).toMatchObject({
      readsPerCommonContext: 2,
      networkPerCommonContext: 1,
      globalNetworkConcurrency: 2,
      maxQueuePerContext: 64,
      maxGlobalQueue: 2048,
      maxContexts: 512,
      maxWorktrees: 4096,
      maxStatusInFlight: 2048,
      maxCloneQueue: 256,
      maxCloneQueuePerDestination: 16,
      maxCloneDestinations: 256,
    });
    expect(stats).toMatchObject({
      active: 0,
      pending: 0,
      activeNetwork: 0,
      contexts: commonCount,
      worktrees: worktreeCount,
      statusInFlight: 0,
      clonePending: 0,
      cloneDestinations: 0,
    });
    expect(stats.pending).toBeLessThanOrEqual(stats.limits.maxGlobalQueue);
    expect(stats.contexts).toBeLessThanOrEqual(stats.limits.maxContexts);
    expect(stats.worktrees).toBeLessThanOrEqual(stats.limits.maxWorktrees);
    expect(stats.statusInFlight).toBeLessThanOrEqual(stats.limits.maxStatusInFlight);
    expect(stats.clonePending).toBeLessThanOrEqual(stats.limits.maxCloneQueue);
    expect(stats.cloneDestinations).toBeLessThanOrEqual(stats.limits.maxCloneDestinations);
    // Deterministic queued-writer fairness remains independently covered by the
    // topology/writer-starvation test above; this seeded test targets scale and bounds.
  }, 15_000);
});
