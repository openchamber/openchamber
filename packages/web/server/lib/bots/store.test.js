import fs from 'node:fs/promises';
import path from 'node:path';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { afterEach, expect, it } from 'vitest';
import { createBotStore } from './store.js';
import { createBotItem } from './schema.js';

const directories = [];
afterEach(async () => { await Promise.all(directories.splice(0).map((directory) => fs.rm(directory, { recursive: true, force: true }))); });
const setup = async (options = {}) => {
  const directory = await fs.mkdtemp('/tmp/opencode/bots-store-');
  directories.push(directory);
  return { directory, store: createBotStore({ projectsDirPath: directory, ...options }) };
};
const item = (id) => createBotItem({ id, botId: 'bot', source: { kind: 'manual', id }, title: id });
const add = (store, id) => store.update('p', (snapshot) => ({ snapshot: { ...snapshot, items: [...snapshot.items, item(id)] } }));
const patchItem = (store, id, patch) => store.update('p', (snapshot) => ({ snapshot: { ...snapshot, items: snapshot.items.map((entry) => entry.id === id ? { ...entry, ...patch } : entry) } }));
const effect = () => ({ key: 'open-pr', kind: 'pr.open', inputDigest: 'a'.repeat(64), authority: { service: 'github', identityId: 'account-1', revision: 1, target: 'repo:main' }, state: 'prepared', createdAt: 1, updatedAt: 1 });

it('distinguishes missing, empty, partial corruption, invalid roots and read I/O failure', async () => {
  const { store } = await setup();
  expect(await store.read('p')).toEqual({ revision: 0, items: [] });
  expect(await store.update('p', (snapshot) => ({ snapshot }))).toEqual({ revision: 1, items: [] });
  expect(await store.read('p')).toEqual({ revision: 1, items: [] });
  await add(store, 'a');
  const file = store.filePathFor('p');
  const valid = JSON.parse(await fs.readFile(file, 'utf8'));
  await fs.writeFile(file, JSON.stringify({ ...valid, items: [null, { id: 'broken' }, ...valid.items] }));
  expect((await store.read('p')).items.map((entry) => entry.id)).toEqual(['a']);
  for (const bytes of ['{', '[]', '{}', '{"version":2,"revision":0,"items":[]}']) {
    await fs.writeFile(file, bytes);
    await expect(store.update('p', () => ({ snapshot: { revision: 0, items: [] } }))).rejects.toThrow();
    expect(await fs.readFile(file, 'utf8')).toBe(bytes);
  }
  await fs.rm(file);
  await fs.mkdir(file);
  await expect(store.read('p')).rejects.toThrow();
  for (const id of ['..', '../bad', '/absolute', 'a/b']) await expect(store.read(id)).rejects.toThrow();
});

it('persists legal per-item transitions, sessions and monotonic revisions across restart', async () => {
  const { directory, store } = await setup();
  await add(store, 'a');
  await add(store, 'b');
  const before = (await store.read('p')).items[1];
  for (const state of ['investigating', 'fixing', 'proving', 'judging', 'in-review', 'merging', 'closing', 'done']) {
    await patchItem(store, 'a', { state, sessions: { investigation: 'ses_i', fixing: 'ses_f' }, worktree: '/repo/wt', branch: 'bot/a' });
  }
  const snapshot = await createBotStore({ projectsDirPath: directory }).read('p');
  expect(snapshot.items[0]).toMatchObject({ state: 'done', revision: 9, sessions: { investigation: 'ses_i', fixing: 'ses_f' } });
  expect(snapshot.items[0].transitions.map((entry) => entry.to)).toEqual(['queued', 'investigating', 'fixing', 'proving', 'judging', 'in-review', 'merging', 'closing', 'done']);
  expect(snapshot.items[1]).toEqual(before);
  await expect(patchItem(store, 'a', { state: 'fixing' })).rejects.toThrow('Invalid bot item transition');
  await expect(patchItem(store, 'b', { source: { kind: 'manual', id: 'other' } })).rejects.toThrow('identity is immutable');
  await expect(store.update('p', (current) => ({ snapshot: { ...current, items: [] } }))).rejects.toThrow('Use archive');
  const stale = await store.read('p');
  await patchItem(store, 'b', { state: 'needs-you', wait: { reason: 'Grant required', channel: 'ui', since: 1, people: [] } });
  await expect(store.update('p', () => ({ snapshot: stale }))).rejects.toThrow('Stale bot snapshot');
});

it('serializes independent processes updating the same project', async () => {
  const { directory, store } = await setup();
  const storeUrl = new URL('./store.js', import.meta.url).href;
  const schemaUrl = new URL('./schema.js', import.meta.url).href;
  await Promise.all(['a', 'b', 'c'].map((id) => promisify(execFile)(process.execPath, ['--input-type=module', '-e', `
    import { createBotStore } from ${JSON.stringify(storeUrl)};
    import { createBotItem } from ${JSON.stringify(schemaUrl)};
    const store = createBotStore({ projectsDirPath: ${JSON.stringify(directory)} });
    await store.update('p', async snapshot => {
      await new Promise(resolve => setTimeout(resolve, 30));
      return { snapshot: { ...snapshot, items: [...snapshot.items, createBotItem({ id: '${id}', botId: 'bot', source: { kind: 'manual', id: '${id}' }, title: '${id}' })] } };
    });
  `], { timeout: 15_000 })));
  expect((await store.read('p')).items.map((entry) => entry.id).sort()).toEqual(['a', 'b', 'c']);
  expect((await store.read('p')).revision).toBe(3);
});

it('preserves prior snapshot and cleans temporary files when rename fails', async () => {
  let fail = false;
  const fsImpl = { ...fs, rename: async (...args) => { if (fail) throw new Error('rename denied'); return fs.rename(...args); } };
  const { store } = await setup({ fsImpl });
  await add(store, 'a');
  const bytes = await fs.readFile(store.filePathFor('p'), 'utf8');
  fail = true;
  await expect(add(store, 'b')).rejects.toThrow('rename denied');
  expect(await fs.readFile(store.filePathFor('p'), 'utf8')).toBe(bytes);
  expect((await fs.readdir(path.dirname(store.filePathFor('p')))).filter((name) => name.includes('.tmp-'))).toEqual([]);
});

it('makes effects durable before dispatch and forbids retry, authority drift and receipt changes', async () => {
  const { directory, store } = await setup();
  await add(store, 'a');
  let pending = effect();
  await patchItem(store, 'a', { effects: [pending] });
  const dispatching = { ...pending, state: 'dispatching', owner: { pid: process.pid, host: 'test' } };
  await patchItem(store, 'a', { effects: [dispatching] });
  const restarted = createBotStore({ projectsDirPath: directory });
  expect((await restarted.read('p')).items[0].effects[0].state).toBe('dispatching');
  await expect(patchItem(restarted, 'a', { effects: [pending] })).rejects.toThrow('Invalid bot effect transition');
  await expect(patchItem(restarted, 'a', { effects: [{ ...dispatching, authority: { ...pending.authority, identityId: 'other' } }] })).rejects.toThrow('authority');
  pending = { ...pending, state: 'outcome-unknown', code: 'RESPONSE_LOST' };
  await patchItem(restarted, 'a', { effects: [pending], state: 'needs-you' });
  await expect(patchItem(restarted, 'a', { effects: [] })).rejects.toThrow('cannot be removed');
  const succeeded = { ...effect(), state: 'succeeded', receipt: { id: 'pr-1', url: 'https://example.test/pr/1' } };
  await patchItem(restarted, 'a', { effects: [succeeded] });
  await expect(patchItem(restarted, 'a', { effects: [{ ...succeeded, receipt: { id: 'pr-2' } }] })).rejects.toThrow('Invalid bot effect transition');
  await expect(patchItem(restarted, 'a', { effects: [succeeded, { ...dispatching, key: 'new' }] })).rejects.toThrow('prepared before dispatch');
});

it('recovers append-before-removal crashes, deduplicates archive ids and repairs a torn tail', async () => {
  let fail = false;
  const { directory, store } = await setup({ now: () => 1_700_000_000_000, fsImpl: { ...fs, rename: async (...args) => { if (fail) throw new Error('crash after archive append'); return fs.rename(...args); } } });
  await add(store, 'a');
  await patchItem(store, 'a', { state: 'stopped' });
  fail = true;
  await expect(store.archive('p', { before: 1_700_000_000_001 })).rejects.toThrow('crash after archive append');
  const restarted = createBotStore({ projectsDirPath: directory });
  expect((await restarted.read('p')).items).toEqual([]);
  expect((await restarted.readArchive('p')).map((entry) => entry.id)).toEqual(['a']);
  await restarted.archive('p');
  const archiveFile = path.join(path.dirname(store.filePathFor('p')), 'bots-archive', '2023-11.jsonl');
  const first = await fs.readFile(archiveFile, 'utf8');
  await fs.appendFile(archiveFile, first + '{"version":1,"item":');
  expect(await restarted.readArchive('p', '2023-11')).toHaveLength(1);
  await expect(add(restarted, 'a')).rejects.toThrow('Archived bot item ids');
  await expect(restarted.update('p', (snapshot) => ({ snapshot: { ...snapshot, items: [{ ...item('replacement'), source: { kind: 'manual', id: 'a' } }] } }))).rejects.toThrow('Archived bot item sources');
  await add(restarted, 'b');
  await patchItem(restarted, 'b', { state: 'failed', finishedAt: 1_700_000_000_000 });
  await restarted.archive('p');
  expect((await restarted.readArchive('p')).map((entry) => entry.id)).toEqual(['a', 'b']);
  expect((await fs.readFile(archiveFile, 'utf8')).split('\n').filter(Boolean).every((line) => JSON.parse(line).version === 1)).toBe(true);
  await expect(restarted.readArchive('p', '../bad')).rejects.toThrow();
});

it('keeps unsettled effects visible even on terminal items and never archives active items', async () => {
  const { store } = await setup();
  await add(store, 'a');
  await add(store, 'b');
  await patchItem(store, 'a', { effects: [effect()], state: 'stopped' });
  expect((await store.archive('p', { before: Date.now() + 10_000 })).archived).toEqual([]);
  expect((await store.read('p')).items).toHaveLength(2);
});

it('roundtrips evidence, proof, judgment, human waits and token accounting through resumable stages', async () => {
  const { directory, store } = await setup();
  await add(store, 'a');
  for (const state of ['investigating', 'waiting-answer', 'fixing', 'proving', 'fixing', 'judging', 'waiting-answer', 'judging', 'needs-you', 'in-review']) {
    await patchItem(store, 'a', { state });
  }
  const patch = {
    evidence: [{ source: 'jira', summary: 'Reproduced', url: 'https://example.test/QA-1' }],
    proof: { status: 'passed', testSha: 'test-sha', fixSha: 'fix-sha', command: 'bun', args: ['test'], testExitCode: 1, fixExitCode: 0 },
    judgment: { decision: 'review', reason: 'Human area', headSha: 'fix-sha', baseSha: 'base-sha', policyFingerprint: 'a'.repeat(64), reviewers: ['lead'], questions: [] },
    wait: { reason: 'Review required', since: 1, channel: 'github', people: ['lead'] },
    tokens: { total: 30, byStage: { investigation: 10, fixing: 20, judge: 0 }, byDay: { '2026-10-22': 30 } },
    pr: { number: 1, url: 'https://example.test/pr/1', headSha: 'fix-sha', baseSha: 'base-sha' },
  };
  await patchItem(store, 'a', patch);
  expect((await createBotStore({ projectsDirPath: directory }).read('p')).items[0]).toMatchObject(patch);
  await expect(patchItem(store, 'a', { tokens: { ...patch.tokens, total: 0 } })).rejects.toThrow('cannot decrease');
  await store.update('p', (snapshot) => { snapshot.items[0].title = 'Not committed'; return { result: 'skipped' }; });
  expect((await store.read('p')).items[0].title).toBe('a');
});
