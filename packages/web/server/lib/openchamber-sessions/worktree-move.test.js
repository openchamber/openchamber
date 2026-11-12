import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';

import {
  createWorktree,
  getPathsWithoutChanges,
  listStashes,
  removeWorktree,
  stashApply,
  stashDrop,
  stashPush,
  waitForActiveWorktreeBootstrap,
} from '../git/service.js';
import { createSessionWorktreeMover } from './worktree-move.js';

const ROOT = '/repo/app';
const SOURCE = '/repo/app';
const WORKTREE = { name: 'fix-login', branch: 'fix-login', path: '/repo/worktrees/fix-login' };
const STASH = { ref: 'stash@{0}', message: 'On main: OpenChamber: session ses_1 moved to worktree fix-login', hash: 'abc123' };

/**
 * A git that records what happened: one stash list shared by every worktree,
 * the way `refs/stash` is, and switches for each step that can fail.
 */
const NO_SETUP = { startCommand: '', untrustedSkipped: [] };

const createMover = ({ changes = true, applyFails = false, moveFails = false, restoreFails = false, removeFails = false, unchanged = [], start = null, setup = NO_SETUP, setupStillRunning = false, removal = null } = {}) => {
  const stashes = [];
  const calls = [];
  const getPathsWithoutChanges = vi.fn(async () => unchanged);
  const resolveWorktreeSetup = vi.fn(async () => setup);
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
      await removal?.promise;
    }),
    waitForWorktreeReady: vi.fn(async (directory) => { calls.push(['waitForWorktreeReady', directory]); return { setupStillRunning: setupStillRunning instanceof Function ? setupStillRunning() : setupStillRunning }; }),
    // `start` is the project's folder inside the worktree, where the session starts.
    resolveStartDirectory: vi.fn(async ({ sourceDirectory, worktreeRoot }) => {
      calls.push(['resolveStartDirectory', sourceDirectory, worktreeRoot]);
      return start ? { directory: `${worktreeRoot}/${start.folder}`, fallback: start.fallback ?? null } : { directory: worktreeRoot, fallback: null };
    }),
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
    resolveWorktreeSetup,
    warn: vi.fn(),
  });
  return { mover, calls, stashes, getPathsWithoutChanges, resolveWorktreeSetup };
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
      'createWorktree', 'hydrateCheckout', 'waitForWorktreeReady', 'resolveStartDirectory', 'stashPush', 'stashApply', 'moveSession', 'stashDrop',
    ]);
    expect(calls[0]).toEqual(['createWorktree', ROOT, { mode: 'new', name: 'fix-login', startRef: 'main' }]);
    expect(calls[1][1]).toEqual({ directory: WORKTREE.path, parentDirectory: ROOT, parentRemoteName: '' });
    // Only the named files: everything else uncommitted stays in the checkout.
    expect(calls[4]).toEqual(['stashPush', SOURCE, ['/repo/app/src/a.ts', '/repo/app/src/b.ts']]);
    // Applied by hash: a stash pushed in between would otherwise be the one applied.
    expect(calls[5]).toEqual(['stashApply', WORKTREE.path, STASH.hash]);
    expect(stashes).toEqual([]);
  });

  it('carries nothing and leaves the stash alone when no file is named', async () => {
    const { mover, calls } = createMover();

    const result = await mover.move({ sessionId: 'ses_1', directory: SOURCE, name: 'fix-login' });

    expect(result).toMatchObject({ changesMoved: false, carried: [] });
    expect(calls.map(([step]) => step)).toEqual(['createWorktree', 'hydrateCheckout', 'waitForWorktreeReady', 'resolveStartDirectory', 'moveSession']);
  });

  it('runs the project\'s setup commands in the new worktree before the session moves in', async () => {
    const { mover, calls, resolveWorktreeSetup } = createMover({ setup: { startCommand: 'pnpm install', untrustedSkipped: [] } });

    const result = await mover.move({ sessionId: 'ses_1', directory: SOURCE, name: 'fix-login' });

    expect(resolveWorktreeSetup).toHaveBeenCalledWith(SOURCE);
    expect(calls[0]).toEqual(['createWorktree', ROOT, { mode: 'new', name: 'fix-login', startRef: 'main', startCommand: 'pnpm install' }]);
    // The bootstrap runs the command; the session moves only after it.
    expect(calls.map(([step]) => step)).toEqual(['createWorktree', 'hydrateCheckout', 'waitForWorktreeReady', 'resolveStartDirectory', 'moveSession']);
    expect(result).not.toHaveProperty('untrustedSetupCommandsSkipped');
  });

  it('names the shared setup commands it skipped because nobody trusted them', async () => {
    const { mover, calls } = createMover({ setup: { startCommand: '', untrustedSkipped: ['pnpm install'] } });

    const result = await mover.move({ sessionId: 'ses_1', directory: SOURCE, name: 'fix-login' });

    expect(calls[0]).toEqual(['createWorktree', ROOT, { mode: 'new', name: 'fix-login', startRef: 'main' }]);
    expect(result.untrustedSetupCommandsSkipped).toEqual(['pnpm install']);
  });

  it('moves the session into the project folder inside the worktree while changes still go to the worktree root', async () => {
    const { mover, calls } = createMover({ start: { folder: 'ai' } });

    const result = await mover.move({ sessionId: 'ses_1', directory: SOURCE, name: 'fix-login', carry: ['src/a.ts'] });

    expect(result).toMatchObject({ directory: `${WORKTREE.path}/ai`, worktree: { path: WORKTREE.path } });
    expect(result).not.toHaveProperty('startDirectoryFallback');
    expect(calls).toContainEqual(['resolveStartDirectory', SOURCE, WORKTREE.path]);
    expect(calls).toContainEqual(['stashApply', WORKTREE.path, STASH.hash]);
    expect(calls).toContainEqual(['moveSession', 'ses_1', `${WORKTREE.path}/ai`]);
  });

  it('names why the session did not start in the project folder', async () => {
    const { mover } = createMover({ start: { folder: '', fallback: 'missing' } });

    const result = await mover.move({ sessionId: 'ses_1', directory: SOURCE, name: 'fix-login' });

    expect(result).toMatchObject({ startDirectoryFallback: 'missing' });
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
    expect(calls.map(([step]) => step)).toEqual(['createWorktree', 'hydrateCheckout', 'waitForWorktreeReady', 'resolveStartDirectory', 'stashPush', 'moveSession']);
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
    expect(calls).toContainEqual(['removeWorktree', ROOT, { directory: WORKTREE.path, deleteLocalBranch: false, cancelSetup: true }]);
  });

  it('checks out a remote branch and removes the local branch it made when the move fails', async () => {
    const { mover, calls } = createMover({ moveFails: true });

    await expect(mover.move({ sessionId: 'ses_1', directory: SOURCE, name: 'review', existingBranch: 'origin/review' })).rejects.toThrow('session not found');

    expect(calls[0]).toEqual(['createWorktree', ROOT, { mode: 'existing', name: 'review', existingBranch: 'origin/review', setUpstream: true }]);
    expect(calls).toContainEqual(['removeWorktree', ROOT, { directory: WORKTREE.path, deleteLocalBranch: true, cancelSetup: true }]);
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
    expect(calls).toContainEqual(['removeWorktree', ROOT, { directory: WORKTREE.path, deleteLocalBranch: true, cancelSetup: true }]);
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

  it('puts the changes back without waiting for the cleanup, and answers after it', async () => {
    const removal = Promise.withResolvers();
    const { mover, calls, stashes } = createMover({ moveFails: true, removal });

    const move = mover.move({ sessionId: 'ses_1', directory: SOURCE, name: 'fix-login', carry: ['src/a.ts'] });
    const failure = expect(move).rejects.toMatchObject({ message: 'session not found' });

    await vi.waitFor(() => expect(calls).toContainEqual(['stashApply', SOURCE, STASH.hash]));
    await vi.waitFor(() => expect(stashes).toEqual([]));
    removal.resolve();
    await failure;
  });

  it('moves nothing and keeps the worktree while the setup commands still run', async () => {
    const { mover, calls, stashes } = createMover({ setupStillRunning: true });

    await expect(mover.move({ sessionId: 'ses_1', directory: SOURCE, name: 'fix-login', carry: ['src/a.ts'] })).rejects.toMatchObject({
      statusCode: 503,
      partial: true,
      partialAction: 'worktree-setup-running',
      directory: WORKTREE.path,
    });

    expect(calls.map(([step]) => step)).toEqual(['createWorktree', 'hydrateCheckout', 'waitForWorktreeReady']);
    expect(stashes).toEqual([]);
  });

  it('moves into the worktree it left once its setup finished, instead of making another', async () => {
    let setupRunning = true;
    const { mover, calls } = createMover({ setupStillRunning: () => setupRunning });

    await expect(mover.move({ sessionId: 'ses_1', directory: SOURCE, name: 'fix-login', carry: ['src/a.ts'] })).rejects.toMatchObject({ statusCode: 503 });
    setupRunning = false;
    const moved = await mover.move({ sessionId: 'ses_1', directory: SOURCE, name: 'fix-login', carry: ['src/a.ts'] });

    expect(moved.directory).toBe(WORKTREE.path);
    expect(calls.filter(([step]) => step === 'createWorktree')).toHaveLength(1);
    expect(calls.some(([step]) => step === 'removeWorktree')).toBe(false);
  });

  it('keeps a held-back worktree for the same call only, and a failed retry leaves it in place', async () => {
    let setupRunning = true;
    const { mover, calls } = createMover({ setupStillRunning: () => setupRunning });
    const failingMover = createMover({ setupStillRunning: () => setupRunning, moveFails: true });

    await expect(mover.move({ sessionId: 'ses_1', directory: SOURCE, name: 'fix-login' })).rejects.toMatchObject({ statusCode: 503 });
    setupRunning = false;
    await mover.move({ sessionId: 'ses_2', directory: SOURCE, name: 'fix-login' });
    expect(calls.filter(([step]) => step === 'createWorktree')).toHaveLength(2);

    setupRunning = true;
    await expect(failingMover.mover.move({ sessionId: 'ses_1', directory: SOURCE, name: 'fix-login' })).rejects.toMatchObject({ statusCode: 503 });
    setupRunning = false;
    await expect(failingMover.mover.move({ sessionId: 'ses_1', directory: SOURCE, name: 'fix-login' })).rejects.toThrow('session not found');
    expect(failingMover.calls.filter(([step]) => step === 'createWorktree')).toHaveLength(1);
    expect(failingMover.calls.some(([step]) => step === 'removeWorktree')).toBe(false);
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
      resolveStartDirectory: vi.fn(async ({ worktreeRoot }) => ({ directory: worktreeRoot, fallback: null })),
      ...Object.fromEntries(['createWorktree', 'removeWorktree', 'waitForWorktreeReady', 'hydrateCheckout', 'stashApply', 'stashDrop', 'moveSession'].map((name) => [name, vi.fn(async () => (name === 'createWorktree' ? WORKTREE : { setupStillRunning: false }))])),
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
    expect(calls).toContainEqual(['removeWorktree', ROOT, { directory: WORKTREE.path, deleteLocalBranch: true, cancelSetup: true }]);
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

describe('a setup command that writes a carried file after the wait ended', () => {
  const tempDirs = [];
  const previousDataHome = process.env.XDG_DATA_HOME;

  afterEach(() => {
    if (previousDataHome === undefined) delete process.env.XDG_DATA_HOME;
    else process.env.XDG_DATA_HOME = previousDataHome;
    for (const directory of tempDirs.splice(0)) fs.rmSync(directory, { recursive: true, force: true });
  });

  const tempDir = () => {
    const directory = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'worktree-move-')));
    tempDirs.push(directory);
    return directory;
  };

  const git = (directory, ...args) => execFileSync('git', args, { cwd: directory, encoding: 'utf8' });

  it('leaves the edit, its way back and the session where they were', async () => {
    process.env.XDG_DATA_HOME = tempDir();
    const markers = tempDir();
    const started = path.join(markers, 'started');
    const finish = path.join(markers, 'finish');
    const repo = tempDir();
    git(repo, 'init', '-b', 'main');
    git(repo, 'config', 'user.email', 'test@example.com');
    git(repo, 'config', 'user.name', 'Test User');
    fs.writeFileSync(path.join(repo, 'carried.txt'), 'committed\n');
    git(repo, 'add', '.');
    git(repo, 'commit', '-m', 'Initial commit');
    fs.writeFileSync(path.join(repo, 'carried.txt'), 'the agent edit\n');

    const bootstrapStore = {
      read: vi.fn(async () => null),
      write: vi.fn(async (_directory, state) => state),
      remove: vi.fn(async () => true),
    };
    const moveSession = vi.fn();
    const mover = createSessionWorktreeMover({
      createWorktree: (directory, input, options) => createWorktree(directory, { ...input, returnAfterDirectoryCreated: true }, options),
      removeWorktree,
      waitForWorktreeReady: async () => {
        await vi.waitFor(() => expect(fs.existsSync(started)).toBe(true), { timeout: 10_000 });
        return { setupStillRunning: true };
      },
      resolveStartDirectory: vi.fn(),
      hydrateCheckout: async () => ({ status: 'not-needed', submodules: [], lfs: [] }),
      bootstrapStore,
      stashPush,
      getPathsWithoutChanges,
      stashApply,
      stashDrop,
      listStashes,
      getBranches: async () => ({ all: ['main'], defaultBranches: {} }),
      resolvePrimaryWorktreeRoot: async () => ({ root: repo }),
      moveSession,
      resolveWorktreeSetup: async () => ({
        startCommand: `touch "${started}"; while [ ! -e "${finish}" ]; do sleep 0.02; done; echo setup > carried.txt`,
        untrustedSkipped: [],
      }),
    });

    const refused = await mover.move({ sessionId: 'ses_1', directory: repo, name: 'late-setup', carry: ['carried.txt'] }).catch((error) => error);
    expect(refused).toMatchObject({ partial: true, partialAction: 'worktree-setup-running' });

    fs.writeFileSync(finish, '');
    await waitForActiveWorktreeBootstrap(refused.directory);

    expect(fs.readFileSync(path.join(refused.directory, 'carried.txt'), 'utf8')).toBe('setup\n');
    expect(fs.readFileSync(path.join(repo, 'carried.txt'), 'utf8')).toBe('the agent edit\n');
    expect(await listStashes(repo)).toEqual([]);
    expect(moveSession).not.toHaveBeenCalled();
  }, 30_000);
});
