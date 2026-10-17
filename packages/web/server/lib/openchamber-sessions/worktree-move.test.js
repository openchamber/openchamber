import { describe, expect, it, vi } from 'vitest';

import { createSessionWorktreeMover } from './worktree-move.js';

const ROOT = '/repo/app';
const SOURCE = '/repo/app';
const WORKTREE = { name: 'fix-login', branch: 'fix-login', path: '/repo/worktrees/fix-login' };
const STASH = { ref: 'stash@{0}', message: 'On main: OpenChamber: session ses_1 moved to worktree fix-login', hash: 'abc123' };

/**
 * A git that records what happened: one stash list shared by every worktree,
 * the way `refs/stash` is, and switches for each step that can fail.
 */
const createMover = ({ changes = true, applyFails = false, moveFails = false, restoreFails = false, removeFails = false, unchanged = [] } = {}) => {
  const stashes = [];
  const calls = [];
  const getPathsWithoutChanges = vi.fn(async () => unchanged);
  const mover = createSessionWorktreeMover({
    getPathsWithoutChanges,
    createWorktree: vi.fn(async (directory, input, options) => {
      calls.push(['createWorktree', directory, input]);
      await options.hydrateCheckout({ directory: WORKTREE.path, parentRemoteName: '' });
      return WORKTREE;
    }),
    removeWorktree: vi.fn(async (directory, input) => {
      calls.push(['removeWorktree', directory, input]);
      if (removeFails) throw new Error('worktree is locked');
    }),
    waitForWorktreeReady: vi.fn(async (directory) => { calls.push(['waitForWorktreeReady', directory]); }),
    hydrateCheckout: vi.fn(async (input) => { calls.push(['hydrateCheckout', input]); }),
    bootstrapStore: { read: vi.fn(), write: vi.fn() },
    // `created` is deliberately wrong here: it is read from git's localized
    // message, so the mover must not trust it.
    stashPush: vi.fn(async (directory, { message, paths }) => {
      calls.push(['stashPush', directory, paths]);
      if (changes) stashes.unshift({ ...STASH, message: `On main: ${message}` });
      return { created: !changes };
    }),
    stashApply: vi.fn(async (directory, { ref }) => {
      calls.push(['stashApply', directory, ref]);
      if (directory === WORKTREE.path && applyFails) throw new Error('CONFLICT (content): src/a.ts');
      if (directory === SOURCE && restoreFails) throw new Error('index locked');
    }),
    stashDrop: vi.fn(async (directory, { ref }) => {
      calls.push(['stashDrop', directory, ref]);
      const index = stashes.findIndex((entry) => entry.ref === ref);
      if (index === -1) throw new Error(`no stash ${ref}`);
      stashes.splice(index, 1);
    }),
    listStashes: vi.fn(async () => stashes.map((entry) => ({ ...entry }))),
    getBranches: vi.fn(async () => ({ all: ['main', 'feature', 'remotes/origin/main'], defaultBranches: { origin: 'main' } })),
    resolvePrimaryWorktreeRoot: vi.fn(async () => ({ root: ROOT })),
    moveSession: vi.fn(async (sessionId, directory) => {
      calls.push(['moveSession', sessionId, directory]);
      if (moveFails) throw new Error('session not found');
    }),
    warn: vi.fn(),
  });
  return { mover, calls, stashes, getPathsWithoutChanges };
};

describe('moving a session into a new worktree', () => {
  it('creates the worktree from the default branch, carries the named files over by stash hash, then moves the session', async () => {
    const { mover, calls, stashes } = createMover();

    const result = await mover.move({ sessionId: 'ses_1', directory: SOURCE, name: 'fix-login', carry: ['src/a.ts', ' src/a.ts ', 'src/b.ts'] });

    expect(result).toEqual({
      sessionId: 'ses_1',
      directory: WORKTREE.path,
      previousDirectory: SOURCE,
      worktree: { ...WORKTREE, startRef: 'main' },
      changesMoved: true,
      carried: ['src/a.ts', 'src/b.ts'],
    });
    expect(calls.map(([step]) => step)).toEqual([
      'createWorktree', 'hydrateCheckout', 'waitForWorktreeReady', 'stashPush', 'stashApply', 'moveSession', 'stashDrop',
    ]);
    expect(calls[0]).toEqual(['createWorktree', ROOT, { mode: 'new', name: 'fix-login', startRef: 'main' }]);
    expect(calls[1][1]).toEqual({ directory: WORKTREE.path, parentDirectory: ROOT, parentRemoteName: '' });
    // Only the named files: everything else uncommitted stays in the checkout.
    expect(calls[3]).toEqual(['stashPush', SOURCE, ['/repo/app/src/a.ts', '/repo/app/src/b.ts']]);
    // Applied by hash: a stash pushed in between would otherwise be the one applied.
    expect(calls[4]).toEqual(['stashApply', WORKTREE.path, STASH.hash]);
    expect(stashes).toEqual([]);
  });

  it('carries nothing and leaves the stash alone when no file is named', async () => {
    const { mover, calls } = createMover();

    const result = await mover.move({ sessionId: 'ses_1', directory: SOURCE, name: 'fix-login' });

    expect(result).toMatchObject({ changesMoved: false, carried: [] });
    expect(calls.map(([step]) => step)).toEqual(['createWorktree', 'hydrateCheckout', 'waitForWorktreeReady', 'moveSession']);
  });

  it('refuses a carry list that is not file paths before creating anything', async () => {
    const { mover, calls } = createMover();

    for (const carry of ['src/a.ts', [''], [42]]) {
      await expect(mover.move({ sessionId: 'ses_1', directory: SOURCE, name: 'fix-login', carry }))
        .rejects.toMatchObject({ statusCode: 400, message: 'carry is a list of file paths' });
    }
    expect(calls).toEqual([]);
  });

  it('handles changes disappearing after validation, whatever git said about the push', async () => {
    const { mover, calls } = createMover({ changes: false });

    const result = await mover.move({ sessionId: 'ses_1', directory: SOURCE, name: 'fix-login', branchName: 'iuliia/fix-login', startRef: 'develop', carry: ['src/a.ts'] });

    expect(result.changesMoved).toBe(false);
    expect(calls[0]).toEqual(['createWorktree', ROOT, { mode: 'new', name: 'fix-login', branchName: 'iuliia/fix-login', startRef: 'develop' }]);
    expect(calls.map(([step]) => step)).toEqual(['createWorktree', 'hydrateCheckout', 'waitForWorktreeReady', 'stashPush', 'moveSession']);
  });

  it('rejects every unchanged or unresolvable carry path before creating a worktree', async () => {
    const { mover, calls, getPathsWithoutChanges } = createMover({ unchanged: ['clean.ts', 'missing.ts', '../outside.ts'] });
    await expect(mover.move({
      sessionId: 'ses_1', directory: '/repo/app/nested', name: 'fix-login',
      carry: ['changed.ts', 'clean.ts', 'missing.ts', '../outside.ts'],
    })).rejects.toMatchObject({
      statusCode: 400,
      message: 'carry paths have no uncommitted changes or cannot be resolved by git: clean.ts, missing.ts, ../outside.ts',
    });
    expect(getPathsWithoutChanges).toHaveBeenCalledWith('/repo/app/nested', ['changed.ts', 'clean.ts', 'missing.ts', '../outside.ts']);
    expect(calls).toEqual([]);
  });

  it('resolves carry paths against a nested session directory for the root-scoped stash', async () => {
    const { mover, calls } = createMover();
    const result = await mover.move({
      sessionId: 'ses_1', directory: '/repo/app/nested', name: 'fix-login',
      carry: ['file.ts', '../sibling.ts', '/repo/app/absolute.ts'],
    });
    expect(calls).toContainEqual(['stashPush', '/repo/app/nested', [
      '/repo/app/nested/file.ts', '/repo/app/sibling.ts', '/repo/app/absolute.ts',
    ]]);
    expect(result.carried).toEqual(['file.ts', '../sibling.ts', '/repo/app/absolute.ts']);
  });

  it('checks out a branch that already exists, and keeps it when the move fails', async () => {
    const { mover, calls } = createMover({ moveFails: true });

    await expect(mover.move({ sessionId: 'ses_1', directory: SOURCE, name: 'feature', existingBranch: 'feature' })).rejects.toThrow('session not found');

    expect(calls[0]).toEqual(['createWorktree', ROOT, { mode: 'existing', name: 'feature', existingBranch: 'feature', setUpstream: true }]);
    expect(calls).toContainEqual(['removeWorktree', ROOT, { directory: WORKTREE.path, deleteLocalBranch: false }]);
  });

  it('checks out a remote branch and removes the local branch it made when the move fails', async () => {
    const { mover, calls } = createMover({ moveFails: true });

    await expect(mover.move({ sessionId: 'ses_1', directory: SOURCE, name: 'review', existingBranch: 'origin/review' })).rejects.toThrow('session not found');

    expect(calls[0]).toEqual(['createWorktree', ROOT, { mode: 'existing', name: 'review', existingBranch: 'origin/review', setUpstream: true }]);
    expect(calls).toContainEqual(['removeWorktree', ROOT, { directory: WORKTREE.path, deleteLocalBranch: true }]);
  });

  it('reports the branch it checked out', async () => {
    const { mover } = createMover({ changes: false });

    const result = await mover.move({ sessionId: 'ses_1', directory: SOURCE, name: 'feature', existingBranch: 'feature' });

    expect(result.worktree).toEqual({ ...WORKTREE, existingBranch: 'feature' });
  });

  it('refuses an existing branch combined with a new branch or a start ref', async () => {
    const { mover, calls } = createMover();

    await expect(mover.move({ sessionId: 'ses_1', directory: SOURCE, name: 'feature', existingBranch: 'feature', startRef: 'main' }))
      .rejects.toMatchObject({ statusCode: 400 });
    await expect(mover.move({ sessionId: 'ses_1', directory: SOURCE, name: 'feature', existingBranch: 'feature', branchName: 'other' }))
      .rejects.toMatchObject({ statusCode: 400 });
    expect(calls).toEqual([]);
  });

  it('removes the worktree and puts the changes back when they do not apply there', async () => {
    const { mover, calls, stashes } = createMover({ applyFails: true });

    await expect(mover.move({ sessionId: 'ses_1', directory: SOURCE, name: 'fix-login', carry: ['src/a.ts'] })).rejects.toMatchObject({
      statusCode: 409,
      message: 'The uncommitted changes do not apply in the new worktree: CONFLICT (content): src/a.ts',
    });

    expect(calls.filter(([step]) => step === 'moveSession')).toEqual([]);
    expect(calls).toContainEqual(['removeWorktree', ROOT, { directory: WORKTREE.path, deleteLocalBranch: true }]);
    expect(calls).toContainEqual(['stashApply', SOURCE, STASH.hash]);
    expect(stashes).toEqual([]);
  });

  it('removes the worktree and puts the changes back when the session cannot be moved', async () => {
    const { mover, calls, stashes } = createMover({ moveFails: true });

    await expect(mover.move({ sessionId: 'ses_1', directory: SOURCE, name: 'fix-login', carry: ['src/a.ts'] })).rejects.toMatchObject({
      message: 'session not found',
    });

    const steps = calls.map(([step]) => step);
    expect(steps.indexOf('removeWorktree')).toBeGreaterThan(steps.indexOf('moveSession'));
    expect(calls).toContainEqual(['stashApply', SOURCE, STASH.hash]);
    expect(stashes).toEqual([]);
  });

  it('keeps the stash and names it when the changes cannot be put back either', async () => {
    const { mover, stashes } = createMover({ moveFails: true, restoreFails: true });

    await expect(mover.move({ sessionId: 'ses_1', directory: SOURCE, name: 'fix-login', carry: ['src/a.ts'] })).rejects.toMatchObject({
      statusCode: 500,
      message: `session not found. The uncommitted changes are kept in git stash ${STASH.hash} (${STASH.message}); restoring them failed: index locked`,
    });

    expect(stashes).toHaveLength(1);
  });

  it('names the stash message when the stash list cannot be read after the push', async () => {
    let listings = 0;
    const failingMover = createSessionWorktreeMover({
      ...Object.fromEntries(['createWorktree', 'removeWorktree', 'waitForWorktreeReady', 'hydrateCheckout', 'stashApply', 'stashDrop', 'moveSession'].map((name) => [name, vi.fn(async () => (name === 'createWorktree' ? WORKTREE : undefined))])),
      bootstrapStore: {},
      getPathsWithoutChanges: vi.fn(async () => []),
      stashPush: vi.fn(async () => ({})),
      listStashes: vi.fn(async () => { listings += 1; if (listings > 1) throw new Error('index.lock exists'); return []; }),
      getBranches: vi.fn(async () => ({ all: ['main'], defaultBranches: {} })),
      resolvePrimaryWorktreeRoot: vi.fn(async () => ({ root: ROOT })),
      warn: vi.fn(),
    });

    await expect(failingMover.move({ sessionId: 'ses_1', directory: SOURCE, name: 'fix-login', carry: ['src/a.ts'] })).rejects.toMatchObject({
      statusCode: 500,
      message: 'The stash list could not be read after stashing the uncommitted changes: index.lock exists. If git stash list shows "OpenChamber: session ses_1 moved to worktree fix-login", the changes are there',
    });
  });

  it('still reports the move failure when the worktree cannot be removed', async () => {
    const { mover, calls } = createMover({ changes: false, moveFails: true, removeFails: true });

    await expect(mover.move({ sessionId: 'ses_1', directory: SOURCE, name: 'fix-login' })).rejects.toMatchObject({ message: 'session not found' });
    expect(calls).toContainEqual(['removeWorktree', ROOT, { directory: WORKTREE.path, deleteLocalBranch: true }]);
  });

  it('refuses a call without a session, a directory, or a worktree name before creating anything', async () => {
    const { mover, calls } = createMover();

    await expect(mover.move({ directory: SOURCE, name: 'x' })).rejects.toMatchObject({ statusCode: 400, message: 'sessionId is required' });
    await expect(mover.move({ sessionId: 'ses_1', name: 'x' })).rejects.toMatchObject({ statusCode: 400, message: 'The session has no directory to move from' });
    await expect(mover.move({ sessionId: 'ses_1', directory: SOURCE })).rejects.toMatchObject({ statusCode: 400, message: 'worktree is required: a short folder name for the task' });
    expect(calls).toEqual([]);
  });
});

describe('the default start ref', () => {
  const resolveWith = async (branches) => {
    const resolver = createSessionWorktreeMover({
      ...Object.fromEntries(['createWorktree', 'removeWorktree', 'waitForWorktreeReady', 'hydrateCheckout', 'stashPush', 'stashApply', 'stashDrop', 'listStashes', 'resolvePrimaryWorktreeRoot', 'moveSession'].map((name) => [name, vi.fn()])),
      bootstrapStore: {},
      getBranches: vi.fn(async () => branches),
    });
    return resolver.resolveDefaultStartRef(ROOT);
  };

  it('prefers the local copy of the remote default branch, then its remote-tracking ref', async () => {
    await expect(resolveWith({ all: ['main', 'remotes/origin/main'], defaultBranches: { origin: 'main' } })).resolves.toBe('main');
    await expect(resolveWith({ all: ['feature', 'remotes/origin/trunk'], defaultBranches: { origin: 'trunk' } })).resolves.toBe('remotes/origin/trunk');
    await expect(resolveWith({ all: ['feature', 'remotes/upstream/dev'], defaultBranches: { upstream: 'dev' } })).resolves.toBe('remotes/upstream/dev');
  });

  it('falls back to a conventional name, then to HEAD', async () => {
    await expect(resolveWith({ all: ['master', 'feature'], defaultBranches: {} })).resolves.toBe('master');
    await expect(resolveWith({ all: ['feature'], defaultBranches: {} })).resolves.toBe('HEAD');
  });
});
