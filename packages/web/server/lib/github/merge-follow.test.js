import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { createMergeFollowRuntime, mergeFollowEvents } from './merge-follow.js';
import { trackedItemKey } from '../tracked-items/items.js';

const folders = [];
afterEach(async () => { await Promise.all(folders.splice(0).map((folder) => fs.rm(folder, { recursive: true, force: true }))); });
const item = { provider: 'github', instance: 'github.com', accountId: 'account', kind: 'pull', owner: 'acme', repo: 'app', number: 7 };
const queued = { state: 'open', headSha: 'abc', isInMergeQueue: true, autoMergeRequest: null, checks: { state: 'pending' } };
const mutation = (outcome = 'queued') => ({ context: { provider: 'github', instance: 'github.com', accountId: 'account' }, kind: 'change-request-merge', input: { method: 'merge' }, replayed: false,
  record: { result: { merged: false, outcome }, target: { project: { owner: 'acme', name: 'app' }, number: 7, headSha: 'abc' } } });
const update = (state, at = 200) => [{ key: trackedItemKey(item), item, state, fetchedAt: at, requestedAt: at }];
const service = () => ({ setServerInterest: vi.fn(), refresh: vi.fn(), subscribe: vi.fn(() => () => {}) });

describe('user merge follows', () => {
  it('prioritizes terminal states and reports repeat CI failures only on a new head', () => {
    expect(mergeFollowEvents(queued, { ...queued, state: 'merged', isInMergeQueue: false })).toEqual(['merged']);
    const failed = { ...queued, checks: { state: 'failure' } };
    expect(mergeFollowEvents(failed, failed)).toEqual([]);
    expect(mergeFollowEvents(failed, { ...failed, headSha: 'new' })).toEqual(['checks-failed']);
    expect(mergeFollowEvents(queued, { ...queued, isInMergeQueue: false })).toEqual(['removed']);
  });
  it('survives restart, follows without clients, notifies failure/removal and ends on merge', async () => {
    const dataDir = await fs.mkdtemp(path.join(os.tmpdir(), 'oc-merge-follow-')); folders.push(dataDir);
    let runtime = createMergeFollowRuntime({ dataDir, notify: vi.fn(), now: () => 100 });
    await runtime.attach(service());
    await runtime.onMutationSucceeded(mutation());
    await runtime.stop();
    const notify = vi.fn(); const tracked = service();
    runtime = createMergeFollowRuntime({ dataDir, notify });
    await runtime.attach(tracked);
    expect(tracked.setServerInterest.mock.calls.at(-1)[1].size).toBe(1);
    await runtime.accept(update(null));
    await runtime.accept(update({ ...queued, isInMergeQueue: false }, 99));
    expect(notify).not.toHaveBeenCalled();
    await runtime.accept(update({ ...queued, checks: { state: 'failure' } }));
    await runtime.accept(update({ ...queued, isInMergeQueue: false, checks: { state: 'failure' } }));
    await runtime.accept(update({ ...queued, state: 'merged', isInMergeQueue: false }));
    await runtime.accept(update({ ...queued, state: 'merged' }));
    expect(notify.mock.calls.map(([entry]) => entry.event)).toEqual(['checks-failed', 'removed', 'merged']);
    expect(tracked.setServerInterest.mock.calls.at(-1)[1].size).toBe(0);
    await runtime.stop();
    expect(JSON.parse(await fs.readFile(path.join(dataDir, 'github-merge-follow.json'), 'utf8')).entries).toEqual([]);
  });
  it('does not infer removal from an unknown merging baseline or start from replay', async () => {
    const dataDir = await fs.mkdtemp(path.join(os.tmpdir(), 'oc-merge-follow-')); folders.push(dataDir);
    const notify = vi.fn(); const tracked = service();
    const runtime = createMergeFollowRuntime({ dataDir, notify, now: () => 100 });
    await runtime.attach(tracked);
    await runtime.onMutationSucceeded({ ...mutation(), replayed: true });
    expect(tracked.refresh).toHaveBeenCalledTimes(1);
    await runtime.onMutationSucceeded(mutation('merging'));
    await runtime.accept(update({ ...queued, isInMergeQueue: false }));
    expect(notify).not.toHaveBeenCalled();
    await runtime.accept(update({ ...queued, state: 'closed', isInMergeQueue: false }));
    expect(notify.mock.calls[0][0].event).toBe('closed');
    await runtime.stop();
  });

  it('ends the follow on the user\'s own cancel without a removal notification', async () => {
    const dataDir = await fs.mkdtemp(path.join(os.tmpdir(), 'oc-merge-follow-')); folders.push(dataDir);
    const notify = vi.fn(); const tracked = service();
    const runtime = createMergeFollowRuntime({ dataDir, notify, now: () => 100 });
    await runtime.attach(tracked);
    await runtime.onMutationSucceeded(mutation());
    expect(tracked.setServerInterest.mock.calls.at(-1)[1].size).toBe(1);
    const cancel = mutation('cancelled');
    await runtime.onMutationSucceeded({ ...cancel, input: { method: 'merge', cancel: true } });
    expect(tracked.setServerInterest.mock.calls.at(-1)[1].size).toBe(0);
    await runtime.accept(update({ ...queued, isInMergeQueue: false }));
    expect(notify).not.toHaveBeenCalled();
    await runtime.stop();
  });

  it('stays quiet when a read sees the dequeue while the user\'s cancel is still running', async () => {
    const dataDir = await fs.mkdtemp(path.join(os.tmpdir(), 'oc-merge-follow-')); folders.push(dataDir);
    const notify = vi.fn();
    const runtime = createMergeFollowRuntime({ dataDir, notify, now: () => 100 });
    await runtime.attach(service());
    await runtime.onMutationSucceeded(mutation());
    const cancel = { ...mutation('cancelled'), input: { method: 'merge', cancel: true } };
    const settle = runtime.onMutationStarting({ ...cancel, target: cancel.record.target });
    await runtime.accept(update({ ...queued, isInMergeQueue: false }));
    await runtime.onMutationSucceeded(cancel);
    settle();
    await runtime.accept(update({ ...queued, isInMergeQueue: false, checks: { state: 'failure' } }, 300));
    expect(notify).not.toHaveBeenCalled();
    await runtime.stop();
  });

  it('accepts a merged read that began before the follow started', async () => {
    const dataDir = await fs.mkdtemp(path.join(os.tmpdir(), 'oc-merge-follow-')); folders.push(dataDir);
    const notify = vi.fn(); const tracked = service();
    const runtime = createMergeFollowRuntime({ dataDir, notify, now: () => 100 });
    await runtime.attach(tracked);
    await runtime.onMutationSucceeded(mutation());
    await runtime.accept(update({ ...queued, state: 'merged', isInMergeQueue: false }, 50));
    expect(notify.mock.calls.map(([entry]) => entry.event)).toEqual(['merged']);
    expect(tracked.setServerInterest.mock.calls.at(-1)[1].size).toBe(0);
    await runtime.stop();
  });

  it('remembers the project the merge was started from across a restart and names it with the pull request', async () => {
    const dataDir = await fs.mkdtemp(path.join(os.tmpdir(), 'oc-merge-follow-')); folders.push(dataDir);
    const fromWorktree = { ...mutation(), context: { ...mutation().context, directory: '/work/app-worktrees/fix' } };
    let runtime = createMergeFollowRuntime({ dataDir, notify: vi.fn(), now: () => 100, resolveProjectDirectory: async () => '/work/app' });
    await runtime.attach(service());
    await runtime.onMutationSucceeded(fromWorktree);
    await runtime.stop();
    const notify = vi.fn();
    runtime = createMergeFollowRuntime({ dataDir, notify });
    await runtime.attach(service());
    await runtime.accept(update({ ...queued, state: 'merged', isInMergeQueue: false }));
    expect(notify.mock.calls[0][0]).toMatchObject({ event: 'merged', url: 'https://github.com/acme/app/pull/7', directory: '/work/app' });
    await runtime.stop();
  });

  it('keeps the merge folder when its project cannot be read, and none for a follow saved before folders', async () => {
    const dataDir = await fs.mkdtemp(path.join(os.tmpdir(), 'oc-merge-follow-')); folders.push(dataDir);
    const notify = vi.fn();
    const fromWorktree = { ...mutation(), context: { ...mutation().context, directory: '/work/app-worktrees/fix' } };
    const runtime = createMergeFollowRuntime({ dataDir, notify, now: () => 100, resolveProjectDirectory: async () => { throw new Error('git missing'); } });
    await runtime.attach(service());
    await runtime.onMutationSucceeded(fromWorktree);
    await runtime.accept(update({ ...queued, state: 'closed', isInMergeQueue: false }));
    expect(notify.mock.calls[0][0].directory).toBe('/work/app-worktrees/fix');
    await runtime.stop();

    const older = await fs.mkdtemp(path.join(os.tmpdir(), 'oc-merge-follow-')); folders.push(older);
    await fs.writeFile(path.join(older, 'github-merge-follow.json'), JSON.stringify({ version: 1, entries: [{ item, startedAt: 100, last: queued }] }));
    const notifyOlder = vi.fn();
    const restored = createMergeFollowRuntime({ dataDir: older, notify: notifyOlder });
    await restored.attach(service());
    await restored.accept(update({ ...queued, state: 'merged', isInMergeQueue: false }));
    expect(notifyOlder.mock.calls[0][0]).toMatchObject({ url: 'https://github.com/acme/app/pull/7' });
    expect(notifyOlder.mock.calls[0][0].directory).toBeNull();
    await restored.stop();
  });

  it('keeps a malformed snapshot intact and refuses replacement writes', async () => {
    const dataDir = await fs.mkdtemp(path.join(os.tmpdir(), 'oc-merge-follow-')); folders.push(dataDir);
    const file = path.join(dataDir, 'github-merge-follow.json');
    await fs.writeFile(file, '{broken');
    const warning = vi.spyOn(console, 'warn').mockImplementation(() => {});
    try {
      const runtime = createMergeFollowRuntime({ dataDir, notify: vi.fn() });
      await expect(runtime.attach(service())).rejects.toThrow();
      await expect(runtime.onMutationSucceeded(mutation())).rejects.toThrow();
      expect(await fs.readFile(file, 'utf8')).toBe('{broken');
      await runtime.stop();
    } finally { warning.mockRestore(); }
  });

  it('rolls back a failed start write before registering server interest', async () => {
    const dataDir = await fs.mkdtemp(path.join(os.tmpdir(), 'oc-merge-follow-')); folders.push(dataDir);
    const temporary = path.join(dataDir, `github-merge-follow.json.${process.pid}.tmp`);
    await fs.mkdir(temporary);
    const tracked = service();
    const runtime = createMergeFollowRuntime({ dataDir, notify: vi.fn(), now: () => 100 });
    await runtime.attach(tracked);
    await expect(runtime.onMutationSucceeded(mutation())).rejects.toThrow();
    expect(tracked.setServerInterest.mock.calls.at(-1)[1].size).toBe(0);
    await fs.rm(temporary, { recursive: true });
    await runtime.onMutationSucceeded(mutation());
    expect(tracked.setServerInterest.mock.calls.at(-1)[1].size).toBe(1);
    await runtime.stop();
  });
});
