import { expect, test } from 'bun:test';
import { PullRequestSnapshotCache } from './pullRequestSnapshotCache';
import type { PullRequestSource } from './pullRequestDiff';

const source: PullRequestSource = { kind: 'pr', number: 42 };
const snapshot = [{ path: 'a.ts', previousPath: undefined, status: 'M', insertions: 1, deletions: 1, patch: 'published' }];

test('returning to a PR reuses its snapshot, while explicit refresh fetches again', async () => {
  const cache = new PullRequestSnapshotCache();
  let calls = 0;
  const fetch = async () => { calls += 1; return snapshot; };
  const first = cache.load('runtime/repo', source, fetch);
  expect(cache.load('runtime/repo', source, fetch)).toBe(first);
  expect(cache.load('runtime/repo', source, fetch, true)).toBe(first);
  await first;
  await cache.load('runtime/repo', { kind: 'pr', number: 43 }, fetch);
  expect(await cache.load('runtime/repo', source, fetch)).toBe(snapshot);
  expect(calls).toBe(2);
  await cache.load('runtime/repo', source, fetch, true);
  expect(calls).toBe(3);
  await cache.load('other-runtime/repo', source, fetch);
  expect(calls).toBe(4);
});

test('push invalidates only its scope and an older response cannot repopulate it', async () => {
  const cache = new PullRequestSnapshotCache();
  let resolveOld: (value: typeof snapshot) => void = () => {};
  const old = cache.load('runtime/repo', source, () => new Promise((resolve) => { resolveOld = resolve; }));
  const other = cache.load('runtime/other', source, async () => snapshot);
  await other;
  cache.invalidate('runtime/repo');
  const newer = [{ ...snapshot[0], patch: 'newer' }];
  await cache.load('runtime/repo', source, async () => newer);
  resolveOld(snapshot);
  await old;
  expect(await cache.load('runtime/repo', source, async () => { throw new Error('Unexpected fetch'); })).toBe(newer);
  expect(cache.load('runtime/other', source, async () => { throw new Error('Unexpected fetch'); })).toBe(other);
});

test('failed reads can be retried and successful empty snapshots remain cached', async () => {
  const cache = new PullRequestSnapshotCache();
  await expect(cache.load('repo', source, async () => { throw new Error('offline'); })).rejects.toThrow('offline');
  expect(await cache.load('repo', source, async () => [])).toEqual([]);
  expect(await cache.load('repo', source, async () => { throw new Error('Unexpected fetch'); })).toEqual([]);
});

test('bounds completed snapshots without evicting an in-flight request', async () => {
  const cache = new PullRequestSnapshotCache();
  let resolvePending: (value: typeof snapshot) => void = () => {};
  const pending = cache.load('repo', source, () => new Promise((resolve) => { resolvePending = resolve; }));
  for (let number = 1; number <= 9; number += 1) {
    await cache.load('repo', { kind: 'pr', number }, async () => snapshot);
  }
  expect(cache.load('repo', source, async () => { throw new Error('Unexpected fetch'); })).toBe(pending);
  let refetches = 0;
  await cache.load('repo', { kind: 'pr', number: 1 }, async () => { refetches += 1; return snapshot; });
  expect(refetches).toBe(1);
  resolvePending(snapshot);
  await pending;
});
