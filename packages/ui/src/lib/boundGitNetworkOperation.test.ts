import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import type {
  GitContributorDestinationCandidates,
  GitBranch,
  GitNetworkOperation,
  GitNetworkOperationPlan,
  GitNetworkOperationRequest,
  GitStatus,
  SourceControlBindingRead,
} from '@/lib/api/types';
import { GitNetworkOperationRequestError } from '@/lib/api/types';
import {
  BoundGitNetworkOperationError,
  buildBoundBranchPushRequest,
  buildBoundGitNetworkOperationRequest,
  interpretGitNetworkTerminalOperation,
  runBoundGitNetworkOperation,
  runContributorAwareSync,
  runContributorAwarePush,
  runContributorPush,
  runBoundRemoteBranchDelete,
  runGitClone,
  runCheckoutHydration,
  prepareGitPublish,
  runPreparedGitPublish,
  GitOperationResultError,
  refreshGitOperation,
  type GitOperationRead,
} from './boundGitNetworkOperation';

const originalWindow = Object.getOwnPropertyDescriptor(globalThis, 'window');
beforeEach(() => {
  const values = new Map<string, string>();
  Object.defineProperty(globalThis, 'window', { configurable: true, value: { sessionStorage: {
    getItem: (key: string) => values.get(key) ?? null,
    setItem: (key: string, value: string) => { values.set(key, value); },
  } } });
});
afterEach(() => {
  if (originalWindow) Object.defineProperty(globalThis, 'window', originalWindow);
  else Reflect.deleteProperty(globalThis, 'window');
});

const FETCH_ENDPOINT = { displayUrl: 'https://example.com/team/repo.git', fingerprint: 'f'.repeat(64) };
const PUSH_ENDPOINT = { displayUrl: 'ssh://git@example.com/team/repo.git', fingerprint: 'a'.repeat(64) };
const status: GitStatus = {
  current: 'feature/local',
  tracking: 'upstream/feature/published',
  ahead: 1,
  behind: 2,
  files: [],
  isClean: true,
};
const targets = {
  fetch: { remoteName: 'upstream', ref: 'refs/heads/feature/published' },
  push: { remoteName: 'upstream', ref: 'refs/heads/feature/published' },
};
const boundRead: SourceControlBindingRead = {
  status: 'bound',
  repository: {
    repositoryId: 'repository-one',
    configRevision: 'config-one',
    bare: false,
    remotes: [{ name: 'upstream', fetch: FETCH_ENDPOINT, push: PUSH_ENDPOINT }],
  },
  revision: 7,
  binding: {
    repositoryId: 'repository-one',
    revision: 7,
    state: 'bound',
    configRevision: 'config-one',
    providers: [],
    auxiliary: [],
    remotes: [{
      name: 'upstream',
      fetch: FETCH_ENDPOINT,
      push: PUSH_ENDPOINT,
      mode: 'managed',
      credentialId: 'credential-one',
      readiness: 'ready',
    }],
  },
};

const syncTarget = {
  operation: 'sync' as const,
  repositoryId: 'repository-one',
  bindingRevision: 7,
  configRevision: 'config-one',
  fetch: {
    name: 'upstream', endpoint: FETCH_ENDPOINT,
    sourceRef: 'refs/heads/feature/published', destinationRef: 'refs/remotes/upstream/feature/published',
  },
  pull: { destinationRef: 'refs/heads/feature/local' },
  push: {
    name: 'upstream', endpoint: PUSH_ENDPOINT,
    sourceRef: 'refs/heads/feature/local', destinationRef: 'refs/heads/feature/published',
  },
};
const transport = {
  fetch: { mode: 'managed' as const, verification: { status: 'verified' as const, method: 'credential' as const } },
  push: { mode: 'managed' as const, verification: { status: 'verified' as const, method: 'credential' as const } },
};
const successfulSteps = [
  { step: 'fetch' as const, status: 'succeeded' as const },
  { step: 'pull' as const, status: 'succeeded' as const },
  { step: 'push' as const, status: 'succeeded' as const },
];
const contributorDestinations: GitContributorDestinationCandidates = {
  kind: 'contributor',
  repositoryId: 'repository-one',
  bindingRevision: 7,
  configRevision: 'config-one',
  provenanceRevision: 2,
  candidates: [{
    remote: { name: 'upstream', endpoint: PUSH_ENDPOINT },
    transportMode: 'managed',
    classification: 'contributor-fork',
  }],
};

const plan: GitNetworkOperationPlan = {
  operationId: 'operation-one',
  runtimeIdentity: { id: 'server-one', platform: 'desktop' },
  transport,
  target: syncTarget,
  completedSteps: [],
  state: 'planned',
};

const getNetworkOperation = async (): Promise<GitNetworkOperation> => { throw new Error('Unexpected operation recovery'); };

const captureBoundErrorCode = (callback: () => void): BoundGitNetworkOperationError['code'] | null => {
  try {
    callback();
    return null;
  } catch (error) {
    return error instanceof BoundGitNetworkOperationError ? error.code : null;
  }
};

// `subtle` is a non-configurable getter on the Crypto prototype under Bun, so the
// property cannot be shadowed. Stand in for the whole global instead, keeping the
// random generators the rest of the suite may reach for.
const withoutSubtle = async <T>(run: () => Promise<T>): Promise<T> => {
  const real = globalThis.crypto;
  const descriptor = Object.getOwnPropertyDescriptor(globalThis, 'crypto');
  const stub = {
    getRandomValues: <A extends ArrayBufferView>(array: A): A => real.getRandomValues(array),
    randomUUID: () => real.randomUUID(),
  };
  Object.defineProperty(globalThis, 'crypto', { configurable: true, writable: true, value: stub });
  try {
    // Fail loudly rather than let the fallback silently stop being covered.
    if (globalThis.crypto?.subtle) throw new Error('SubtleCrypto is still reachable');
    return await run();
  } finally {
    if (descriptor) Object.defineProperty(globalThis, 'crypto', descriptor);
    else Reflect.deleteProperty(globalThis, 'crypto');
  }
};

describe('managed push announcement', () => {
  // Changes and walkthrough refresh a published pull request diff on this
  // signal; the panel pushes through managed operations, not the HTTP adapter.
  const announced: string[] = [];
  let unsubscribe = () => {};
  beforeEach(async () => {
    announced.length = 0;
    const { subscribeGitPush } = await import('@/lib/gitPushEvents');
    unsubscribe = subscribeGitPush((scope) => { announced.push(scope); });
  });
  afterEach(() => unsubscribe());
  const runSync = (execute: () => Promise<GitNetworkOperation>) => runBoundGitNetworkOperation({
    action: 'sync', directory: '/repo', remoteName: 'upstream', status, targets,
    sourceControl: { repositoryBinding: async () => boundRead }, runtimeKey: () => 'runtime-one',
    git: { planNetworkOperation: async () => plan, executeNetworkOperation: execute, getNetworkOperation },
  });

  test('a confirmed sync announces its directory once, against the captured runtime', async () => {
    const { gitPushScopeKey } = await import('@/lib/gitPushEvents');
    await runSync(async () => ({ ...plan, state: 'succeeded', stepResults: successfulSteps }));
    expect(announced).toEqual([gitPushScopeKey('/repo', 'runtime-one')]);
  });

  test('a sync that did not succeed announces nothing', async () => {
    await expect(runSync(async () => ({
      ...plan, state: 'failed', stepResults: [], error: { code: 'TRANSPORT_FAILED', message: 'rejected' },
    }))).rejects.toThrow();
    expect(announced).toEqual([]);
  });
});

describe('structured Git operation recovery', () => {
  test('anonymous bindings permit reads but block publishing before a plan request', async () => {
    const anonymous: SourceControlBindingRead = { ...boundRead, binding: { ...boundRead.binding,
      remotes: [{ name: 'upstream', fetch: FETCH_ENDPOINT, push: PUSH_ENDPOINT, mode: 'anonymous', readiness: 'ready' }],
    } };
    for (const action of ['fetch', 'pull'] as const) {
      const request = buildBoundGitNetworkOperationRequest({ action, bindingRead: anonymous, directory: '/repo', remoteName: 'upstream', status });
      expect('transportMode' in request ? request.transportMode : null).toBe('anonymous');
    }
    expect(() => buildBoundGitNetworkOperationRequest({ action: 'sync', bindingRead: anonymous, directory: '/repo', remoteName: 'upstream', status, targets })).toThrow('anonymous-read-only');
    expect(() => buildBoundBranchPushRequest({ bindingRead: anonymous, branch: 'main', directory: '/repo', remoteName: 'upstream', destinationRef: 'refs/heads/main' })).toThrow('anonymous-read-only');
    let plans = 0;
    await expect(runBoundRemoteBranchDelete({ branch: 'main', directory: '/repo', remoteName: 'upstream', runtimeKey: () => 'runtime-one',
      sourceControl: { repositoryBinding: async () => anonymous }, git: {
        planNetworkOperation: async () => { plans += 1; return plan; }, executeNetworkOperation: async () => plan, getNetworkOperation,
      } })).rejects.toThrow('anonymous-read-only');
    expect(plans).toBe(0);
  });
  const run = (git: Parameters<typeof runBoundGitNetworkOperation>[0]['git'], onOperation?: (read: GitOperationRead) => void) => runBoundGitNetworkOperation({
    action: 'sync', directory: '/repo', remoteName: 'upstream', status, targets,
    sourceControl: { repositoryBinding: async () => boundRead }, git, runtimeKey: () => 'runtime-one', onOperation,
  });

  test('ordinary LAN plan and execute work without SubtleCrypto and keep persistence enabled', async () => {
    await withoutSubtle(async () => {
      const calls: string[] = [];
      const storage = window.sessionStorage;
      const result = await runBoundGitNetworkOperation({
        action: 'sync', directory: '/repo', remoteName: 'upstream', status, targets,
        sourceControl: { repositoryBinding: async () => boundRead }, runtimeKey: () => 'url:http://192.168.1.20:3000',
        git: {
          planNetworkOperation: async () => { calls.push('plan'); return plan; },
          executeNetworkOperation: async (id) => {
            calls.push(`execute:${id}`);
            const persisted = storage.getItem('openchamber.git.pending-operations.v1');
            expect(persisted).toContain(plan.operationId);
            expect(persisted).not.toContain('https://');
            expect(persisted).not.toContain('192.168.1.20');
            expect(persisted).not.toContain('credential-one');
            return { ...plan, state: 'succeeded', stepResults: successfulSteps };
          },
          getNetworkOperation,
        },
      });
      expect(result.state).toBe('succeeded');
      expect(calls).toEqual(['plan', 'execute:operation-one']);
      expect(storage.getItem('openchamber.git.pending-operations.v1')).toBe('{"version":1,"references":[]}');
    });
  });

  for (const failAt of [1, 2, 3]) {
    test(`storage failure at durability write ${failAt} never dispatches execute`, async () => {
      const storage = window.sessionStorage;
      const save = storage.setItem;
      let writes = 0;
      storage.setItem = (key, value) => {
        if (++writes === failAt) throw new Error('storage denied');
        save(key, value);
      };
      let plans = 0;
      let executes = 0;
      await expect(run({
        planNetworkOperation: async () => { plans += 1; return plan; },
        executeNetworkOperation: async () => { executes += 1; return { ...plan, state: 'succeeded', stepResults: successfulSteps }; },
        getNetworkOperation,
      })).rejects.toThrow(/storage/);
      expect(plans).toBe(failAt === 1 ? 0 : 1);
      expect(executes).toBe(0);
    });
  }

  test('a lost execute response retrieves the original ID without a second plan or dispatch', async () => {
    const calls: string[] = [];
    const reads: GitOperationRead[] = [];
    const completion: GitNetworkOperation = { ...plan, state: 'succeeded', stepResults: successfulSteps };
    const result = await run({
      planNetworkOperation: async () => { calls.push('plan'); return plan; },
      executeNetworkOperation: async (id) => { calls.push(`execute:${id}`); throw new TypeError('disconnected'); },
      getNetworkOperation: async (id) => { calls.push(`get:${id}`); return completion; },
    }, (read) => reads.push(read));
    expect(result).toBe(completion);
    expect(calls).toEqual(['plan', 'execute:operation-one', 'get:operation-one']);
    expect(reads[0]).toEqual({ runtimeKey: 'runtime-one', operation: plan, availability: 'available' });
    expect(reads.at(-1)?.operation).toBe(completion);
  });

  test('unavailable recovery retains the operation reference instead of reporting a definite failure', async () => {
    let plans = 0;
    let reads = 0;
    try {
      await run({
        planNetworkOperation: async () => { plans += 1; return plan; },
        executeNetworkOperation: async () => { throw new TypeError('disconnected'); },
        getNetworkOperation: async (id) => { expect(id).toBe(plan.operationId); reads += 1; throw new Error('offline'); },
      });
      throw new Error('Expected structured recovery error');
    } catch (error) {
      expect(error).toBeInstanceOf(GitOperationResultError);
      if (!(error instanceof GitOperationResultError)) throw error;
      expect(error.code).toBe('operation-unavailable');
      expect(error.read).toEqual({ runtimeKey: 'runtime-one', operation: plan, availability: 'unavailable' });
      expect(error.read.operation.state).not.toBe('failed');
      expect(error.read.operation.target).toBe(syncTarget);
    }
    expect(plans).toBe(1);
    expect(reads).toBe(1);
  });

  test('partial terminal results keep completed sync steps and repository identity', async () => {
    const partial: GitNetworkOperation = {
      ...plan, state: 'partial', completedSteps: ['validated', 'transferred', 'updated-local-repository'],
      stepResults: [successfulSteps[0], successfulSteps[1], { step: 'push', status: 'failed' }],
      error: { code: 'TRANSPORT_FAILED', message: 'Push rejected' },
    };
    try {
      await run({ planNetworkOperation: async () => plan, executeNetworkOperation: async () => partial, getNetworkOperation });
      throw new Error('Expected partial operation');
    } catch (error) {
      if (!(error instanceof GitOperationResultError)) throw error;
      expect(error.read.operation).toBe(partial);
      expect(error.read.availability).toBe('available');
      expect(error.read.operation.stepResults?.map((step) => step.status)).toEqual(['succeeded', 'succeeded', 'failed']);
    }
  });

  test('active recovery remains cancellable and does not dispatch again', async () => {
    const running: GitNetworkOperation = { ...plan, state: 'running' };
    try {
      await run({ planNetworkOperation: async () => plan, executeNetworkOperation: async () => { throw new Error('lost response'); }, getNetworkOperation: async () => running });
      throw new Error('Expected active operation');
    } catch (error) {
      if (!(error instanceof GitOperationResultError)) throw error;
      expect(error.read).toEqual({ runtimeKey: 'runtime-one', availability: 'available', operation: running });
    }
  });

  for (const action of ['refresh', 'cancel'] as const) {
    test(`${action} never addresses an operation on a different runtime`, async () => {
      let requests = 0;
      const read: GitOperationRead = { runtimeKey: 'runtime-one', operation: plan, availability: 'available' };
      const result = await refreshGitOperation({
        getNetworkOperation: async () => { requests += 1; return plan; },
        cancelNetworkOperation: async () => { requests += 1; return plan; },
      }, read, action, () => 'runtime-two');
      expect(requests).toBe(0);
      expect(result.availability).toBe('unavailable');
      expect(result.operation).toBe(plan);
    });
  }

  test('cancel validates the original server and repository before sending a mutation', async () => {
    for (const changed of [
      { ...plan, runtimeIdentity: { ...plan.runtimeIdentity, id: 'other-server' } },
      { ...plan, target: { ...syncTarget, repositoryId: 'other-repository' } },
      { ...plan, operationId: 'other-operation' },
    ]) {
      let cancellations = 0;
      const result = await refreshGitOperation({
        getNetworkOperation: async () => changed,
        cancelNetworkOperation: async () => { cancellations += 1; return plan; },
      }, { runtimeKey: 'runtime-one', operation: plan, availability: 'available' }, 'cancel', () => 'runtime-one');
      expect(cancellations).toBe(0);
      expect(result.availability).toBe('unavailable');
    }
  });

  test('unknown push outcomes cannot regress to an active operation on refresh', async () => {
    const operation: GitNetworkOperation = { ...plan, state: 'outcome-unknown', error: { code: 'OUTCOME_UNKNOWN', message: 'Unknown' } };
    const result = await refreshGitOperation({ getNetworkOperation: async () => plan, cancelNetworkOperation: async () => plan },
      { runtimeKey: 'runtime-one', operation, availability: 'available' }, 'refresh', () => 'runtime-one');
    expect(result.operation).toBe(operation);
    expect(result.availability).toBe('unavailable');
  });

  test('a directory switch during cancellation preflight sends no cancel mutation', async () => {
    let current = true;
    let cancellations = 0;
    const result = await refreshGitOperation({
      getNetworkOperation: async () => { current = false; return plan; },
      cancelNetworkOperation: async () => { cancellations += 1; return plan; },
    }, { runtimeKey: 'runtime-one', operation: plan, availability: 'available' }, 'cancel', () => 'runtime-one', () => current);
    expect(cancellations).toBe(0);
    expect(result.availability).toBe('unavailable');
  });

  test('a lost Cancel response retains completed steps learned during its preflight', async () => {
    const current: GitNetworkOperation = { ...plan, state: 'running', completedSteps: ['transferred', 'updated-local-repository'], stepResults: successfulSteps.slice(0, 2) };
    const result = await refreshGitOperation({
      getNetworkOperation: async () => current,
      cancelNetworkOperation: async () => { throw new TypeError('disconnected after cancel'); },
    }, { runtimeKey: 'runtime-one', operation: plan, availability: 'available' }, 'cancel', () => 'runtime-one');
    expect(result.operation).toBe(current);
    expect(result.operation.stepResults).toEqual(successfulSteps.slice(0, 2));
    expect(result.availability).toBe('unavailable');
  });
});

describe('bound Git network request construction', () => {
  test('builds exact new-branch publication with local upstream configuration', () => {
    expect(buildBoundBranchPushRequest({
      bindingRead: boundRead, branch: 'feature/new', directory: '/repo', remoteName: 'upstream',
      destinationRef: 'refs/heads/feature/new', configureUpstream: true,
    })).toEqual({
      operation: 'push', directory: '/repo', repositoryId: 'repository-one', bindingRevision: 7,
      configRevision: 'config-one', remote: { name: 'upstream', endpoint: PUSH_ENDPOINT },
      sourceRef: 'refs/heads/feature/new', destinationRef: 'refs/heads/feature/new',
      transportMode: 'managed', configureUpstream: true,
    });
  });

  test('uses explicit refs and distinct binding fetch and push endpoints for sync', () => {
    expect(buildBoundGitNetworkOperationRequest({
      action: 'sync', bindingRead: boundRead, directory: '/repo', remoteName: 'upstream', status,
      targets,
    })).toEqual({
      operation: 'sync',
      directory: '/repo',
      repositoryId: 'repository-one',
      bindingRevision: 7,
      configRevision: 'config-one',
      fetch: {
        remote: { name: 'upstream', endpoint: FETCH_ENDPOINT },
        sourceRef: 'refs/heads/feature/published',
        destinationRef: 'refs/remotes/upstream/feature/published',
        transportMode: 'managed',
      },
      pull: { destinationRef: 'refs/heads/feature/local' },
      push: {
        remote: { name: 'upstream', endpoint: PUSH_ENDPOINT },
        sourceRef: 'refs/heads/feature/local',
        destinationRef: 'refs/heads/feature/published',
        transportMode: 'managed',
      },
    });
  });

  test('builds remote fetch through the operation API without inferring a source branch', () => {
    const request = buildBoundGitNetworkOperationRequest({
      action: 'fetch', bindingRead: boundRead, directory: '/repo', remoteName: 'upstream', status,
    });
    expect(request).toEqual({
      operation: 'fetch',
      fetchScope: 'remote',
      directory: '/repo',
      repositoryId: 'repository-one',
      bindingRevision: 7,
      configRevision: 'config-one',
      remote: { name: 'upstream', endpoint: FETCH_ENDPOINT },
      transportMode: 'managed',
    });
  });

  for (const gitStatus of [
    { ...status, tracking: null },
    { ...status, current: 'HEAD', tracking: null },
    { ...status, current: '', tracking: null },
    { ...status, tracking: 'origin/different-branch' },
  ]) {
    test(`fetch ignores current=${gitStatus.current} and tracking=${gitStatus.tracking}`, () => {
      expect(buildBoundGitNetworkOperationRequest({
        action: 'fetch', bindingRead: boundRead, directory: '/repo', remoteName: 'upstream', status: gitStatus,
      })).toEqual(buildBoundGitNetworkOperationRequest({
        action: 'fetch', bindingRead: boundRead, directory: '/repo', remoteName: 'upstream', status,
      }));
    });
  }

  test('fetch uses only the selected remote transport grant, without a provider account', () => {
    const originFetch = { ...FETCH_ENDPOINT, fingerprint: 'b'.repeat(64) };
    const bindingRead: SourceControlBindingRead = {
      ...boundRead,
      repository: { ...boundRead.repository, remotes: [...boundRead.repository.remotes, { name: 'origin', fetch: originFetch, push: PUSH_ENDPOINT }] },
      binding: { ...boundRead.binding, remotes: [...boundRead.binding.remotes, {
        name: 'origin', fetch: originFetch, push: PUSH_ENDPOINT, mode: 'system', readiness: 'ready',
      }] },
    };
    expect(buildBoundGitNetworkOperationRequest({
      action: 'fetch', bindingRead, directory: '/repo', remoteName: 'origin', status,
    })).toEqual({
      operation: 'fetch', fetchScope: 'remote', transportMode: 'system',
      directory: '/repo', repositoryId: 'repository-one', bindingRevision: 7, configRevision: 'config-one',
      remote: { name: 'origin', endpoint: originFetch },
    });
    expect(captureBoundErrorCode(() => buildBoundGitNetworkOperationRequest({
      action: 'fetch', bindingRead, directory: '/repo', remoteName: 'missing', status,
    }))).toBe('binding-remote-missing');
  });

  test('provider health and sibling transport readiness do not block an independently ready remote', () => {
    const bindingRead: SourceControlBindingRead = { ...boundRead, status: 'needs-attention', binding: {
      ...boundRead.binding, state: 'needs-attention',
      providers: [{ provider: 'github', instance: 'github.com', accountId: 'removed', primaryRemote: 'upstream',
        endpoint: FETCH_ENDPOINT, readiness: 'account-unavailable' }],
      remotes: [...boundRead.binding.remotes, { name: 'unconfirmed', mode: 'system',
        fetch: FETCH_ENDPOINT, push: PUSH_ENDPOINT, readiness: 'confirmation-required' }],
    } };
    expect(buildBoundGitNetworkOperationRequest({ action: 'fetch', bindingRead, directory: '/repo', remoteName: 'upstream', status }))
      .toEqual(buildBoundGitNetworkOperationRequest({ action: 'fetch', bindingRead: boundRead, directory: '/repo', remoteName: 'upstream', status }));
    expect(buildBoundBranchPushRequest({ bindingRead, branch: 'main', directory: '/repo', remoteName: 'upstream', destinationRef: 'refs/heads/main' }).operation).toBe('push');
    expect(captureBoundErrorCode(() => buildBoundGitNetworkOperationRequest({ action: 'fetch', bindingRead, directory: '/repo', remoteName: 'unconfirmed', status })))
      .toBe('binding-needs-attention');
  });

  for (const [label, bindingRead, code] of [
    ['unbound repository', { ...boundRead, status: 'missing', binding: null } satisfies SourceControlBindingRead, 'binding-required'],
    ['attention-required binding', {
      ...boundRead,
      status: 'needs-attention',
      binding: { ...boundRead.binding, state: 'needs-attention',
        remotes: boundRead.binding.remotes.map((remote) => ({ ...remote, readiness: 'confirmation-required' })) },
    } satisfies SourceControlBindingRead, 'binding-needs-attention'],
  ] as const) {
    test(`rejects an ${label}`, () => {
      expect(captureBoundErrorCode(() => buildBoundGitNetworkOperationRequest({
        action: 'sync', bindingRead, directory: '/repo', remoteName: 'upstream', status, targets,
      }))).toBe(code);
    });
  }

  for (const [label, gitStatus, remoteName, code] of [
    ['missing tracking', { ...status, tracking: null }, 'upstream', 'tracking-required'],
    ['mismatched selected remote', status, 'origin', 'tracking-remote-mismatch'],
    ['detached HEAD', { ...status, current: 'HEAD' }, 'upstream', 'branch-required'],
  ] as const) {
    test(`rejects ${label}`, () => {
      expect(captureBoundErrorCode(() => buildBoundGitNetworkOperationRequest({
        action: 'pull', bindingRead: boundRead, directory: '/repo', remoteName, status: gitStatus,
      }))).toBe(code);
    });
  }
});

describe('Git network terminal interpretation', () => {
  test('accepts only a fully successful sync', () => {
    const operation: GitNetworkOperation = { ...plan, state: 'succeeded', stepResults: successfulSteps };
    expect(interpretGitNetworkTerminalOperation(operation, 'sync')).toEqual({ status: 'succeeded' });
  });

  for (const [state, operation] of [
    ['partial', {
      ...plan,
      state: 'partial',
      completedSteps: ['validated'],
      stepResults: [successfulSteps[0], successfulSteps[1], {
        step: 'push', status: 'failed', error: { code: 'TRANSPORT_FAILED', message: 'partial operation' },
      }],
      error: { code: 'TRANSPORT_FAILED', message: 'partial operation' },
    } satisfies GitNetworkOperation],
    ['conflicted', {
      ...plan,
      state: 'conflicted',
      completedSteps: ['validated'],
      stepResults: [successfulSteps[0], {
        step: 'pull', status: 'conflicted', error: { code: 'CONFLICT', message: 'conflicted operation' },
      }, { step: 'push', status: 'skipped' }],
      error: { code: 'CONFLICT', message: 'conflicted operation' },
    } satisfies GitNetworkOperation],
    ['cancelled', {
      ...plan,
      state: 'cancelled',
      completedSteps: ['validated'],
      stepResults: [successfulSteps[0], {
        step: 'pull', status: 'cancelled', error: { code: 'CANCELLED', message: 'cancelled operation' },
      }, { step: 'push', status: 'skipped' }],
      error: { code: 'CANCELLED', message: 'cancelled operation' },
    } satisfies GitNetworkOperation],
    ['failed', {
      ...plan,
      state: 'failed',
      completedSteps: ['validated'],
      stepResults: [{
        step: 'fetch', status: 'failed', error: { code: 'TRANSPORT_FAILED', message: 'failed operation' },
      }, { step: 'pull', status: 'skipped' }, { step: 'push', status: 'skipped' }],
      error: { code: 'TRANSPORT_FAILED', message: 'failed operation' },
    } satisfies GitNetworkOperation],
    ['outcome-unknown', {
      ...plan,
      state: 'outcome-unknown',
      completedSteps: ['validated'],
      stepResults: [successfulSteps[0], successfulSteps[1], {
        step: 'push', status: 'cancelled', error: { code: 'OUTCOME_UNKNOWN', message: 'outcome-unknown operation' },
      }],
      error: { code: 'OUTCOME_UNKNOWN', message: 'outcome-unknown operation' },
    } satisfies GitNetworkOperation],
  ] as const) {
    test(`reports ${state} without treating it as success`, () => {
      expect(interpretGitNetworkTerminalOperation(operation, 'sync')).toEqual({
        status: 'failed', state, message: `${state} operation`,
      });
    });
  }
});

describe('explicit publication selection', () => {
  const branches: GitBranch = {
    current: status.current,
    all: [status.current, 'remotes/upstream/main', 'remotes/origin/review/feature'],
    branches: {
      [status.current]: { current: true, name: status.current, commit: 'abc123', label: '' },
    },
  };
  const bindingRead: SourceControlBindingRead = {
    ...boundRead,
    repository: { ...boundRead.repository, remotes: [...boundRead.repository.remotes, { name: 'origin', fetch: PUSH_ENDPOINT, push: FETCH_ENDPOINT }] },
    binding: {
      ...boundRead.binding,
      remotes: [...boundRead.binding.remotes, { name: 'origin', fetch: PUSH_ENDPOINT, push: FETCH_ENDPOINT, mode: 'managed', credentialId: 'origin-key', readiness: 'ready' }],
    },
  };
  const selectedTargets = {
    fetch: { remoteName: 'upstream', ref: 'refs/heads/main' },
    push: { remoteName: 'origin', ref: 'refs/heads/review/feature' },
  };
  const pushPlan: GitNetworkOperationPlan = {
    ...plan, transport: transport.push,
    target: {
      operation: 'push', repositoryId: 'repository-one', bindingRevision: 7, configRevision: 'config-one',
      remote: { name: 'origin', endpoint: FETCH_ENDPOINT }, sourceRef: `refs/heads/${status.current}`,
      destinationRef: 'refs/heads/review/feature',
    },
  };

  for (const tracking of [null, 'upstream/main']) {
    test(`publishes an existing branch tracking ${tracking} to the exact chosen origin destination`, async () => {
      const requests: GitNetworkOperationRequest[] = [];
      let executions = 0;
      let reads = 0;
      const git = {
        getGitStatus: async () => { reads += 1; return { ...status, tracking }; },
        getGitBranches: async () => branches,
        planNetworkOperation: async (request: GitNetworkOperationRequest) => { requests.push(request); return pushPlan; },
        executeNetworkOperation: async (): Promise<GitNetworkOperation> => { executions += 1; return { ...pushPlan, state: 'succeeded' }; },
        getNetworkOperation,
      };
      const dependencies = { directory: '/repo', git, sourceControl: { repositoryBinding: async () => bindingRead }, runtimeKey: () => 'runtime-one' };
      const selection = await prepareGitPublish({
        ...dependencies, action: 'push', choose: async (context) => {
          expect(context.bindingRead.binding.providers).toEqual([]);
          expect(context.branches).toBe(branches);
          expect(requests).toHaveLength(0);
          expect(executions).toBe(0);
          return selectedTargets;
        },
      });
      expect(requests).toHaveLength(0);
      await runPreparedGitPublish({ ...dependencies, selection });
      expect(reads).toBe(3);
      expect(executions).toBe(1);
      expect(requests).toEqual([{
        operation: 'push', directory: '/repo', repositoryId: 'repository-one', bindingRevision: 7, configRevision: 'config-one',
        remote: { name: 'origin', endpoint: FETCH_ENDPOINT }, transportMode: 'managed',
        sourceRef: `refs/heads/${status.current}`, destinationRef: 'refs/heads/review/feature', configureUpstream: tracking === null,
      }]);
    });
  }

  test('sync accepts independent fetch and push targets without tracking', () => {
    expect(buildBoundGitNetworkOperationRequest({
      action: 'sync', directory: '/repo', remoteName: '', status: { ...status, tracking: null }, bindingRead, targets: selectedTargets,
    })).toEqual({
      operation: 'sync', directory: '/repo', repositoryId: 'repository-one', bindingRevision: 7, configRevision: 'config-one',
      fetch: {
        remote: { name: 'upstream', endpoint: FETCH_ENDPOINT }, transportMode: 'managed',
        sourceRef: 'refs/heads/main', destinationRef: 'refs/remotes/upstream/main',
      },
      pull: { destinationRef: `refs/heads/${status.current}` },
      push: {
        remote: { name: 'origin', endpoint: FETCH_ENDPOINT }, transportMode: 'managed',
        sourceRef: `refs/heads/${status.current}`, destinationRef: 'refs/heads/review/feature',
      },
    });
  });

  test('neither upstream nor origin grants an implicit push destination', () => {
    expect(captureBoundErrorCode(() => buildBoundGitNetworkOperationRequest({
      action: 'sync', directory: '/repo', remoteName: 'origin', status, bindingRead,
    }))).toBe('publish-target-required');
    expect(captureBoundErrorCode(() => buildBoundBranchPushRequest({
      directory: '/repo', branch: status.current, remoteName: '', bindingRead, destinationRef: 'refs/heads/feature',
    }))).toBe('binding-remote-missing');
  });

  test('cancelling push selection keeps the local commit and starts no Git transfer', async () => {
    let commits = 0;
    let network = 0;
    const git = {
      getGitStatus: async () => status, getGitBranches: async () => branches,
      planNetworkOperation: async () => { network += 1; return pushPlan; },
      executeNetworkOperation: async (): Promise<GitNetworkOperation> => { network += 1; return { ...pushPlan, state: 'succeeded' }; },
      getNetworkOperation,
    };
    const commitAndPush = async () => {
      commits += 1;
      const selection = await prepareGitPublish({
        action: 'push', directory: '/repo', git, sourceControl: { repositoryBinding: async () => bindingRead },
        runtimeKey: () => 'runtime-one', choose: async () => null,
      });
      await runPreparedGitPublish({ selection, git, sourceControl: { repositoryBinding: async () => bindingRead }, runtimeKey: () => 'runtime-one' });
    };
    await expect(commitAndPush()).rejects.toThrow('publish-cancelled');
    expect(commits).toBe(1);
    expect(network).toBe(0);
  });

  for (const change of ['branch', 'runtime', 'binding', 'commit', 'read-failure'] as const) {
    test(`rejects ${change} changes during selection before planning`, async () => {
      let changed = false;
      const git = {
        getGitStatus: async () => ({ ...status, current: changed && change === 'branch' ? 'other' : status.current }),
        getGitBranches: async () => {
          if (changed && change === 'read-failure') throw new Error('read failed');
          return changed && change === 'commit' ? { ...branches, branches: { [status.current]: { ...branches.branches[status.current], commit: 'changed' } } } : branches;
        },
      };
      await expect(prepareGitPublish({
        action: 'push', directory: '/repo', git,
        sourceControl: { repositoryBinding: async () => changed && change === 'binding'
          ? { ...bindingRead, binding: { ...bindingRead.binding, revision: 8 } } : bindingRead },
        runtimeKey: () => changed && change === 'runtime' ? 'runtime-two' : 'runtime-one',
        choose: async () => { changed = true; return selectedTargets; },
      })).rejects.toThrow(change === 'read-failure' ? 'read failed' : change === 'runtime' ? 'stale-runtime' : 'publish-selection-stale');
    });
  }

  test('detached push does not open a chooser or infer HEAD as a source', async () => {
    let choices = 0;
    await expect(prepareGitPublish({
      action: 'push', directory: '/repo',
      git: { getGitStatus: async () => ({ ...status, current: 'HEAD' }), getGitBranches: async () => branches },
      sourceControl: { repositoryBinding: async () => bindingRead }, runtimeKey: () => 'runtime-one',
      choose: async () => { choices += 1; return selectedTargets; },
    })).rejects.toThrow('branch-required');
    expect(choices).toBe(0);
  });

  test('rechecks a confirmed branch before planning and never retries a planning conflict', async () => {
    let currentStatus = status;
    let plans = 0;
    let executions = 0;
    const git = {
      getGitStatus: async () => currentStatus, getGitBranches: async () => branches,
      planNetworkOperation: async (): Promise<GitNetworkOperationPlan> => {
        plans += 1;
        throw new GitNetworkOperationRequestError('CONFLICT', 'authority conflict', 409);
      },
      executeNetworkOperation: async (): Promise<GitNetworkOperation> => { executions += 1; return { ...pushPlan, state: 'succeeded' }; },
      getNetworkOperation,
    };
    const dependencies = { directory: '/repo', git, sourceControl: { repositoryBinding: async () => bindingRead }, runtimeKey: () => 'runtime-one' };
    const selection = await prepareGitPublish({ ...dependencies, action: 'push', choose: async () => selectedTargets });
    currentStatus = { ...status, current: 'other' };
    await expect(runPreparedGitPublish({ ...dependencies, selection })).rejects.toThrow('publish-selection-stale');
    expect(plans).toBe(0);
    currentStatus = status;
    await expect(runPreparedGitPublish({ ...dependencies, selection })).rejects.toThrow('authority conflict');
    expect(plans).toBe(1);
    expect(executions).toBe(0);
  });

  test('invalidates selection when the mounted scope changes during the final reread', async () => {
    let finalRead = false;
    let scopeChanged = false;
    let plans = 0;
    const git = {
      getGitStatus: async () => { if (finalRead) scopeChanged = true; return status; },
      getGitBranches: async () => branches,
      planNetworkOperation: async () => { plans += 1; return pushPlan; },
      executeNetworkOperation: async (): Promise<GitNetworkOperation> => ({ ...pushPlan, state: 'succeeded' }),
      getNetworkOperation,
    };
    const dependencies = { directory: '/repo', git, sourceControl: { repositoryBinding: async () => bindingRead }, runtimeKey: () => 'runtime-one' };
    const selection = await prepareGitPublish({ ...dependencies, action: 'push', choose: async () => selectedTargets });
    finalRead = true;
    await expect(runPreparedGitPublish({
      ...dependencies, selection,
      assertCurrent: () => { if (scopeChanged) throw new BoundGitNetworkOperationError('publish-selection-stale'); },
    })).rejects.toThrow('publish-selection-stale');
    expect(plans).toBe(0);
  });

  test('commit-and-push retains the confirmed destination while allowing the new local commit', async () => {
    let committed = false;
    const requests: GitNetworkOperationRequest[] = [];
    const git = {
      getGitStatus: async () => status,
      getGitBranches: async () => committed
        ? { ...branches, branches: { [status.current]: { ...branches.branches[status.current], commit: 'new-commit' } } } : branches,
      planNetworkOperation: async (request: GitNetworkOperationRequest) => { requests.push(request); return pushPlan; },
      executeNetworkOperation: async (): Promise<GitNetworkOperation> => ({ ...pushPlan, state: 'succeeded' }),
      getNetworkOperation,
    };
    const dependencies = { directory: '/repo', git, sourceControl: { repositoryBinding: async () => bindingRead }, runtimeKey: () => 'runtime-one' };
    const selection = await prepareGitPublish({ ...dependencies, action: 'push', choose: async () => selectedTargets });
    committed = true;
    await expect(runPreparedGitPublish({ ...dependencies, selection })).rejects.toThrow('publish-selection-stale');
    expect(requests).toHaveLength(0);
    await runPreparedGitPublish({ ...dependencies, selection, allowNewCommit: true });
    expect(requests).toHaveLength(1);
    expect(requests[0].operation === 'push' && requests[0].destinationRef).toBe('refs/heads/review/feature');
  });
});

describe('bound Git network operation runtime safety', () => {
  test('plans an exact selected remote ref without consulting current tracking', async () => {
    const destinationRef = 'refs/remotes/upstream/release/next';
    const exactFetchPlan: GitNetworkOperationPlan = {
      ...plan,
      transport: transport.fetch,
      target: {
        operation: 'fetch', fetchScope: 'ref', repositoryId: 'repository-one', bindingRevision: 7,
        configRevision: 'config-one', remote: { name: 'upstream', endpoint: FETCH_ENDPOINT },
        sourceRef: 'refs/heads/release/next', destinationRef,
      },
    };
    const requests: GitNetworkOperationRequest[] = [];
    await runBoundGitNetworkOperation({
      action: 'fetch',
      directory: '/repo',
      remoteName: 'upstream',
      fetchTarget: {
        remoteName: 'upstream',
        sourceRef: 'refs/heads/release/next',
        destinationRef,
      },
      status: { ...status, tracking: 'origin/main' },
      sourceControl: { repositoryBinding: async () => boundRead },
      runtimeKey: () => 'runtime-one',
      git: {
        planNetworkOperation: async (request) => { requests.push(request); return exactFetchPlan; },
        executeNetworkOperation: async () => ({ ...exactFetchPlan, state: 'succeeded' }),
        getNetworkOperation,
      },
    });

    expect(requests).toEqual([{
      operation: 'fetch',
      fetchScope: 'ref',
      directory: '/repo',
      repositoryId: 'repository-one',
      bindingRevision: 7,
      configRevision: 'config-one',
      remote: { name: 'upstream', endpoint: FETCH_ENDPOINT },
      sourceRef: 'refs/heads/release/next',
      destinationRef,
      transportMode: 'managed',
    }]);
  });

  test('executes explicit remote Fetch from detached HEAD without an upstream', async () => {
    const fetchPlan: GitNetworkOperationPlan = {
      ...plan,
      transport: transport.fetch,
      target: {
        operation: 'fetch', fetchScope: 'remote', repositoryId: 'repository-one', bindingRevision: 7,
        configRevision: 'config-one', remote: { name: 'upstream', endpoint: FETCH_ENDPOINT }, force: true,
      },
    };
    const requests: GitNetworkOperationRequest[] = [];
    let executes = 0;
    const git = {
      planNetworkOperation: async (request: GitNetworkOperationRequest) => { requests.push(request); return fetchPlan; },
      executeNetworkOperation: async (): Promise<GitNetworkOperation> => { executes += 1; return { ...fetchPlan, state: 'succeeded' }; },
      getNetworkOperation,
    };
    expect(requests).toHaveLength(0);
    expect(executes).toBe(0);
    const result = await runBoundGitNetworkOperation({
      action: 'fetch', directory: '/repo', remoteName: 'upstream', status: { ...status, current: 'HEAD', tracking: null },
      sourceControl: { repositoryBinding: async () => boundRead }, git, runtimeKey: () => 'runtime-one',
    });
    expect(result.state).toBe('succeeded');
    expect(requests).toHaveLength(1);
    expect(requests[0]).toEqual(buildBoundGitNetworkOperationRequest({
      action: 'fetch', bindingRead: boundRead, directory: '/repo', remoteName: 'upstream', status,
    }));
    expect(executes).toBe(1);
  });

  test('plans checkout hydration from the current bound fetch authority', async () => {
    const hydrationPlan: GitNetworkOperationPlan = {
      ...plan,
      transport: transport.fetch,
      target: {
        operation: 'checkout-hydration', repositoryId: 'repository-one', bindingRevision: 7,
        configRevision: 'config-one', remote: { name: 'upstream', endpoint: FETCH_ENDPOINT },
        requirements: [{ kind: 'submodule', path: 'vendor/library', endpoint: FETCH_ENDPOINT }],
      },
    };
    const requests: GitNetworkOperationRequest[] = [];
    const result = await runCheckoutHydration({
      directory: '/repo', parentRemoteName: 'upstream', runtimeKey: () => 'runtime-one',
      sourceControl: { repositoryBinding: async () => boundRead },
      git: {
        planNetworkOperation: async (request) => { requests.push(request); return hydrationPlan; },
        executeNetworkOperation: async () => ({ ...hydrationPlan, state: 'succeeded', hydration: {
          status: 'succeeded', submodules: [{ path: 'vendor/library', status: 'succeeded', endpoint: FETCH_ENDPOINT }], lfs: [],
        } }),
        getNetworkOperation,
      },
    });
    expect(result.state).toBe('succeeded');
    expect(requests).toEqual([{
      operation: 'checkout-hydration', directory: '/repo', repositoryId: 'repository-one',
      bindingRevision: 7, configRevision: 'config-one', remote: { name: 'upstream', endpoint: FETCH_ENDPOINT },
    }]);
  });

  test('does not plan checkout hydration without a current repository binding', async () => {
    let plans = 0;
    await expect(runCheckoutHydration({
      directory: '/repo', parentRemoteName: 'upstream', runtimeKey: () => 'runtime-one',
      sourceControl: { repositoryBinding: async () => ({ ...boundRead, status: 'missing', binding: null }) },
      git: {
        planNetworkOperation: async () => { plans += 1; return plan; },
        executeNetworkOperation: async () => plan,
        getNetworkOperation,
      },
    })).rejects.toThrow('binding-required');
    expect(plans).toBe(0);
  });

  test('plans and executes clone explicitly with System transport', async () => {
    const clonePlan: GitNetworkOperationPlan = {
      operationId: 'clone-one',
      runtimeIdentity: { id: 'server-one', platform: 'desktop' },
      transport: { mode: 'system', verification: { status: 'unverified', reason: 'system-credentials' } },
      target: {
        operation: 'clone',
        remote: FETCH_ENDPOINT,
        destination: { displayName: 'repo', fingerprint: 'd'.repeat(64) },
      },
      completedSteps: [],
      state: 'planned',
    };
    let request: GitNetworkOperationRequest | null = null;

    await runGitClone({
      selection: { transportMode: 'system', unverifiedConfirmed: true },
      remoteUrl: FETCH_ENDPOINT.displayUrl,
      destinationPath: '/projects/repo',
      gitIdentityId: 'identity-one',
      git: {
        planNetworkOperation: async (value) => { request = value; return clonePlan; },
        executeNetworkOperation: async () => ({ ...clonePlan, state: 'succeeded' }),
        getNetworkOperation,
        cancelNetworkOperation: async () => { throw new Error('unexpected cancel'); },
      },
      runtimeKey: () => 'runtime-one',
    });

    expect(request).toEqual({
      operation: 'clone', remoteUrl: FETCH_ENDPOINT.displayUrl, destinationPath: '/projects/repo',
      transportMode: 'system', unverifiedConfirmed: true, gitIdentityId: 'identity-one',
    });
  });

  test('transfers only the anonymous clone selection and retains finish-setup results', async () => {
    const clonePlan: GitNetworkOperationPlan = { ...plan,
      transport: { mode: 'anonymous', verification: { status: 'anonymous' } },
      target: { operation: 'clone', remote: FETCH_ENDPOINT, destination: { displayName: 'repo', fingerprint: 'd'.repeat(64) } },
    };
    const requests: GitNetworkOperationRequest[] = [];
    const result = await runGitClone({
      remoteUrl: FETCH_ENDPOINT.displayUrl, destinationPath: '/projects/repo',
      selection: { transportMode: 'anonymous' }, runtimeKey: () => 'runtime-one',
      git: {
        planNetworkOperation: async (request) => { requests.push(request); return clonePlan; },
        executeNetworkOperation: async () => ({ ...clonePlan, state: 'partial', completedSteps: ['checked-out'], error: { code: 'UNKNOWN', message: 'Checkout retained' } }),
        getNetworkOperation, cancelNetworkOperation: async () => clonePlan,
      },
    });
    expect(result).toEqual({ status: 'setup-required' });
    expect(requests).toEqual([{ operation: 'clone', remoteUrl: FETCH_ENDPOINT.displayUrl, destinationPath: '/projects/repo', transportMode: 'anonymous' }]);
  });

  test('does not plan or execute clone without a selection and explicit System confirmation', async () => {
    let plans = 0;
    let executes = 0;
    const input = {
      remoteUrl: FETCH_ENDPOINT.displayUrl, destinationPath: '/projects/repo', gitIdentityId: 'legacy-ssh-author',
      git: {
        planNetworkOperation: async () => { plans += 1; return plan; },
        executeNetworkOperation: async () => { executes += 1; return plan; },
        getNetworkOperation,
        cancelNetworkOperation: async () => plan,
      },
      runtimeKey: () => 'runtime-one',
    };
    // @ts-expect-error Deliberately omit selection to exercise the runtime guard.
    await expect(runGitClone(input)).rejects.toThrow('binding-required');
    await expect(runGitClone({ ...input,
      // @ts-expect-error A System choice alone is not confirmation.
      selection: { transportMode: 'system', unverifiedConfirmed: false },
    })).rejects.toThrow('binding-required');
    expect(plans).toBe(0);
    expect(executes).toBe(0);
  });

  test('preserves managed clone account choice and returns finish-setup instead of failure for a retained checkout', async () => {
    const clonePlan: GitNetworkOperationPlan = { ...plan,
      target: { operation: 'clone', remote: FETCH_ENDPOINT, destination: { displayName: 'repo', fingerprint: 'd'.repeat(64) } },
    };
    const requests: GitNetworkOperationRequest[] = [];
    const credentialAccount = { provider: 'github', instance: 'github.com', accountId: 'transport-account-not-source' } as const;
    const result = await runGitClone({
      remoteUrl: FETCH_ENDPOINT.displayUrl, destinationPath: '/projects/repo', gitIdentityId: 'author-not-transport',
      selection: { transportMode: 'managed', credentialAccount },
      runtimeKey: () => 'runtime-one',
      git: {
        planNetworkOperation: async (request) => { requests.push(request); return clonePlan; },
        executeNetworkOperation: async () => ({ ...clonePlan, state: 'partial', completedSteps: ['checked-out'],
          error: { code: 'UNKNOWN', message: 'Checkout retained' } }),
        getNetworkOperation,
        cancelNetworkOperation: async () => clonePlan,
      },
    });
    expect(result).toEqual({ status: 'setup-required' });
    expect(requests).toEqual([{ operation: 'clone', remoteUrl: FETCH_ENDPOINT.displayUrl, destinationPath: '/projects/repo',
      gitIdentityId: 'author-not-transport', transportMode: 'managed', credentialAccount }]);
  });

  test('cancels a pending clone plan without executing it and never starts an already cancelled selection', async () => {
    const controller = new AbortController();
    const clonePlan: GitNetworkOperationPlan = { ...plan,
      target: { operation: 'clone', remote: FETCH_ENDPOINT, destination: { displayName: 'repo', fingerprint: 'd'.repeat(64) } },
    };
    const cancelled: GitNetworkOperation = { ...clonePlan, state: 'cancelled', error: { code: 'CANCELLED', message: 'Cancelled' } };
    const calls: string[] = [];
    const input: Parameters<typeof runGitClone>[0] = {
      remoteUrl: FETCH_ENDPOINT.displayUrl, destinationPath: '/projects/repo',
      selection: { transportMode: 'system', unverifiedConfirmed: true }, signal: controller.signal,
      runtimeKey: () => 'runtime-one',
      git: {
        planNetworkOperation: async () => { calls.push('plan'); controller.abort(); return clonePlan; },
        executeNetworkOperation: async () => { calls.push('execute'); return cancelled; },
        getNetworkOperation,
        cancelNetworkOperation: async (id) => { calls.push(`cancel:${id}`); return cancelled; },
      },
    };
    expect(await runGitClone(input)).toEqual({ status: 'cancelled' });
    expect(calls).toEqual(['plan', `cancel:${clonePlan.operationId}`]);
    expect(await runGitClone(input)).toEqual({ status: 'cancelled' });
    expect(calls).toHaveLength(2);
  });

  test('preserves the selected host SSH reference and retains a partial clone for setup', async () => {
    const endpoint = { displayUrl: 'git@example.com:team/repo.git', fingerprint: 'e'.repeat(64) };
    const clonePlan: GitNetworkOperationPlan = { ...plan,
      target: { operation: 'clone', remote: endpoint, destination: { displayName: 'repo', fingerprint: 'd'.repeat(64) } },
    };
    const requests: GitNetworkOperationRequest[] = [];
    const sshCredentialId = 'ocgit:v1:ssh:a2V5X29uZQ';
    const result = await runGitClone({
      remoteUrl: endpoint.displayUrl, destinationPath: '/projects/repo', selection: { transportMode: 'managed', sshCredentialId },
      runtimeKey: () => 'runtime-one',
      git: {
        planNetworkOperation: async (request) => { requests.push(request); return clonePlan; },
        executeNetworkOperation: async () => ({ ...clonePlan, state: 'partial', completedSteps: ['checked-out'],
          error: { code: 'UNKNOWN', message: 'Finish setup on the retained checkout' } }),
        getNetworkOperation, cancelNetworkOperation: async () => clonePlan,
      },
    });
    expect(result).toEqual({ status: 'setup-required' });
    expect(requests).toEqual([{ operation: 'clone', remoteUrl: endpoint.displayUrl, destinationPath: '/projects/repo',
      transportMode: 'managed', sshCredentialId }]);
  });

  test('forwards cancellation to the running clone instead of retrying it', async () => {
    const controller = new AbortController();
    const clonePlan: GitNetworkOperationPlan = { ...plan,
      target: { operation: 'clone', remote: FETCH_ENDPOINT, destination: { displayName: 'repo', fingerprint: 'd'.repeat(64) } },
    };
    const cancelled: GitNetworkOperation = { ...clonePlan, state: 'cancelled', error: { code: 'CANCELLED', message: 'Cancelled' } };
    const calls: string[] = [];
    const result = await runGitClone({
      remoteUrl: FETCH_ENDPOINT.displayUrl, destinationPath: '/projects/repo',
      selection: { transportMode: 'system', unverifiedConfirmed: true }, signal: controller.signal,
      runtimeKey: () => 'runtime-one',
      git: {
        planNetworkOperation: async () => { calls.push('plan'); return clonePlan; },
        executeNetworkOperation: async () => { calls.push('execute'); controller.abort(); return cancelled; },
        getNetworkOperation,
        cancelNetworkOperation: async () => { calls.push('cancel'); return cancelled; },
      },
    });
    expect(result).toEqual({ status: 'cancelled' });
    expect(calls).toEqual(['plan', 'execute', 'cancel']);
  });

  test('deletes an exact branch on its bound push endpoint', async () => {
    const deletePlan: GitNetworkOperationPlan = {
      ...plan,
      target: {
        operation: 'delete-remote-branch', repositoryId: 'repository-one', bindingRevision: 7,
        configRevision: 'config-one', remote: { name: 'upstream', endpoint: PUSH_ENDPOINT },
        destinationRef: 'refs/heads/feature/delete-me',
      },
      transport: transport.push,
    };
    let request: GitNetworkOperationRequest | null = null;

    await runBoundRemoteBranchDelete({
      branch: 'feature/delete-me', directory: '/repo', remoteName: 'upstream',
      sourceControl: { repositoryBinding: async () => boundRead },
      git: {
        planNetworkOperation: async (value) => { request = value; return deletePlan; },
        executeNetworkOperation: async () => ({ ...deletePlan, state: 'succeeded' }),
        getNetworkOperation,
      },
      runtimeKey: () => 'runtime-one',
    });

    expect(request).toEqual({
      operation: 'delete-remote-branch', directory: '/repo', repositoryId: 'repository-one',
      bindingRevision: 7, configRevision: 'config-one',
      remote: { name: 'upstream', endpoint: PUSH_ENDPOINT },
      destinationRef: 'refs/heads/feature/delete-me', transportMode: 'managed',
    });
  });

  test('rejects a runtime switch while contributor destination selection is open', async () => {
    let runtime = 'runtime-one';
    let resolveSelection = (name: string | null) => { void name; };
    const selection = new Promise<string | null>((resolve) => { resolveSelection = resolve; });
    let issueCalls = 0;
    const running = runContributorPush({
      directory: '/repo', status, sourceControl: { repositoryBinding: async () => boundRead },
      git: {
        listContributorDestinations: async () => ({
          kind: 'contributor',
          repositoryId: 'repository-one', bindingRevision: 7, configRevision: 'config-one', provenanceRevision: 2,
          candidates: [{
            remote: { name: 'upstream', endpoint: PUSH_ENDPOINT },
            transportMode: 'managed',
            classification: 'bound-repository',
          }],
        }),
        issueContributorDestination: async () => { issueCalls += 1; throw new Error('must not issue'); },
        planNetworkOperation: async () => { throw new Error('must not plan'); },
        executeNetworkOperation: async () => { throw new Error('must not execute'); },
        getNetworkOperation,
      },
      choose: () => selection,
      runtimeKey: () => runtime,
    });
    await Promise.resolve();
    await Promise.resolve();
    runtime = 'runtime-two';
    resolveSelection('upstream');

    let errorCode: BoundGitNetworkOperationError['code'] | null = null;
    try { await running; } catch (error) {
      if (error instanceof BoundGitNetworkOperationError) errorCode = error.code;
    }
    expect(errorCode).toBe('stale-runtime');
    expect(issueCalls).toBe(0);
  });

  test('routes an ordinary repository directly to exact sync', async () => {
    const completion: GitNetworkOperation = { ...plan, state: 'succeeded', stepResults: successfulSteps };
    const requests: GitNetworkOperationRequest[] = [];
    const result = await runContributorAwareSync({
      directory: '/repo', remoteName: 'upstream', status,
      targets,
      sourceControl: { repositoryBinding: async () => boundRead },
      git: {
        listContributorDestinations: async () => ({ kind: 'ordinary' }),
        issueContributorDestination: async () => { throw new Error('must not issue'); },
        planNetworkOperation: async (request) => { requests.push(request); return plan; },
        executeNetworkOperation: async () => completion,
        getNetworkOperation,
      },
      choose: async () => { throw new Error('must not choose'); },
      runtimeKey: () => 'runtime-one',
    });
    expect(result).toBe(completion);
    expect(requests).toHaveLength(1);
    expect(requests[0].operation).toBe('sync');
  });

  test('updates a behind contributor before choosing and pins the post-update push', async () => {
    const pullPlan: GitNetworkOperationPlan = {
      ...plan,
      target: {
        operation: 'pull', repositoryId: 'repository-one', bindingRevision: 7, configRevision: 'config-one',
        remote: { name: 'upstream', endpoint: FETCH_ENDPOINT },
        sourceRef: 'refs/heads/feature/published', destinationRef: 'refs/heads/feature/local',
      },
      transport: transport.fetch,
    };
    const pullCompletion: GitNetworkOperation = { ...pullPlan, state: 'succeeded' };
    const pushPlan: GitNetworkOperationPlan = {
      ...plan,
      operationId: 'push-one',
      target: {
        operation: 'push', repositoryId: 'repository-one', bindingRevision: 7, configRevision: 'config-one',
        remote: { name: 'upstream', endpoint: PUSH_ENDPOINT },
        sourceRef: 'refs/heads/feature/local', destinationRef: 'refs/heads/feature/local',
      },
      transport: transport.push,
    };
    const pushCompletion: GitNetworkOperation = { ...pushPlan, state: 'succeeded' };
    const requests: GitNetworkOperationRequest[] = [];
    let listCalls = 0;
    let chooseAfterPull = false;
    await runContributorAwareSync({
      directory: '/repo', remoteName: 'upstream', status,
      sourceControl: { repositoryBinding: async () => boundRead },
      git: {
        listContributorDestinations: async () => { listCalls += 1; return contributorDestinations; },
        issueContributorDestination: async () => ({
          selectionId: 'selection-one', provenanceRevision: 2, sourceSha: 'b'.repeat(40), expiresInMs: 900_000,
        }),
        planNetworkOperation: async (request) => {
          requests.push(request);
          return request.operation === 'pull' ? pullPlan : pushPlan;
        },
        executeNetworkOperation: async (operationId) => operationId === pullPlan.operationId ? pullCompletion : pushCompletion,
        getNetworkOperation,
      },
      choose: (candidates) => {
        chooseAfterPull = requests.some((request) => request.operation === 'pull');
        return candidates[0].remote.name;
      },
      runtimeKey: () => 'runtime-one',
    });
    expect(chooseAfterPull).toBe(true);
    expect(listCalls).toBe(2);
    expect(requests.map((request) => request.operation)).toEqual(['pull', 'push']);
  });

  test('opens the chooser directly when only contributor push is pending', async () => {
    const pushPlan: GitNetworkOperationPlan = {
      ...plan,
      target: {
        operation: 'push', repositoryId: 'repository-one', bindingRevision: 7, configRevision: 'config-one',
        remote: { name: 'upstream', endpoint: PUSH_ENDPOINT },
        sourceRef: 'refs/heads/feature/local', destinationRef: 'refs/heads/feature/local',
      },
      transport: transport.push,
    };
    const requests: GitNetworkOperationRequest[] = [];
    let chose = false;
    await runContributorAwareSync({
      directory: '/repo', remoteName: 'upstream', status: { ...status, behind: 0 },
      sourceControl: { repositoryBinding: async () => boundRead },
      git: {
        listContributorDestinations: async () => contributorDestinations,
        issueContributorDestination: async () => ({
          selectionId: 'selection-one', provenanceRevision: 2, sourceSha: 'b'.repeat(40), expiresInMs: 900_000,
        }),
        planNetworkOperation: async (request) => { requests.push(request); return pushPlan; },
        executeNetworkOperation: async () => ({ ...pushPlan, state: 'succeeded' }),
        getNetworkOperation,
      },
      choose: (candidates) => { chose = true; return candidates[0].remote.name; },
      runtimeKey: () => 'runtime-one',
    });
    expect(chose).toBe(true);
    expect(requests.map((request) => request.operation)).toEqual(['push']);
  });

  test('routes new contributor branch publication through exact selection instead of legacy push', async () => {
    const pushPlan: GitNetworkOperationPlan = {
      ...plan,
      target: {
        operation: 'push', repositoryId: 'repository-one', bindingRevision: 7, configRevision: 'config-one',
        remote: { name: 'upstream', endpoint: PUSH_ENDPOINT },
        sourceRef: 'refs/heads/new-branch', destinationRef: 'refs/heads/new-branch',
      },
      transport: transport.push,
    };
    await runContributorAwarePush({
      directory: '/repo', branch: 'new-branch', remoteName: 'origin',
      sourceControl: { repositoryBinding: async () => boundRead },
      git: {
        listContributorDestinations: async () => contributorDestinations,
        issueContributorDestination: async () => ({
          selectionId: 'selection-one', provenanceRevision: 2, sourceSha: 'b'.repeat(40), expiresInMs: 900_000,
        }),
        planNetworkOperation: async () => pushPlan,
        executeNetworkOperation: async () => ({ ...pushPlan, state: 'succeeded' }),
        getNetworkOperation,
      },
      choose: (candidates) => candidates[0].remote.name,
      runtimeKey: () => 'runtime-one',
    });
  });

  test('routes ordinary new-branch publication through one explicit push operation', async () => {
    const pushPlan: GitNetworkOperationPlan = {
      ...plan,
      target: {
        operation: 'push', repositoryId: 'repository-one', bindingRevision: 7, configRevision: 'config-one',
        remote: { name: 'upstream', endpoint: PUSH_ENDPOINT }, sourceRef: 'refs/heads/new-branch',
        destinationRef: 'refs/heads/new-branch', configureUpstream: true,
      },
      transport: transport.push,
    };
    let request: GitNetworkOperationRequest | null = null;
    await runContributorAwarePush({
      directory: '/repo', branch: 'new-branch', remoteName: 'upstream',
      destinationRef: 'refs/heads/new-branch',
      sourceControl: { repositoryBinding: async () => boundRead },
      git: {
        listContributorDestinations: async () => ({ kind: 'ordinary' }),
        issueContributorDestination: async () => { throw new Error('not expected'); },
        planNetworkOperation: async (value) => { request = value; return pushPlan; },
        executeNetworkOperation: async () => ({ ...pushPlan, state: 'succeeded' }),
        getNetworkOperation,
      },
      choose: () => null,
      runtimeKey: () => 'runtime-one',
    });
    expect(request).toEqual({
      operation: 'push', directory: '/repo', repositoryId: 'repository-one', bindingRevision: 7,
      configRevision: 'config-one', remote: { name: 'upstream', endpoint: PUSH_ENDPOINT },
      sourceRef: 'refs/heads/new-branch', destinationRef: 'refs/heads/new-branch',
      transportMode: 'managed', configureUpstream: true,
    });
  });

  test('retries the same System push authority only after explicit acknowledgement', async () => {
    const systemRead: SourceControlBindingRead = {
      ...boundRead,
      binding: {
        ...boundRead.binding,
        remotes: boundRead.binding.remotes.map((remote) => ({ ...remote, mode: 'system', credentialId: undefined })),
      },
    };
    const pushPlan: GitNetworkOperationPlan = {
      ...plan,
      target: {
        operation: 'push', repositoryId: 'repository-one', bindingRevision: 7, configRevision: 'config-one',
        remote: { name: 'upstream', endpoint: PUSH_ENDPOINT }, sourceRef: 'refs/heads/new-branch',
        destinationRef: 'refs/heads/new-branch', configureUpstream: true,
      },
      transport: { mode: 'system', verification: { status: 'unverified', reason: 'system-credentials' } },
    };
    const requests: GitNetworkOperationRequest[] = [];
    let confirmations = 0;
    await runContributorAwarePush({
      directory: '/repo', branch: 'new-branch', remoteName: 'upstream',
      destinationRef: 'refs/heads/new-branch',
      sourceControl: { repositoryBinding: async () => systemRead },
      git: {
        listContributorDestinations: async () => ({ kind: 'ordinary' }),
        issueContributorDestination: async () => { throw new Error('not expected'); },
        planNetworkOperation: async (request) => {
          requests.push(request);
          if (requests.length === 1) {
            throw new GitNetworkOperationRequestError('ACKNOWLEDGEMENT_REQUIRED', 'acknowledgement required', 409);
          }
          return pushPlan;
        },
        executeNetworkOperation: async () => ({ ...pushPlan, state: 'succeeded' }),
        getNetworkOperation,
      },
      choose: () => null,
      confirmSystemTransport: () => { confirmations += 1; return true; },
      runtimeKey: () => 'runtime-one',
    });

    expect(confirmations).toBe(1);
    expect(requests).toHaveLength(2);
    expect(requests[1]).toEqual({ ...requests[0], acknowledgeSystemTransport: true });
  });

  test('plans and executes one operation while the runtime remains current', async () => {
    const completion: GitNetworkOperation = { ...plan, state: 'succeeded', stepResults: successfulSteps };
    let bindingCalls = 0;
    let planCalls = 0;
    let executeCalls = 0;
    let executedOperationId = '';

    const result = await runBoundGitNetworkOperation({
      action: 'sync', directory: '/repo', remoteName: 'upstream', status,
      targets,
      sourceControl: { repositoryBinding: async () => { bindingCalls += 1; return boundRead; } },
      git: {
        planNetworkOperation: async () => { planCalls += 1; return plan; },
        getNetworkOperation,
        executeNetworkOperation: async (operationId) => {
          executeCalls += 1;
          executedOperationId = operationId;
          return completion;
        },
      },
      runtimeKey: () => 'runtime-one',
    });
    expect(result).toBe(completion);
    expect(bindingCalls).toBe(1);
    expect(planCalls).toBe(1);
    expect(executeCalls).toBe(1);
    expect(executedOperationId).toBe('operation-one');
  });

  test('rejects a completion after the runtime changes', async () => {
    let runtime = 'runtime-one';
    const completion: GitNetworkOperation = { ...plan, state: 'succeeded', stepResults: successfulSteps };
    let errorCode: BoundGitNetworkOperationError['code'] | null = null;
    try {
      await runBoundGitNetworkOperation({
        action: 'sync', directory: '/repo', remoteName: 'upstream', status,
        targets,
        sourceControl: { repositoryBinding: async () => boundRead },
        git: {
          planNetworkOperation: async () => plan,
          getNetworkOperation,
          executeNetworkOperation: async () => {
            runtime = 'runtime-two';
            return completion;
          },
        },
        runtimeKey: () => runtime,
      });
    } catch (error) {
      if (error instanceof BoundGitNetworkOperationError) errorCode = error.code;
    }
    expect(errorCode).toBe('stale-runtime');
  });

  test('rejects a completion from a different server runtime identity', async () => {
    const completion: GitNetworkOperation = {
      ...plan,
      runtimeIdentity: { id: 'server-two', platform: 'desktop' },
      state: 'succeeded',
      stepResults: successfulSteps,
    };
    let errorCode: BoundGitNetworkOperationError['code'] | null = null;
    try {
      await runBoundGitNetworkOperation({
        action: 'sync', directory: '/repo', remoteName: 'upstream', status,
        targets,
        sourceControl: { repositoryBinding: async () => boundRead },
        git: {
          planNetworkOperation: async () => plan,
          executeNetworkOperation: async () => completion,
          getNetworkOperation,
        },
        runtimeKey: () => 'runtime-one',
      });
    } catch (error) {
      if (error instanceof BoundGitNetworkOperationError) errorCode = error.code;
    }
    expect(errorCode).toBe('stale-runtime');
  });
});
