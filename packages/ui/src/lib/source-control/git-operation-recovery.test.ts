import { describe, expect, test } from 'bun:test';
import { createHash } from 'node:crypto';
import type { GitNetworkOperation, GitNetworkOperationPlan, GitNetworkOperationRequest } from '@/lib/api/types';
import { GitNetworkOperationRequestError } from '@/lib/api/types';
import { createGitOperationRecoveryOwner, PendingGitOperationError } from './git-operation-recovery';

class MemoryStorage {
  values = new Map<string, string>();
  failRead = false;
  failWrite = false;
  writes = 0;
  getItem(key: string) { if (this.failRead) throw new Error('storage denied'); return this.values.get(key) ?? null; }
  setItem(key: string, value: string) { this.writes += 1; if (this.failWrite) throw new Error('storage denied'); this.values.set(key, value); }
}
const endpoint = { displayUrl: 'https://example.com/private/repo.git', fingerprint: 'endpoint' };
const request: GitNetworkOperationRequest = {
  operation: 'push', directory: '/private/checkout', repositoryId: 'repo-one', configRevision: 'config-one', bindingRevision: 1,
  remote: { name: 'origin', endpoint }, sourceRef: 'refs/heads/main', destinationRef: 'refs/heads/main', transportMode: 'system',
};
const plan: GitNetworkOperationPlan = {
  operationId: 'git_original', runtimeIdentity: { id: 'server-one', platform: 'web' }, state: 'planned', completedSteps: [],
  transport: { mode: 'system', verification: { status: 'unverified', reason: 'system-credentials' } },
  target: { operation: 'push', repositoryId: 'repo-one', configRevision: 'config-one', bindingRevision: 1,
    remote: request.remote, sourceRef: request.sourceRef, destinationRef: request.destinationRef },
};
const runtime = 'url:https://runtime.example.com';
const setup = () => {
  const storage = new MemoryStorage();
  const owner = createGitOperationRecoveryOwner(() => storage);
  return { storage, owner };
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

describe('HTTP LAN recovery fingerprints', () => {
  test('fallback matches standard SHA-256 vectors, native WebCrypto and Node for UTF-8 and block boundaries', async () => {
    const { owner } = setup();
    const vectors = [
      ['', 'e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855'],
      ['abc', 'ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad'],
      ['abcdbcdecdefdefgefghfghighijhijkijkljklmklmnlmnomnopnopq', '248d6a61d20638b8e5c026930c3e6039a33ce45964ff2167f6ecedd419db06c1'],
      ['a'.repeat(1_000_000), 'cdc76e5c9914fb9281a1c7e284d73e67f1809a48a497200e046d39ccc7112cd0'],
    ];
    const inputs = [
      ...vectors.map(([value]) => value),
      ...Array.from({ length: 260 }, (_, length) => 'x'.repeat(length)),
      '\u03bb/\u65e5\u672c\u8a9e/\u{1f680}', '\ud800', '\udc00', '\ud800a\udc00', 'abc\0def',
      'url:http://192.168.1.20:3000', JSON.stringify(plan.target),
    ];
    const native = await Promise.all(inputs.map((input) => owner.runtimeKey(input)));
    await withoutSubtle(async () => {
      expect(globalThis.crypto.subtle).toBe(undefined);
      for (const [index, input] of inputs.entries()) {
        const actual = await owner.runtimeKey(input);
        expect(actual).toBe(native[index]);
        expect(actual).toBe(createHash('sha256').update(input).digest('hex'));
      }
      for (const [input, expected] of vectors) expect(await owner.runtimeKey(input)).toBe(expected);
      expect(owner.getSnapshot().problem).toBeNull();
    });
  });

  test('secure and insecure paths persist byte-identical v1 references', async () => {
    const secure = setup();
    await secure.owner.remember(runtime, plan);
    await withoutSubtle(async () => {
      const insecure = setup();
      await insecure.owner.remember(runtime, plan);
      expect([...insecure.storage.values]).toEqual([...secure.storage.values]);
      expect(insecure.owner.getSnapshot().problem).toBeNull();
    });
  });

  test('matches the durable target after force-lease and SCP display redaction', async () => {
    const { owner } = setup();
    const target = plan.target;
    if (target.operation !== 'push') throw new Error('Expected a push fixture');
    const forceTarget = {
      ...target,
      remote: { ...target.remote, endpoint: { ...target.remote.endpoint, displayUrl: 'git@example.com:team/repo.git' } },
      forceWithLease: { expectedRemoteSha: 'a'.repeat(40) },
    };
    const forcePlan: GitNetworkOperationPlan = {
      ...plan,
      operationId: 'git_force_scp',
      target: forceTarget,
    };
    await owner.remember(runtime, forcePlan);
    const reference = owner.getSnapshot().references[0];
    const durableTarget = { ...forceTarget, forceWithLease: undefined };
    const recovered: GitNetworkOperation = {
      ...forcePlan,
      state: 'outcome-unknown',
      error: { code: 'OUTCOME_UNKNOWN', message: 'Inspect repository state' },
      target: {
        ...durableTarget,
        remote: { ...durableTarget.remote, endpoint: { ...durableTarget.remote.endpoint, displayUrl: 'example.com:team/repo.git' } },
      },
    };

    expect((await owner.reconcile(reference, { getNetworkOperation: async () => recovered }, runtime, () => true))?.operation)
      .toEqual(recovered);
  });

  test('native v1 unknown references survive LAN hydration, exact identity checks and NOT_FOUND without being waived', async () => {
    const { owner, storage } = setup();
    await owner.remember(runtime, plan);
    const original = [...storage.values.values()][0];
    await withoutSubtle(async () => {
      const lan = createGitOperationRecoveryOwner(() => storage);
      lan.hydrate();
      const reference = lan.getSnapshot().references[0];
      expect(reference.runtimeKey).toBe(createHash('sha256').update(runtime).digest('hex'));
      let plans = 0;
      await expect(lan.plan({ planNetworkOperation: async () => { plans += 1; return plan; } }, request, runtime, () => true)).rejects.toThrow('pending');
      expect(plans).toBe(0);
      let gets = 0;
      expect(await lan.reconcile(reference, { getNetworkOperation: async () => { gets += 1; return { ...plan, state: 'succeeded' }; } }, 'different-runtime', () => true)).toBeNull();
      expect(gets).toBe(0);
      const target = plan.target;
      if (target.operation !== 'push') throw new Error('Expected a push fixture');
      const changed: GitNetworkOperation[] = [
        { ...plan, state: 'succeeded', operationId: 'another-operation' },
        { ...plan, state: 'succeeded', runtimeIdentity: { ...plan.runtimeIdentity, id: 'another-server' } },
        { ...plan, state: 'succeeded', runtimeIdentity: { ...plan.runtimeIdentity, platform: 'vscode' } },
        { ...plan, state: 'succeeded', target: { ...target, repositoryId: 'another-repository' } },
        { ...plan, state: 'succeeded', target: { ...target, destinationRef: 'refs/heads/another-target' } },
      ];
      for (const operation of changed) expect(await lan.reconcile(reference, { getNetworkOperation: async () => operation }, runtime, () => true)).toBeNull();
      expect(await lan.reconcile(reference, { getNetworkOperation: async () => { throw new GitNetworkOperationRequestError('NOT_FOUND', 'Missing', 404); } }, runtime, () => true)).toBeNull();
      const unknown: GitNetworkOperation = { ...plan, state: 'outcome-unknown', error: { code: 'OUTCOME_UNKNOWN', message: 'Private process output' } };
      expect((await lan.reconcile(reference, { getNetworkOperation: async () => unknown }, runtime, () => true))?.operation.state).toBe('outcome-unknown');
      expect([...storage.values.values()][0]).toBe(original);
      expect(lan.getSnapshot().problem).toBeNull();
      expect(lan.getSnapshot().references).toEqual([reference]);
      await lan.reconcile(reference, { getNetworkOperation: async () => ({ ...plan, state: 'succeeded' }) }, runtime, () => true);
      expect(lan.getSnapshot().references).toEqual([]);
    });
  });

  test('LAN storage failure still blocks planning before any mutation', async () => {
    await withoutSubtle(async () => {
      const { owner, storage } = setup();
      storage.failWrite = true;
      let plans = 0;
      await expect(owner.plan({ planNetworkOperation: async () => { plans += 1; return plan; } }, request, runtime, () => true)).rejects.toThrow('storage');
      expect(plans).toBe(0);
      expect(owner.getSnapshot().problem).toBe('storage');
    });
  });
});

describe('durable unresolved Git references', () => {
  test('reload restores only uncertainty references without URLs, credentials, transport guesses or result history', async () => {
    const { owner, storage } = setup();
    const selected: GitNetworkOperationPlan = { ...plan, transport: { mode: 'managed', verification: { status: 'verified', method: 'credential' }, actor: {
      kind: 'provider', provider: 'github', instance: 'https://provider.example.com', accountId: 'private-account', login: 'private-login',
    } } };
    await owner.remember(runtime, selected);
    const encoded = [...storage.values.values()][0];
    for (const value of ['https://', '/private/', 'private-account', 'private-login', 'transport', 'state', 'completedSteps']) expect(encoded).not.toContain(value);
    const restarted = createGitOperationRecoveryOwner(() => storage);
    restarted.hydrate();
    expect(restarted.getSnapshot().ready).toBe(true);
    expect(restarted.getSnapshot().references).toEqual(owner.getSnapshot().references);
    expect(restarted.getSnapshot().references[0].operationId).toBe('git_original');
    let plans = 0;
    await expect(restarted.plan({ planNetworkOperation: async () => { plans += 1; return plan; } }, request, runtime, () => true)).rejects.toThrow(PendingGitOperationError);
    expect(plans).toBe(0);
  });

  for (const failure of ['read', 'write'] as const) {
    test(`${failure} failure blocks even plan creation`, async () => {
      const { owner, storage } = setup();
      storage.failRead = failure === 'read';
      storage.failWrite = failure === 'write';
      let plans = 0;
      await expect(owner.plan({ planNetworkOperation: async () => { plans += 1; return plan; } }, request, runtime, () => true)).rejects.toThrow('storage');
      expect(plans).toBe(0);
      expect(owner.getSnapshot().problem).toBe('storage');
    });
  }

  test('a write failure after planning prevents execute dispatch', async () => {
    const { owner, storage } = setup();
    let plans = 0;
    let executions = 0;
    const run = async () => {
      await owner.plan({ planNetworkOperation: async () => { plans += 1; storage.failWrite = true; return plan; } }, request, runtime, () => true);
      executions += 1;
    };
    await expect(run()).rejects.toThrow('storage');
    expect(plans).toBe(1);
    expect(executions).toBe(0);
  });

  test('NOT_FOUND after restart keeps the pending marker and never recreates an operation', async () => {
    const { owner, storage } = setup();
    await owner.remember(runtime, plan);
    const restarted = createGitOperationRecoveryOwner(() => storage);
    restarted.hydrate();
    const reference = restarted.getSnapshot().references[0];
    const original = [...storage.values.values()];
    const calls: string[] = [];
    expect(await restarted.reconcile(reference, { getNetworkOperation: async (id) => { calls.push(id); throw new GitNetworkOperationRequestError('NOT_FOUND', 'Operation no longer exists', 404); } }, runtime, () => true)).toBeNull();
    expect(calls).toEqual(['git_original']);
    expect(restarted.getSnapshot().references).toEqual([reference]);
    expect([...storage.values.values()]).toEqual(original);
  });

  test('an authoritative terminal result clears the durable guard; a new action still needs a user dispatch', async () => {
    const { owner, storage } = setup();
    await owner.remember(runtime, plan);
    const reference = owner.getSnapshot().references[0];
    const result = await owner.reconcile(reference, { getNetworkOperation: async () => ({ ...plan, state: 'succeeded' }) }, runtime, () => true);
    expect(result?.operation.state).toBe('succeeded');
    expect(owner.getSnapshot().references).toEqual([]);
    const restarted = createGitOperationRecoveryOwner(() => storage);
    restarted.hydrate();
    expect(restarted.getSnapshot().references).toEqual([]);
    let plans = 0;
    await restarted.plan({ planNetworkOperation: async () => { plans += 1; return { ...plan, operationId: 'git_user-retry' }; } }, request, runtime, () => true);
    expect(plans).toBe(1);
  });

  test('unknown terminal outcomes stay blocked across reload and successful GET', async () => {
    const { owner, storage } = setup();
    await owner.remember(runtime, plan);
    const unknown: GitNetworkOperation = { ...plan, state: 'outcome-unknown', error: { code: 'OUTCOME_UNKNOWN', message: 'private process output' } };
    await owner.reconcile(owner.getSnapshot().references[0], { getNetworkOperation: async () => unknown }, runtime, () => true);
    const restarted = createGitOperationRecoveryOwner(() => storage);
    restarted.hydrate();
    expect(restarted.getSnapshot().references).toHaveLength(1);
    expect([...storage.values.values()][0]).not.toContain('private process output');
  });

  test('runtime switches send no request to the wrong endpoint and late completion cannot clear the marker', async () => {
    const { owner } = setup();
    await owner.remember(runtime, plan);
    const reference = owner.getSnapshot().references[0];
    let calls = 0;
    const git = { getNetworkOperation: async (): Promise<GitNetworkOperation> => { calls += 1; return { ...plan, state: 'succeeded' }; } };
    expect(await owner.reconcile(reference, git, 'runtime-two', () => true)).toBeNull();
    expect(calls).toBe(0);
    let current = true;
    await owner.reconcile(reference, { getNetworkOperation: async () => { current = false; return { ...plan, state: 'succeeded' }; } }, runtime, () => current);
    expect(owner.getSnapshot().references).toEqual([reference]);
    let plans = 0;
    await expect(owner.plan({ planNetworkOperation: async () => { plans += 1; return plan; } }, request, runtime, () => false)).rejects.toThrow('pending');
    expect(plans).toBe(0);
  });

  test('server replacement or a different target cannot clear an original reference', async () => {
    const { owner } = setup();
    await owner.remember(runtime, plan);
    const reference = owner.getSnapshot().references[0];
    expect(await owner.reconcile(reference, { getNetworkOperation: async () => ({ ...plan, state: 'succeeded', runtimeIdentity: { ...plan.runtimeIdentity, id: 'replacement-server' } }) }, runtime, () => true)).toBeNull();
    const other: GitNetworkOperation = { ...plan, state: 'succeeded', target: { ...plan.target, operation: 'push', repositoryId: 'other-repo', bindingRevision: 1, configRevision: 'other', remote: request.remote, sourceRef: request.sourceRef, destinationRef: request.destinationRef } };
    expect(await owner.reconcile(reference, { getNetworkOperation: async () => other }, runtime, () => true)).toBeNull();
    expect(owner.getSnapshot().references).toEqual([reference]);
  });

  test('terminal-marker removal failure keeps storage intact and retry is read-only', async () => {
    const { owner, storage } = setup();
    await owner.remember(runtime, plan);
    const reference = owner.getSnapshot().references[0];
    const original = [...storage.values.values()][0];
    storage.failWrite = true;
    const result = await owner.reconcile(reference, { getNetworkOperation: async () => ({ ...plan, state: 'succeeded' }) }, runtime, () => true);
    expect(result?.operation.state).toBe('succeeded');
    expect([...storage.values.values()][0]).toBe(original);
    expect(owner.getSnapshot().problem).toBe('storage');
    storage.failWrite = false;
    await owner.reconcile(reference, { getNetworkOperation: async () => ({ ...plan, state: 'succeeded' }) }, runtime, () => true);
    expect(owner.getSnapshot().references).toEqual([]);
  });

  test('capacity never evicts unresolved references, including references on other runtimes', async () => {
    const { owner, storage } = setup();
    for (let index = 0; index < 64; index += 1) await owner.remember(`${runtime}-${index}`, { ...plan, operationId: `git_${index}` });
    const original = [...storage.values.values()][0];
    let plans = 0;
    await expect(owner.plan({ planNetworkOperation: async () => { plans += 1; return plan; } }, request, 'another-runtime', () => true)).rejects.toThrow('capacity');
    expect(plans).toBe(0);
    expect([...storage.values.values()][0]).toBe(original);
    expect(owner.getSnapshot().references).toHaveLength(64);
  });

  test('terminal cleanup cannot erase an intervening reference on another runtime', async () => {
    const { owner } = setup();
    await owner.remember(runtime, plan);
    const finishing = owner.complete({ runtimeKey: runtime, operation: { ...plan, state: 'succeeded' }, availability: 'available' });
    await owner.remember('runtime-two', plan);
    await finishing;
    expect(owner.getSnapshot().references).toHaveLength(1);
    expect(owner.getSnapshot().references[0].runtimeKey).toBe(await owner.runtimeKey('runtime-two'));
  });

  test('concurrent plans for one repository cannot pass the same unresolved guard', async () => {
    const { owner } = setup();
    let calls = 0;
    let release = () => {};
    let started = () => {};
    const waiting = new Promise<void>((resolve) => { release = resolve; });
    const dispatched = new Promise<void>((resolve) => { started = resolve; });
    const git = { planNetworkOperation: async () => { calls += 1; started(); await waiting; return plan; } };
    const first = owner.plan(git, request, runtime, () => true);
    await dispatched;
    await expect(owner.plan(git, request, runtime, () => true)).rejects.toThrow('pending');
    release();
    expect(await first).toBe(plan);
    expect(calls).toBe(1);
  });

  test('malformed storage is not replaced by an empty success', async () => {
    const { owner, storage } = setup();
    await owner.remember(runtime, plan);
    const key = [...storage.values.keys()][0];
    storage.values.set(key, '{"version":2,"references":[]}');
    owner.hydrate();
    expect(owner.getSnapshot().ready).toBe(false);
    expect(owner.getSnapshot().references).toHaveLength(1);
    expect(storage.values.get(key)).toBe('{"version":2,"references":[]}');
  });

  test('anonymous clone references keep a null repository and no fabricated System identity', async () => {
    const { owner, storage } = setup();
    const clone: GitNetworkOperationPlan = { ...plan, transport: { mode: 'anonymous', verification: { status: 'anonymous' } },
      target: { operation: 'clone', remote: endpoint, destination: { displayName: 'checkout', fingerprint: 'destination' } } };
    await owner.plan({ planNetworkOperation: async () => clone }, { operation: 'clone', destinationPath: '/private/destination', remoteUrl: endpoint.displayUrl, transportMode: 'anonymous' }, runtime, () => true);
    const reference = owner.getSnapshot().references[0];
    expect(reference.repositoryId).toBeNull();
    expect(reference.operation).toBe('clone');
    expect([...storage.values.values()][0]).not.toContain('system');
    const result = await owner.reconcile(reference, { getNetworkOperation: async () => ({ ...clone, state: 'partial', completedSteps: ['checked-out'], error: { code: 'TRANSPORT_FAILED', message: 'Finish setup' } }) }, runtime, () => true);
    expect(result?.operation.state).toBe('partial');
    expect(owner.getSnapshot().references).toEqual([]);
  });

  test('restored checkout hydration is inspected by ID and never resumed automatically', async () => {
    const { owner } = setup();
    const hydration: GitNetworkOperationPlan = {
      ...plan,
      target: {
        operation: 'checkout-hydration', repositoryId: 'repository-one', bindingRevision: 2,
        configRevision: 'config-one', remote: { name: 'origin', endpoint }, requirements: [],
      },
    };
    await owner.remember(runtime, hydration);
    const reference = owner.getSnapshot().references[0];
    let reads = 0;
    const result = await owner.reconcile(reference, {
      getNetworkOperation: async (operationId) => {
        reads += 1;
        expect(operationId).toBe(hydration.operationId);
        return { ...hydration, state: 'failed', error: { code: 'AUTHENTICATION_REQUIRED', message: 'Grant required' },
          hydration: { status: 'authorization-required', submodules: [], lfs: [{ path: '.', status: 'authorization-required',
            error: { code: 'AUTHENTICATION_REQUIRED', message: 'Grant required' } }] } };
      },
    }, runtime, () => true);
    expect(reads).toBe(1);
    expect(result?.operation.state).toBe('failed');
    expect(owner.getSnapshot().references).toEqual([]);
  });
});
