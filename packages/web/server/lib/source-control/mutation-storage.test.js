import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { createMutationStore } from './mutation-storage.js';
import { storageProcess } from './storage-process.test-support.js';

const directories = [];
const children = [];
const makeStore = async (options = {}) => {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'openchamber-mutations-'));
  directories.push(directory);
  const filePath = path.join(directory, 'source-control-mutations.json');
  return { filePath, store: createMutationStore({ filePath, ...options }) };
};
const claimFor = (key, inputDigest = `digest-${key}`, extra = {}) => ({
  key,
  inputDigest,
  kind: 'change-request-create',
  actor: { provider: 'github', instance: 'github.com', accountId: 'github.com#1' },
  target: {
    repositoryId: 'repo-one',
    bindingRevision: 3,
    primaryRemote: 'origin',
    project: { id: 'project-one', owner: 'openchamber', name: 'openchamber' },
    head: 'feature',
    base: 'main',
  },
  ...extra,
});

afterEach(async () => {
  await Promise.all(children.splice(0).map((child) => child.stop()));
  await Promise.all(directories.splice(0).map((directory) => fs.rm(directory, { recursive: true, force: true })));
});

describe('source-control mutation storage', () => {
  it('claims once across processes and preserves sibling claim and completion writes', async () => {
    const { filePath, store } = await makeStore();
    const pair = await Promise.all([storageProcess('mutation', filePath), storageProcess('mutation', filePath)]);
    children.push(...pair);
    const results = await Promise.all(pair.map((child) => child.call('claim', [claimFor('same')]).result));
    expect(results.map((result) => result.value.status).sort()).toEqual(['claimed', 'existing']);
    const siblings = await Promise.all(pair.map((child, index) => child.call('claim', [claimFor(`sibling-${index}`)]).result));
    expect(siblings.every((result) => result.ok)).toBe(true);
    const completions = await Promise.all(pair.map((child, index) => child.call('complete', [`sibling-${index}`, `digest-sibling-${index}`, { state: 'succeeded' }]).result));
    expect(completions.every((result) => result.ok)).toBe(true);
    expect(await store.list()).toHaveLength(3);
    for (const key of ['sibling-0', 'sibling-1']) expect(await store.read(key)).toMatchObject({ state: 'succeeded' });
  });

  it('does not return empty reads or claims under lock contention', async () => {
    const { filePath } = await makeStore();
    await fs.writeFile(`${filePath}.lock`, 'orphan');
    const store = createMutationStore({ filePath, lockWaitMs: 20 });
    for (const operation of [() => store.read('missing'), () => store.list(), () => store.claim(claimFor('missing'))]) {
      await expect(operation()).rejects.toMatchObject({ code: 'SOURCE_CONTROL_LOCK_BUSY', status: 503 });
    }
    expect(await fs.readFile(`${filePath}.lock`, 'utf8')).toBe('orphan');
  });

  it('treats a missing file as empty and fails closed for malformed or unsupported state', async () => {
    const { filePath, store } = await makeStore();
    await expect(store.read('missing')).resolves.toBeNull();
    await expect(store.list()).resolves.toEqual([]);

    await fs.writeFile(filePath, '{broken', 'utf8');
    await expect(store.read('key-one')).rejects.toBeInstanceOf(SyntaxError);
    await expect(store.claim(claimFor('key-one'))).rejects.toBeInstanceOf(SyntaxError);
    expect(await fs.readFile(filePath, 'utf8')).toBe('{broken');

    await fs.writeFile(filePath, JSON.stringify({ version: 2, records: {} }), 'utf8');
    await expect(store.list()).rejects.toMatchObject({ code: 'INVALID_SOURCE_CONTROL_MUTATIONS' });
    await expect(store.claim(claimFor('key-one'))).rejects.toMatchObject({ code: 'INVALID_SOURCE_CONTROL_MUTATIONS' });
    expect(JSON.parse(await fs.readFile(filePath, 'utf8'))).toEqual({ version: 2, records: {} });
  });

  it('uses atomic mode-0600 snapshots and removes temporary files', async () => {
    const { filePath, store } = await makeStore({ now: () => 100 });
    await store.claim(claimFor('key-one'));

    expect((await fs.stat(filePath)).mode & 0o777).toBe(0o600);
    expect((await fs.readdir(path.dirname(filePath))).filter((name) => name.endsWith('.tmp'))).toEqual([]);
    expect(JSON.parse(await fs.readFile(filePath, 'utf8'))).toMatchObject({
      version: 1,
      records: { 'key-one': { key: 'key-one', state: 'running', startedAt: 100, updatedAt: 100 } },
    });
  });

  it('returns exact replays and reports changed-digest conflicts', async () => {
    const { store } = await makeStore({ now: () => 100 });
    const claimed = await store.claim(claimFor('key-one'));

    await expect(store.claim(claimFor('key-one'))).resolves.toEqual({ status: 'existing', record: claimed.record });
    await expect(store.claim(claimFor('key-one', 'different'))).resolves.toEqual({ status: 'conflict', record: claimed.record });
  });

  it.each(['constructor', '__proto__'])('treats the opaque key %s as data', async (key) => {
    const { store } = await makeStore({ now: () => 100 });
    const claimed = await store.claim(claimFor(key));

    expect(claimed.status).toBe('claimed');
    await expect(store.read(key)).resolves.toEqual(claimed.record);
    await expect(store.claim(claimFor(key))).resolves.toEqual({ status: 'existing', record: claimed.record });
  });

  it('serializes concurrent claims so only one caller wins', async () => {
    const { store } = await makeStore({ now: () => 100 });
    const results = await Promise.all([
      store.claim(claimFor('key-one')),
      store.claim(claimFor('key-one')),
      store.claim(claimFor('key-one')),
    ]);

    expect(results.filter(({ status }) => status === 'claimed')).toHaveLength(1);
    expect(results.filter(({ status }) => status === 'existing')).toHaveLength(2);
  });

  it('completes once, accepts an identical no-op, and rejects conflicting rewrites', async () => {
    let timestamp = 100;
    const { store } = await makeStore({ now: () => timestamp, terminalTtlMs: 50 });
    await store.claim(claimFor('key-one'));
    timestamp = 120;
    const completed = await store.complete('key-one', 'digest-key-one', {
      state: 'succeeded',
      result: { number: 12, state: 'open', headSha: 'abc123' },
    });

    expect(completed).toMatchObject({ state: 'succeeded', updatedAt: 120, expiresAt: 170 });
    timestamp = 130;
    await expect(store.complete('key-one', 'digest-key-one', {
      state: 'succeeded',
      result: { number: 12, state: 'open', headSha: 'abc123' },
    })).resolves.toEqual(completed);
    await expect(store.complete('key-one', 'digest-key-one', { state: 'failed' }))
      .rejects.toMatchObject({ code: 'SOURCE_CONTROL_MUTATION_CONFLICT', record: completed });
    await expect(store.complete('key-one', 'different', { state: 'succeeded' }))
      .rejects.toMatchObject({ code: 'SOURCE_CONTROL_MUTATION_CONFLICT', record: completed });
  });

  it('stores only compact failed replay metadata', async () => {
    const { store } = await makeStore({ now: () => 100 });
    await store.claim(claimFor('key-one'));
    await expect(store.complete('key-one', 'digest-key-one', {
      state: 'failed', result: { failureStatus: 422, failureCode: 'INVALID_CHANGE' },
    })).resolves.toMatchObject({
      state: 'failed', result: { failureStatus: 422, failureCode: 'INVALID_CHANGE' },
    });

    await store.claim(claimFor('key-two'));
    await expect(store.complete('key-two', 'digest-key-two', {
      state: 'failed', result: { failureStatus: 399 },
    })).rejects.toMatchObject({ code: 'INVALID_SOURCE_CONTROL_MUTATIONS' });
    await expect(store.complete('key-two', 'digest-key-two', {
      state: 'failed', result: { failureCode: '' },
    })).rejects.toMatchObject({ code: 'INVALID_SOURCE_CONTROL_MUTATIONS' });
    await expect(store.complete('key-two', 'digest-key-two', {
      state: 'failed', result: { message: 'private provider payload' },
    })).rejects.toMatchObject({ code: 'INVALID_SOURCE_CONTROL_MUTATIONS' });
  });

  it('keeps outcome-unknown sticky and protected after its expiry timestamp', async () => {
    let timestamp = 100;
    const { store } = await makeStore({ now: () => timestamp, terminalTtlMs: 10, maxRecords: 2 });
    await store.claim(claimFor('unknown'));
    timestamp = 110;
    const unknown = await store.complete('unknown', 'digest-unknown', { state: 'outcome-unknown' });
    timestamp = 1_000;
    await store.claim(claimFor('other'));

    await expect(store.read('unknown')).resolves.toEqual(unknown);
    await expect(store.complete('unknown', 'digest-unknown', { state: 'succeeded' }))
      .rejects.toMatchObject({ code: 'SOURCE_CONTROL_MUTATION_CONFLICT' });
  });

  it('prunes expired terminal records and evicts oldest terminal records before protected records', async () => {
    let timestamp = 0;
    const { store } = await makeStore({ now: () => timestamp, terminalTtlMs: 25, maxRecords: 3 });
    await store.claim(claimFor('expired'));
    await store.complete('expired', 'digest-expired', { state: 'failed' });
    timestamp = 20;
    await store.claim(claimFor('old-terminal'));
    await store.complete('old-terminal', 'digest-old-terminal', { state: 'succeeded' });
    timestamp = 30;
    await store.claim(claimFor('running'));
    timestamp = 35;
    await store.claim(claimFor('new'));
    timestamp = 40;
    await store.claim(claimFor('newest'));

    await expect(store.read('expired')).resolves.toBeNull();
    await expect(store.read('old-terminal')).resolves.toBeNull();
    await expect(store.read('running')).resolves.toMatchObject({ state: 'running' });
    timestamp = 1_000;
    await expect(store.claim(claimFor('over-capacity'))).rejects.toMatchObject({ code: 'SOURCE_CONTROL_MUTATION_CAPACITY' });
  });

  it('preserves the prior snapshot and cleans the temporary file when rename fails', async () => {
    const { filePath, store } = await makeStore({ now: () => 100 });
    await store.claim(claimFor('key-one'));
    const previous = await fs.readFile(filePath, 'utf8');
    const failingStore = createMutationStore({
      filePath,
      now: () => 120,
      fsImpl: { ...fs, rename: async () => { throw new Error('rename failed'); } },
    });

    await expect(failingStore.complete('key-one', 'digest-key-one', { state: 'failed' })).rejects.toThrow('rename failed');
    expect(await fs.readFile(filePath, 'utf8')).toBe(previous);
    expect((await fs.readdir(path.dirname(filePath))).filter((name) => name.endsWith('.tmp'))).toEqual([]);
  });

  it.each([
    ['title', 'private title'],
    ['body', 'private body'],
    ['comment', 'private comment'],
    ['token', 'secret'],
    ['url', 'https://user:secret@example.com/repo'],
    ['response', { private: true }],
  ])('rejects the unknown or sensitive %s field', async (field, value) => {
    const { filePath, store } = await makeStore({ now: () => 100 });
    await expect(store.claim(claimFor('key-one', 'digest-key-one', { [field]: value })))
      .rejects.toMatchObject({ code: 'INVALID_SOURCE_CONTROL_MUTATIONS' });
    await expect(fs.readFile(filePath, 'utf8')).rejects.toMatchObject({ code: 'ENOENT' });
  });

  it('rejects unknown nested and terminal-result fields', async () => {
    const { filePath, store } = await makeStore({ now: () => 100 });
    const invalid = claimFor('key-one');
    invalid.actor.token = 'secret';
    await expect(store.claim(invalid)).rejects.toMatchObject({ code: 'INVALID_SOURCE_CONTROL_MUTATIONS' });
    await expect(fs.readFile(filePath, 'utf8')).rejects.toMatchObject({ code: 'ENOENT' });

    await store.claim(claimFor('key-two'));
    await expect(store.complete('key-two', 'digest-key-two', { state: 'succeeded', result: { url: 'https://example.com' } }))
      .rejects.toMatchObject({ code: 'INVALID_SOURCE_CONTROL_MUTATIONS' });
  });
});
