import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { createMutationExecutor, digestMutationInput, mutationReceipt } from './mutation-executor.js';
import { createMutationStore } from './mutation-storage.js';
import { createSourceControlAuditStore } from './audit-storage.js';
import { storageProcess } from './storage-process.test-support.js';
import { withSourceControlFileLock } from './file-lock.js';

const directories = [];
const children = [];
const persistedExecutors = async () => {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'openchamber-mutation-audit-'));
  directories.push(directory);
  const mutationPath = path.join(directory, 'source-control-mutations.json');
  const auditPath = path.join(directory, 'source-control-audit.json');
  const recreate = (id, { mutationFs = fs, auditFs = fs } = {}) => {
    const store = createMutationStore({ filePath: mutationPath, fsImpl: mutationFs });
    const auditStore = createSourceControlAuditStore({ filePath: auditPath, fsImpl: auditFs });
    const executor = createMutationExecutor({ store, auditStore, runtimeIdentity: { id, platform: 'web' } });
    return {
      store, auditStore,
      executor: {
        read: (key) => executor.read(key),
        execute: (input) => executor.execute({ ...input, providerAccountId: 'github.com#42' }),
      },
    };
  };
  return { mutationPath, auditPath, recreate };
};

afterEach(async () => {
  await Promise.all(children.splice(0).map((child) => child.stop()));
  await Promise.all(directories.splice(0).map((directory) => fs.rm(directory, { recursive: true, force: true })));
});

const mutation = (overrides = {}) => ({
  key: 'request-one',
  inputDigest: 'digest-one',
  kind: 'change-request-create',
  actor: { provider: 'github', instance: 'github.com', accountId: 'account-one' },
  target: {
    repositoryId: 'repo-one',
    bindingRevision: 3,
    primaryRemote: 'origin',
    project: { id: 'project-one', owner: 'openchamber', name: 'openchamber' },
  },
  ...overrides,
});

const makeStore = (initial = []) => {
  const records = new Map(initial.map((record) => [record.key, record]));
  const claim = vi.fn(async (record) => {
    const existing = records.get(record.key);
    if (existing) return existing.inputDigest === record.inputDigest
      ? { status: 'existing', record: existing }
      : { status: 'conflict', record: existing };
    const running = { ...record, state: 'running' };
    records.set(record.key, running);
    return { status: 'claimed', record: running };
  });
  const complete = vi.fn(async (key, inputDigest, completion) => {
    const existing = records.get(key);
    if (!existing || existing.inputDigest !== inputDigest || existing.state !== 'running') throw new Error('conflict');
    const completed = { ...existing, state: completion.state };
    if (completion.result !== undefined) completed.result = completion.result;
    records.set(key, completed);
    return completed;
  });
  const read = vi.fn(async (key) => records.get(key) ?? null);
  return { records, claim, complete, read, withExecutionLock: async (_key, operation) => operation() };
};

const deferred = () => {
  let resolve;
  const promise = new Promise((resolvePromise) => {
    resolve = resolvePromise;
  });
  return { promise, resolve };
};

describe('source-control mutation executor', () => {
  it.each(['failed', 'outcome-unknown'])('releases settled %s execution ownership without permitting another provider write', async (outcome) => {
    const { mutationPath } = await persistedExecutors();
    const pair = await Promise.all([storageProcess('executor', mutationPath), storageProcess('executor', mutationPath)]);
    children.push(...pair);
    const first = await pair[0].call('execute', [mutation()], { outcome }).result;
    const second = await pair[1].call('execute', [mutation()]).result;
    expect(first.ok).toBe(false);
    expect(second).toMatchObject({ ok: false, error: { code: outcome === 'failed' ? 'SOURCE_CONTROL_MUTATION_FAILED' : 'SOURCE_CONTROL_MUTATION_OUTCOME_UNKNOWN' } });
    expect(pair.flatMap((child) => child.events).filter((event) => event.event === 'perform')).toHaveLength(1);
    expect(pair.flatMap((child) => child.events).filter((event) => event.event === 'reconcile')).toHaveLength(0);
    expect((await fs.readdir(path.dirname(mutationPath))).filter((name) => name.endsWith('.lock'))).toEqual([]);
  });

  it('preserves actionable completion-lock failure and reconciles without repeating provider work', async () => {
    const { mutationPath } = await persistedExecutors();
    const store = createMutationStore({ filePath: mutationPath, lockWaitMs: 20 });
    const locked = deferred();
    const release = deferred();
    let snapshotOwner;
    const perform = vi.fn(async () => {
      snapshotOwner = withSourceControlFileLock(`${mutationPath}.lock`, async () => { locked.resolve(); await release.promise; });
      await locked.promise;
      return { number: 7 };
    });
    try {
      await expect(createMutationExecutor({ store }).execute({ record: mutation(), perform }))
        .rejects.toMatchObject({ code: 'SOURCE_CONTROL_LOCK_BUSY', status: 503, message: expect.stringContaining('Provider outcome could not be recorded') });
    } finally {
      release.resolve();
      await snapshotOwner;
    }
    const reconcile = vi.fn(async () => ({ state: 'succeeded', result: { number: 7 } }));
    await expect(createMutationExecutor({ store }).execute({ record: mutation(), perform, reconcile }))
      .resolves.toMatchObject({ replayed: true });
    expect(perform).toHaveBeenCalledOnce();
    expect(reconcile).toHaveBeenCalledOnce();
  });

  it('holds a per-key lock across provider work and completion while unrelated entities progress', async () => {
    const { mutationPath, recreate } = await persistedExecutors();
    const pair = await Promise.all([storageProcess('executor', mutationPath), storageProcess('executor', mutationPath)]);
    children.push(...pair);
    const owner = pair[0].call('execute', [mutation()], { hold: true });
    await expect.poll(() => pair[0].events.some((event) => event.event === 'perform')).toBe(true);
    const duplicate = await pair[1].call('execute', [mutation()]).result;
    expect(duplicate).toMatchObject({ ok: false, error: { code: 'SOURCE_CONTROL_LOCK_BUSY', status: 503 } });
    expect(pair[1].events.filter((event) => ['perform', 'reconcile'].includes(event.event))).toEqual([]);
    const unrelated = await pair[1].call('execute', [mutation({ key: 'other', inputDigest: 'other' })]).result;
    expect(unrelated).toMatchObject({ ok: true, value: { replayed: false } });
    pair[0].release(owner.id);
    expect(await owner.result).toMatchObject({ ok: true, value: { replayed: false } });
    const replay = await pair[1].call('execute', [mutation()]).result;
    expect(replay).toMatchObject({ ok: true, value: { replayed: true, record: { state: 'succeeded' } } });
    expect(pair.flatMap((child) => child.events).filter((event) => event.event === 'perform')).toHaveLength(2);
    expect(pair.flatMap((child) => child.events).filter((event) => event.event === 'reconcile')).toHaveLength(0);
    expect(await recreate('reader').store.list()).toHaveLength(2);
  });

  it('a waiting daemon replays after the owner releases instead of reconciling live work', async () => {
    const { mutationPath } = await persistedExecutors();
    const pair = await Promise.all([storageProcess('executor', mutationPath), storageProcess('executor', mutationPath)]);
    children.push(...pair);
    const owner = pair[0].call('execute', [mutation()], { hold: true });
    await expect.poll(() => pair[0].events.some((event) => event.event === 'perform')).toBe(true);
    const duplicate = pair[1].call('execute', [mutation()]);
    pair[0].release(owner.id);
    expect(await owner.result).toMatchObject({ ok: true, value: { replayed: false } });
    expect(await duplicate.result).toMatchObject({ ok: true, value: { replayed: true } });
    expect(pair.flatMap((child) => child.events).filter((event) => event.event === 'perform')).toHaveLength(1);
    expect(pair.flatMap((child) => child.events).filter((event) => event.event === 'reconcile')).toHaveLength(0);
  });

  it.each(['succeeded', 'outcome-unknown'])('blocks a crashed owner until stopped-writer cleanup, then reconciles %s without another perform', async (outcome) => {
    const { mutationPath } = await persistedExecutors();
    const owner = await storageProcess('executor', mutationPath);
    children.push(owner);
    owner.call('execute', [mutation()], { hold: true });
    await expect.poll(() => owner.events.some((event) => event.event === 'perform')).toBe(true);
    await owner.stop();
    const lockName = (await fs.readdir(path.dirname(mutationPath))).find((name) => name.includes('.execution-'));
    const lockPath = path.join(path.dirname(mutationPath), lockName);
    const nonce = await fs.readFile(lockPath, 'utf8');
    const blocked = await storageProcess('executor', mutationPath);
    children.push(blocked);
    expect(await blocked.call('execute', [mutation()]).result).toMatchObject({ ok: false, error: { code: 'SOURCE_CONTROL_LOCK_BUSY' } });
    expect(await fs.readFile(lockPath, 'utf8')).toBe(nonce);
    expect(blocked.events.filter((event) => ['perform', 'reconcile'].includes(event.event))).toEqual([]);
    await blocked.stop();
    // Manual recovery only after every writer has stopped. Keep both JSON stores.
    await fs.unlink(lockPath);
    const recovered = await storageProcess('executor', mutationPath);
    children.push(recovered);
    const result = await recovered.call('execute', [mutation()], { outcome }).result;
    if (outcome === 'succeeded') expect(result).toMatchObject({ ok: true, value: { replayed: true } });
    else expect(result).toMatchObject({ ok: false, error: { code: 'SOURCE_CONTROL_MUTATION_OUTCOME_UNKNOWN' } });
    await recovered.call('execute', [mutation()], { outcome }).result;
    expect(recovered.events.filter((event) => event.event === 'perform')).toHaveLength(0);
    expect(recovered.events.filter((event) => event.event === 'reconcile')).toHaveLength(1);
  });

  it('keeps execution ownership until the completion snapshot has been published', async () => {
    const { mutationPath, recreate } = await persistedExecutors();
    const completing = deferred();
    const release = deferred();
    let writes = 0;
    const first = recreate('first', { mutationFs: { ...fs, rename: async (...args) => {
      writes += 1;
      if (writes === 2) { completing.resolve(); await release.promise; }
      return fs.rename(...args);
    } } });
    const owner = first.executor.execute({ record: mutation(), perform: async () => ({ number: 7 }) });
    await completing.promise;
    const store = createMutationStore({ filePath: mutationPath, lockWaitMs: 20 });
    const perform = vi.fn();
    const reconcile = vi.fn();
    try {
      await expect(createMutationExecutor({ store }).execute({ record: mutation(), perform, reconcile }))
        .rejects.toMatchObject({ code: 'SOURCE_CONTROL_LOCK_BUSY' });
      expect(perform).not.toHaveBeenCalled();
      expect(reconcile).not.toHaveBeenCalled();
    } finally {
      release.resolve();
      await owner;
    }
    await expect(createMutationExecutor({ store }).execute({ record: mutation(), perform, reconcile }))
      .resolves.toMatchObject({ replayed: true });
  });

  it('requires execution exclusion rather than silently falling back to process-local ownership', () => {
    const store = makeStore();
    delete store.withExecutionLock;
    expect(() => createMutationExecutor({ store })).toThrow('Mutation executor requires a store');
  });

  it('delegates durable reads to the store', async () => {
    const record = { ...mutation(), state: 'succeeded', result: { number: 9 } };
    const store = makeStore([record]);

    await expect(createMutationExecutor({ store }).read('request-one')).resolves.toBe(record);
    expect(store.read).toHaveBeenCalledWith('request-one');
  });

  it('rejects a store without read support', () => {
    const store = makeStore();
    delete store.read;

    expect(() => createMutationExecutor({ store })).toThrow(new TypeError('Mutation executor requires a store'));
  });

  it('hashes canonical JSON values without depending on object key order', () => {
    expect(digestMutationInput({ z: [1, { b: true, a: null }], a: 'value' }))
      .toBe(digestMutationInput({ a: 'value', z: [1, { a: null, b: true }] }));
    expect(digestMutationInput({ value: 1 })).not.toBe(digestMutationInput({ value: 2 }));
  });

  it.each([
    undefined,
    Number.NaN,
    Number.POSITIVE_INFINITY,
    1n,
    new Date(),
    { nested: undefined },
    Array(1),
  ])('rejects unsupported digest input %# without exposing it', (value) => {
    expect(() => digestMutationInput(value)).toThrow('Mutation input contains an unsupported value');
  });

  it('rejects cyclic digest input without exposing input text', () => {
    const value = { privateText: 'do not expose' };
    value.self = value;
    try {
      digestMutationInput(value);
      throw new Error('expected digest failure');
    } catch (error) {
      expect(error.message).not.toContain('do not expose');
    }
  });

  it('claims durably before provider work and returns the compact receipt fields', async () => {
    const store = makeStore();
    const perform = vi.fn(async () => {
      expect(store.claim).toHaveBeenCalledOnce();
      expect(store.records.get('request-one')?.state).toBe('running');
      return { number: 42, state: 'open' };
    });
    const result = await createMutationExecutor({ store }).execute({ record: mutation(), perform });

    expect(perform).toHaveBeenCalledOnce();
    expect(result).toMatchObject({ replayed: false, record: { state: 'succeeded', result: { number: 42 } } });
    expect(mutationReceipt(result.record, result.replayed, 'github.com#42')).toEqual({
      status: 'succeeded',
      actor: { provider: 'github', instance: 'github.com', providerAccountId: 'github.com#42' },
      target: result.record.target,
      replayed: false, result: { number: 42, state: 'open' },
    });
  });

  it('refuses to expose a receipt without verified provider actor metadata', () => {
    expect(() => mutationReceipt({ ...mutation(), state: 'succeeded', result: {} }, false))
      .toThrow('verified provider account ID');
  });

  it('joins exact in-flight requests and rejects a changed digest without another claim', async () => {
    const store = makeStore();
    const work = deferred();
    const perform = vi.fn(() => work.promise);
    const executor = createMutationExecutor({ store });
    const owner = executor.execute({ record: mutation(), providerAccountId: 'github.com#42', perform });
    const duplicate = executor.execute({ record: mutation(), providerAccountId: 'github.com#42', perform });
    const conflict = executor.execute({ record: mutation({ inputDigest: 'changed' }), perform });
    work.resolve({ number: 7 });

    await expect(owner).resolves.toMatchObject({ replayed: false });
    await expect(duplicate).resolves.toMatchObject({ replayed: true, record: { result: { number: 7 } } });
    await expect(conflict).rejects.toMatchObject({ status: 409, code: 'SOURCE_CONTROL_MUTATION_CONFLICT' });
    expect(store.claim).toHaveBeenCalledOnce();
    expect(perform).toHaveBeenCalledOnce();
  });

  it('uses the provider idempotency key as one audit identity across duplicate and replay requests', async () => {
    const store = makeStore();
    const auditRecords = new Map();
    const auditStore = {
      read: vi.fn(async (id) => auditRecords.get(id) ?? null),
      plan: vi.fn(async (record) => {
        const existing = auditRecords.get(record.id);
        if (existing) return { status: 'existing', record: existing };
        const planned = { ...record, state: 'planned' };
        auditRecords.set(record.id, planned);
        return { status: 'planned', record: planned };
      }),
      start: vi.fn(async (id) => {
        const running = { ...auditRecords.get(id), state: 'running' };
        auditRecords.set(id, running);
        return running;
      }),
      finish: vi.fn(async (id, result) => {
        const finished = { ...auditRecords.get(id), state: result.state, result };
        auditRecords.set(id, finished);
        return finished;
      }),
    };
    const executor = createMutationExecutor({
      store, auditStore, runtimeIdentity: { id: 'server_one', platform: 'web' },
    });
    const work = deferred();
    const perform = vi.fn(() => work.promise);
    const owner = executor.execute({ record: mutation(), providerAccountId: 'github.com#42', perform });
    const duplicate = executor.execute({ record: mutation(), providerAccountId: 'github.com#42', perform });
    work.resolve({ number: 7 });
    await Promise.all([owner, duplicate]);
    await executor.execute({ record: mutation(), providerAccountId: 'github.com#42', perform });

    expect(perform).toHaveBeenCalledOnce();
    expect(auditRecords).toHaveLength(1);
    expect(auditStore.finish).toHaveBeenCalledOnce();
    expect(auditRecords.get('provider:request-one')).toMatchObject({
      initiator: 'user', executorKind: 'provider-api', repositoryId: 'repo-one',
      providerAccountId: 'github.com#42', state: 'succeeded',
      transportReference: null,
      target: { kind: 'change-request', operation: 'change-request-create', projectId: 'project-one' },
      result: { state: 'succeeded', errorCode: null, steps: ['provider-request'] },
    });
  });

  it('requires verified provider identity before planning an audited mutation', async () => {
    const store = makeStore();
    const auditStore = {
      read: vi.fn(), plan: vi.fn(), start: vi.fn(), finish: vi.fn(),
    };
    const executor = createMutationExecutor({
      store, auditStore, runtimeIdentity: { id: 'server_one', platform: 'web' },
    });

    await expect(executor.execute({ record: mutation(), perform: vi.fn() }))
      .rejects.toThrow('verified provider account ID');
    expect(store.claim).not.toHaveBeenCalled();
    expect(auditStore.plan).not.toHaveBeenCalled();
  });

  it('audits one provider user while retaining distinct credential replay actors', async () => {
    const { recreate } = await persistedExecutors();
    const { executor, store, auditStore } = recreate('server_one');
    const first = mutation({ key: 'first', inputDigest: 'credential-one' });
    const second = mutation({
      key: 'second',
      inputDigest: 'credential-two',
      actor: { provider: 'github', instance: 'github.com', accountId: 'account-two' },
    });

    await executor.execute({ record: first, perform: async () => ({}) });
    await executor.execute({ record: second, perform: async () => ({}) });

    expect((await store.list()).map((record) => record.actor.accountId)).toEqual(['account-one', 'account-two']);
    expect((await auditStore.list()).map((record) => record.providerAccountId)).toEqual(['github.com#42', 'github.com#42']);
  });

  it('replays completed, failed, and outcome-unknown durable records without provider work', async () => {
    const succeeded = { ...mutation({ key: 'success' }), state: 'succeeded', result: { number: 9 } };
    const failed = { ...mutation({ key: 'failure' }), state: 'failed', result: { failureStatus: 422, failureCode: 'INVALID_CHANGE' } };
    const unknown = { ...mutation({ key: 'unknown' }), state: 'outcome-unknown' };
    const store = makeStore([succeeded, failed, unknown]);
    const executor = createMutationExecutor({ store });
    const perform = vi.fn();

    await expect(executor.execute({ record: mutation({ key: 'success' }), perform })).resolves.toEqual({ record: succeeded, replayed: true });
    await expect(executor.execute({ record: mutation({ key: 'failure' }), perform })).rejects.toMatchObject({ status: 422, code: 'INVALID_CHANGE' });
    await expect(executor.execute({ record: mutation({ key: 'unknown' }), perform })).rejects.toMatchObject({ status: 409, code: 'SOURCE_CONTROL_MUTATION_OUTCOME_UNKNOWN' });
    expect(perform).not.toHaveBeenCalled();
  });

  it.each(['succeeded', 'failed', 'outcome-unknown'])('replays persisted %s mutations after a new startup without rewriting audit history', async (state) => {
    const { mutationPath, auditPath, recreate } = await persistedExecutors();
    const first = recreate('server_original');
    const perform = vi.fn(async () => {
      if (state !== 'succeeded') throw Object.assign(new Error('provider failure'), { status: 422, code: 'INVALID_CHANGE' });
      return { number: 9 };
    });
    const operation = first.executor.execute({ record: mutation(), perform, classifyError: () => state });
    if (state === 'succeeded') await expect(operation).resolves.toMatchObject({ replayed: false });
    else await expect(operation).rejects.toMatchObject({
      code: state === 'failed' ? 'INVALID_CHANGE' : 'SOURCE_CONTROL_MUTATION_OUTCOME_UNKNOWN',
    });
    const originalMutation = await fs.readFile(mutationPath, 'utf8');
    const originalAudit = await fs.readFile(auditPath, 'utf8');
    const restarted = recreate('server_restarted');
    const reconcile = vi.fn();
    const replay = restarted.executor.execute({ record: mutation(), perform, reconcile });
    if (state === 'succeeded') await expect(replay).resolves.toEqual({ record: await first.store.read('request-one'), replayed: true });
    else await expect(replay).rejects.toMatchObject({
      status: state === 'failed' ? 422 : 409,
      code: state === 'failed' ? 'INVALID_CHANGE' : 'SOURCE_CONTROL_MUTATION_OUTCOME_UNKNOWN',
    });
    expect(perform).toHaveBeenCalledOnce();
    expect(reconcile).not.toHaveBeenCalled();
    expect(await fs.readFile(mutationPath, 'utf8')).toBe(originalMutation);
    expect(await fs.readFile(auditPath, 'utf8')).toBe(originalAudit);
    await expect(restarted.auditStore.list()).resolves.toHaveLength(1);
  });

  it.each(['succeeded', 'failed', 'outcome-unknown', 'throws', 'invalid'])('reconciles persisted running work as %s using the original audit runtime', async (outcome) => {
    const { auditPath, recreate } = await persistedExecutors();
    let failCompletion = false;
    const first = recreate('server_original', {
      mutationFs: { ...fs, rename: async (source, destination) => {
        if (failCompletion) throw new Error('completion write failed');
        return fs.rename(source, destination);
      } },
    });
    const perform = vi.fn(async () => {
      failCompletion = true;
      return { number: 9 };
    });
    await expect(first.executor.execute({ record: mutation(), perform }))
      .rejects.toMatchObject({ code: 'SOURCE_CONTROL_MUTATION_OUTCOME_UNKNOWN' });
    const originalAudit = await first.auditStore.read('provider:request-one');
    expect(originalAudit.state).toBe('running');
    await expect(first.store.read('request-one')).resolves.toMatchObject({ state: 'running' });

    const restarted = recreate('server_restarted');
    const reconcile = vi.fn(async () => {
      if (outcome === 'throws') throw new Error('provider unavailable');
      if (outcome === 'invalid') return { state: 'unproved' };
      if (outcome === 'succeeded') return { state: outcome, result: { number: 9 } };
      if (outcome === 'failed') return { state: outcome, result: { failureStatus: 403, failureCode: 'DENIED' } };
      return { state: outcome };
    });
    const state = ['throws', 'invalid'].includes(outcome) ? 'outcome-unknown' : outcome;
    const replay = restarted.executor.execute({ record: mutation(), perform, reconcile });
    if (state === 'succeeded') await expect(replay).resolves.toMatchObject({ replayed: true, record: { state, result: { number: 9 } } });
    else await expect(replay).rejects.toMatchObject({ code: state === 'failed' ? 'DENIED' : 'SOURCE_CONTROL_MUTATION_OUTCOME_UNKNOWN' });
    expect(perform).toHaveBeenCalledOnce();
    expect(reconcile).toHaveBeenCalledOnce();
    await expect(restarted.store.read('request-one')).resolves.toMatchObject({ state });
    await expect(restarted.auditStore.list()).resolves.toEqual([{
      ...originalAudit,
      state,
      finishedAt: expect.any(Number),
      expiresAt: state === 'outcome-unknown' ? null : expect.any(Number),
      result: {
        state, steps: ['provider-reconciliation'],
        errorCode: state === 'succeeded' ? null : state === 'failed' ? 'DENIED' : 'SOURCE_CONTROL_MUTATION_OUTCOME_UNKNOWN',
      },
    }]);
    const completedAudit = await fs.readFile(auditPath, 'utf8');
    const replayAgain = recreate('server_third').executor.execute({ record: mutation(), perform, reconcile });
    if (state === 'succeeded') await expect(replayAgain).resolves.toMatchObject({ replayed: true });
    else await expect(replayAgain).rejects.toMatchObject({ code: state === 'failed' ? 'DENIED' : 'SOURCE_CONTROL_MUTATION_OUTCOME_UNKNOWN' });
    expect(perform).toHaveBeenCalledOnce();
    expect(reconcile).toHaveBeenCalledOnce();
    expect(await fs.readFile(auditPath, 'utf8')).toBe(completedAudit);
  });

  it('repairs an unfinished audit after a persisted mutation completion without provider reconciliation', async () => {
    const { recreate } = await persistedExecutors();
    let failCompletion = false;
    const first = recreate('server_original', {
      auditFs: { ...fs, rename: async (source, destination) => {
        if (failCompletion) throw new Error('audit completion write failed');
        return fs.rename(source, destination);
      } },
    });
    const perform = vi.fn(async () => {
      failCompletion = true;
      return { number: 9 };
    });
    await expect(first.executor.execute({ record: mutation(), perform })).rejects.toThrow('audit completion write failed');
    const originalAudit = await first.auditStore.read('provider:request-one');
    const restarted = recreate('server_restarted');
    const reconcile = vi.fn();
    await expect(restarted.executor.execute({ record: mutation(), perform, reconcile }))
      .resolves.toMatchObject({ replayed: true, record: { state: 'succeeded' } });
    expect(perform).toHaveBeenCalledOnce();
    expect(reconcile).not.toHaveBeenCalled();
    await expect(restarted.auditStore.read('provider:request-one')).resolves.toMatchObject({
      runtime: originalAudit.runtime, plannedAt: originalAudit.plannedAt, startedAt: originalAudit.startedAt,
      state: 'succeeded', result: { state: 'succeeded', errorCode: null, steps: ['provider-request'] },
    });
  });

  it.each(['input', 'target', 'actor'])('rejects a changed %s digest after restart without changing either persisted record', async (field) => {
    const { mutationPath, auditPath, recreate } = await persistedExecutors();
    const record = mutation();
    record.inputDigest = digestMutationInput({ kind: record.kind, actor: record.actor, target: record.target, title: 'Original' });
    const perform = vi.fn(async () => ({ number: 9 }));
    await recreate('server_original').executor.execute({ record, perform });
    const originalMutation = await fs.readFile(mutationPath, 'utf8');
    const originalAudit = await fs.readFile(auditPath, 'utf8');
    const changed = structuredClone(record);
    if (field === 'target') changed.target.project.id = 'project-two';
    if (field === 'actor') changed.actor.accountId = 'account-two';
    changed.inputDigest = digestMutationInput({ kind: changed.kind, actor: changed.actor, target: changed.target, title: field === 'input' ? 'Changed' : 'Original' });
    const reconcile = vi.fn();
    await expect(recreate('server_restarted').executor.execute({ record: changed, perform, reconcile }))
      .rejects.toMatchObject({ code: 'SOURCE_CONTROL_MUTATION_CONFLICT' });
    expect(perform).toHaveBeenCalledOnce();
    expect(reconcile).not.toHaveBeenCalled();
    expect(await fs.readFile(mutationPath, 'utf8')).toBe(originalMutation);
    expect(await fs.readFile(auditPath, 'utf8')).toBe(originalAudit);
  });

  it.each(['repositoryId', 'providerAccountId', 'target'])('still rejects a persisted audit %s mismatch after restart', async (field) => {
    const { mutationPath, auditPath, recreate } = await persistedExecutors();
    const first = recreate('server_original');
    const perform = vi.fn(async () => ({ number: 9 }));
    await first.executor.execute({ record: mutation(), perform });
    const auditState = JSON.parse(await fs.readFile(auditPath, 'utf8'));
    const audit = auditState.records['provider:request-one'];
    if (field === 'target') audit.target.projectId = 'project-two';
    else audit[field] = 'different-identity';
    await fs.writeFile(auditPath, JSON.stringify(auditState));
    const originalAudit = await fs.readFile(auditPath, 'utf8');
    const originalMutation = await fs.readFile(mutationPath, 'utf8');
    const reconcile = vi.fn();
    await expect(recreate('server_restarted').executor.execute({ record: mutation(), perform, reconcile }))
      .rejects.toMatchObject({ code: 'SOURCE_CONTROL_AUDIT_CONFLICT' });
    expect(perform).toHaveBeenCalledOnce();
    expect(reconcile).not.toHaveBeenCalled();
    expect(await fs.readFile(auditPath, 'utf8')).toBe(originalAudit);
    expect(await fs.readFile(mutationPath, 'utf8')).toBe(originalMutation);
  });

  it('does not treat an audit read failure as a missing original runtime', async () => {
    const { mutationPath, auditPath, recreate } = await persistedExecutors();
    const perform = vi.fn(async () => ({ number: 9 }));
    await recreate('server_original').executor.execute({ record: mutation(), perform });
    const originalMutation = await fs.readFile(mutationPath, 'utf8');
    const originalAudit = await fs.readFile(auditPath, 'utf8');
    const restarted = recreate('server_restarted', {
      auditFs: { ...fs, readFile: async () => { throw new Error('audit unreadable'); } },
    });
    const reconcile = vi.fn();
    await expect(restarted.executor.execute({ record: mutation(), perform, reconcile })).rejects.toThrow('audit unreadable');
    expect(perform).toHaveBeenCalledOnce();
    expect(reconcile).not.toHaveBeenCalled();
    expect(await fs.readFile(mutationPath, 'utf8')).toBe(originalMutation);
    expect(await fs.readFile(auditPath, 'utf8')).toBe(originalAudit);
  });

  it.each([
    ['succeeded', { state: 'succeeded', result: { number: 12 } }, { replayed: true, record: { state: 'succeeded' } }],
    ['failed', { state: 'failed', result: { failureStatus: 403, failureCode: 'DENIED' } }, { status: 403, code: 'DENIED' }],
    ['outcome unknown', { state: 'outcome-unknown' }, { status: 409, code: 'SOURCE_CONTROL_MUTATION_OUTCOME_UNKNOWN' }],
  ])('reconciles a durable running record as %s exactly once', async (_label, reconciliation, expected) => {
    const running = { ...mutation(), state: 'running' };
    const store = makeStore([running]);
    const reconcile = vi.fn(async () => reconciliation);
    const operation = createMutationExecutor({ store }).execute({ record: mutation(), perform: vi.fn(), reconcile });

    if (reconciliation.state === 'succeeded') await expect(operation).resolves.toMatchObject(expected);
    else await expect(operation).rejects.toMatchObject(expected);
    expect(reconcile).toHaveBeenCalledOnce();
    expect(store.complete).toHaveBeenCalledOnce();
    expect(store.records.get('request-one')?.state).toBe(reconciliation.state);
  });

  it('marks restart reconciliation exceptions and unproved outcomes as outcome unknown', async () => {
    for (const reconcile of [vi.fn(async () => { throw new Error('private provider failure'); }), vi.fn(async () => ({ state: 'maybe' }))]) {
      const running = { ...mutation(), state: 'running' };
      const store = makeStore([running]);
      await expect(createMutationExecutor({ store }).execute({ record: mutation(), perform: vi.fn(), reconcile }))
        .rejects.toMatchObject({ code: 'SOURCE_CONTROL_MUTATION_OUTCOME_UNKNOWN' });
      expect(store.records.get('request-one')?.state).toBe('outcome-unknown');
    }
  });

  it('persists compact definite failure metadata before rethrow and replays it stably', async () => {
    const store = makeStore();
    const providerError = Object.assign(new Error('private provider payload'), { status: 429, code: 'RATE_LIMITED' });
    const executor = createMutationExecutor({ store });
    await expect(executor.execute({ record: mutation(), perform: async () => { throw providerError; } })).rejects.toBe(providerError);
    expect(store.records.get('request-one')?.result).toEqual({ failureStatus: 429, failureCode: 'RATE_LIMITED' });

    await expect(executor.execute({ record: mutation(), perform: vi.fn() })).rejects.toMatchObject({ status: 429, code: 'RATE_LIMITED' });
    expect(store.claim).toHaveBeenCalledTimes(2);
  });

  it('persists ambiguous provider errors as outcome unknown', async () => {
    const store = makeStore();
    await expect(createMutationExecutor({ store }).execute({
      record: mutation(),
      perform: async () => { throw new Error('timeout'); },
      classifyError: () => 'outcome-unknown',
    })).rejects.toMatchObject({ code: 'SOURCE_CONTROL_MUTATION_OUTCOME_UNKNOWN' });
    expect(store.records.get('request-one')?.state).toBe('outcome-unknown');
  });

  it('reports completion-write ambiguity without retrying provider work and leaves restart recovery available', async () => {
    const store = makeStore();
    store.complete.mockImplementationOnce(async () => { throw new Error('disk unavailable'); });
    const perform = vi.fn(async () => ({ number: 4 }));
    await expect(createMutationExecutor({ store }).execute({ record: mutation(), perform }))
      .rejects.toMatchObject({ code: 'SOURCE_CONTROL_MUTATION_OUTCOME_UNKNOWN' });
    expect(perform).toHaveBeenCalledOnce();
    expect(store.records.get('request-one')?.state).toBe('running');

    const reconcile = vi.fn(async () => ({ state: 'succeeded', result: { number: 4 } }));
    await expect(createMutationExecutor({ store }).execute({ record: mutation(), perform, reconcile }))
      .resolves.toMatchObject({ replayed: true, record: { state: 'succeeded' } });
    expect(perform).toHaveBeenCalledOnce();
    expect(reconcile).toHaveBeenCalledOnce();
  });

  it('clears failed in-flight work after settlement', async () => {
    const store = makeStore();
    const executor = createMutationExecutor({ store });
    await expect(executor.execute({ record: mutation(), perform: async () => { throw new Error('failed'); } })).rejects.toThrow('failed');
    await expect(executor.execute({ record: mutation(), perform: vi.fn() })).rejects.toMatchObject({ code: 'SOURCE_CONTROL_MUTATION_FAILED' });
    expect(store.claim).toHaveBeenCalledTimes(2);
  });
});
