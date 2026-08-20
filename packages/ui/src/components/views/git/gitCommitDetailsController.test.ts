import { describe, expect, test } from 'bun:test';
import type {
  GitAPI,
  GitCommitChangedFile,
  GitCommitFilePreviewResponse,
  GitCommitFilesResponse,
} from '@/lib/api/types';
import {
  createGitCommitDetailsController,
  type GitCommitComparison,
} from './gitCommitDetailsController';

type Deferred<T> = {
  promise: Promise<T>;
  resolve: (value: T) => void;
  reject: (error: Error) => void;
};

const createDeferred = <T>(): Deferred<T> => {
  let resolve!: (value: T) => void;
  let reject!: (error: Error) => void;
  const promise = new Promise<T>((res, rej) => {
    resolve = res;
    reject = rej;
  });
  return { promise, resolve, reject };
};

const flushMicrotasks = async () => {
  await Promise.resolve();
  await Promise.resolve();
};

const COMPARISON: GitCommitComparison = {
  directory: '/repo',
  commitHash: 'a'.repeat(40),
  parentHash: 'b'.repeat(40),
};

const SECOND_COMPARISON: GitCommitComparison = {
  directory: '/repo',
  commitHash: 'c'.repeat(40),
  parentHash: 'd'.repeat(40),
};

const THIRD_COMPARISON: GitCommitComparison = {
  directory: '/repo',
  commitHash: 'e'.repeat(40),
  parentHash: 'f'.repeat(40),
};

const createFile = (overrides: Partial<GitCommitChangedFile> = {}): GitCommitChangedFile => ({
  path: 'src/example.ts',
  status: 'M',
  kind: 'file',
  insertions: 5,
  deletions: 2,
  isBinary: false,
  ...overrides,
});

const createGitStub = (overrides: Partial<GitAPI>): GitAPI => ({
  checkIsGitRepository: async () => true,
  getGitStatus: async () => ({
    current: 'main',
    tracking: null,
    ahead: 0,
    behind: 0,
    files: [],
    isClean: true,
  }),
  getGitDiff: async () => ({ diff: '' }),
  getGitFileDiff: async (_directory, options) => ({ original: '', modified: '', path: options.path }),
  revertGitFile: async () => {},
  stageGitFile: async () => {},
  unstageGitFile: async () => {},
  isLinkedWorktree: async () => false,
  getGitBranches: async () => ({ all: ['main'], current: 'main', branches: {} }),
  deleteGitBranch: async () => ({ success: true }),
  deleteRemoteBranch: async () => ({ success: true }),
  removeRemote: async () => ({ success: true }),
  generateCommitMessage: async () => ({ message: { subject: 'subject', highlights: [] } }),
  generatePullRequestDescription: async () => ({ title: 'title', body: 'body' }),
  listGitWorktrees: async () => [],
  createGitCommit: async () => ({ success: true, commit: 'a'.repeat(40), branch: 'main', summary: { changes: 0, insertions: 0, deletions: 0 } }),
  gitPush: async () => ({ success: true, pushed: [], repo: '/repo', ref: null }),
  gitPull: async () => ({ success: true, summary: { changes: 0, insertions: 0, deletions: 0 }, files: [], insertions: 0, deletions: 0 }),
  gitFetch: async () => ({ success: true }),
  listGitStashes: async () => ({ stashes: [] }),
  countGitStashFiles: async () => ({ counts: {} }),
  stashGitChanges: async () => ({ success: true, created: false, message: '', output: '' }),
  applyGitStash: async (_directory, { ref }) => ({ success: true, ref }),
  popGitStash: async (_directory, { ref }) => ({ success: true, ref }),
  dropGitStash: async (_directory, { ref }) => ({ success: true, ref }),
  checkoutBranch: async (directory, branch) => ({ success: true, branch }),
  createBranch: async (directory, name) => ({ success: true, branch: name }),
  renameBranch: async (directory, oldName, newName) => ({ success: true, branch: newName }),
  getGitLog: async () => ({ all: [], latest: null, total: 0 }),
  getCommitFiles: async () => ({ files: [] }),
  getCurrentGitIdentity: async () => null,
  setGitIdentity: async () => ({ success: true, profile: { id: '1', name: 'Ada', userName: 'Ada', userEmail: 'ada@example.com' } }),
  getGitIdentities: async () => [],
  createGitIdentity: async (profile) => profile,
  updateGitIdentity: async (_id, updates) => updates,
  deleteGitIdentity: async () => {},
  getRemotes: async () => [],
  rebase: async () => ({ success: true, conflict: false }),
  abortRebase: async () => ({ success: true }),
  continueRebase: async () => ({ success: true, conflict: false }),
  merge: async () => ({ success: true, conflict: false }),
  abortMerge: async () => ({ success: true }),
  continueMerge: async () => ({ success: true, conflict: false }),
  checkoutCommit: async () => ({ success: true, detached: true }),
  cherryPick: async () => ({ success: true, conflict: false }),
  revertCommit: async () => ({ success: true, conflict: false }),
  resetToCommit: async () => ({ success: true }),
  stash: async () => ({ success: true }),
  stashPop: async () => ({ success: true }),
  getConflictDetails: async () => ({ statusPorcelain: '', unmergedFiles: [], diff: '', headInfo: '', operation: 'merge' }),
  ...overrides,
});

type IdleScheduler = {
  scheduleIdle: (callback: () => void) => () => void;
  runAll: () => void;
  scheduledCount: () => number;
};

const createIdleScheduler = (): IdleScheduler => {
  const callbacks: Array<() => void> = [];
  return {
    scheduleIdle(callback) {
      callbacks.push(callback);
      return () => {
        const index = callbacks.indexOf(callback);
        if (index >= 0) {
          callbacks.splice(index, 1);
        }
      };
    },
    runAll() {
      while (callbacks.length > 0) {
        const callback = callbacks.shift();
        callback?.();
      }
    },
    scheduledCount() {
      return callbacks.length;
    },
  };
};

describe('createGitCommitDetailsController', () => {
  test('loads metadata lazily, dedupes repeated expansion, and distinguishes empty from error retries', async () => {
    const firstRequest = createDeferred<GitCommitFilesResponse>();
    const secondRequest = createDeferred<GitCommitFilesResponse>();
    const metadataRequests: Array<Deferred<GitCommitFilesResponse>> = [firstRequest, secondRequest];
    let loadMetadataCalls = 0;
    const idleScheduler = createIdleScheduler();
    const git = createGitStub({
      getCommitFiles: async () => {
        const request = metadataRequests[loadMetadataCalls];
        loadMetadataCalls += 1;
        return request.promise;
      },
    });

    const controller = createGitCommitDetailsController({
      directory: '/repo',
      git,
      scheduleIdle: idleScheduler.scheduleIdle,
    });

    const idleSnapshot = controller.getCommitSnapshot(COMPARISON);
    expect(idleSnapshot).toBe(controller.getCommitSnapshot(COMPARISON));
    expect(loadMetadataCalls).toBe(0);

    controller.toggleExpanded(COMPARISON);
    expect(controller.getCommitSnapshot(COMPARISON).status).toBe('loading');
    expect(loadMetadataCalls).toBe(1);

    controller.toggleExpanded(COMPARISON);
    controller.toggleExpanded(COMPARISON);
    expect(loadMetadataCalls).toBe(1);

    firstRequest.resolve({ files: [] });
    await flushMicrotasks();

    const emptySnapshot = controller.getCommitSnapshot(COMPARISON);
    expect(emptySnapshot).toEqual({ status: 'empty' });
    expect(emptySnapshot).toBe(controller.getCommitSnapshot(COMPARISON));

    controller.retryCommit(COMPARISON);
    expect(controller.getCommitSnapshot(COMPARISON).status).toBe('loading');
    expect(loadMetadataCalls).toBe(2);

    secondRequest.reject(new Error('offline'));
    await flushMicrotasks();

    const failedCommitSnapshot = controller.getCommitSnapshot(COMPARISON);
    expect(failedCommitSnapshot.status).toBe('error');
    if (failedCommitSnapshot.status === 'error') {
      expect(failedCommitSnapshot.retryCount).toBe(1);
      expect(failedCommitSnapshot.error.message).toBe('offline');
    }

    controller.toggleExpanded(COMPARISON);
    controller.toggleExpanded(COMPARISON);
    expect(loadMetadataCalls).toBe(2);
  });

  test('limits metadata work to two concurrent commits and drains queued work in order', async () => {
    const first = createDeferred<GitCommitFilesResponse>();
    const second = createDeferred<GitCommitFilesResponse>();
    const third = createDeferred<GitCommitFilesResponse>();
    const requests = [first, second, third];
    const seen: string[] = [];
    let callIndex = 0;
    const controller = createGitCommitDetailsController({
      directory: '/repo',
      git: createGitStub({
        getCommitFiles: async (_directory, request) => {
          seen.push(request.commitHash);
          const current = requests[callIndex];
          callIndex += 1;
          return current.promise;
        },
      }),
      scheduleIdle: createIdleScheduler().scheduleIdle,
    });

    controller.toggleExpanded(COMPARISON);
    controller.toggleExpanded(SECOND_COMPARISON);
    controller.toggleExpanded(THIRD_COMPARISON);

    expect(seen).toEqual([COMPARISON.commitHash, SECOND_COMPARISON.commitHash]);
    expect(controller.getCommitSnapshot(THIRD_COMPARISON).status).toBe('loading');

    first.resolve({ files: [createFile({ path: 'src/first.ts' })] });
    await flushMicrotasks();
    expect(seen).toEqual([COMPARISON.commitHash, SECOND_COMPARISON.commitHash, THIRD_COMPARISON.commitHash]);

    second.resolve({ files: [createFile({ path: 'src/second.ts' })] });
    third.resolve({ files: [createFile({ path: 'src/third.ts' })] });
    await flushMicrotasks();

    expect(controller.getCommitSnapshot(COMPARISON).status).toBe('ready');
    expect(controller.getCommitSnapshot(SECOND_COMPARISON).status).toBe('ready');
    expect(controller.getCommitSnapshot(THIRD_COMPARISON).status).toBe('ready');
  });

  test('defers metadata eviction, preserves protected entries, and trims unprotected entries to 32', async () => {
    const idleScheduler = createIdleScheduler();
    const controller = createGitCommitDetailsController({
      directory: '/repo',
      git: createGitStub({
        getCommitFiles: async (_directory, request) => ({
          files: [createFile({ path: `${request.commitHash}.ts` })],
        }),
      }),
      scheduleIdle: idleScheduler.scheduleIdle,
    });

    const protectedKey: GitCommitComparison = {
      directory: '/repo',
      commitHash: '0'.repeat(40),
      parentHash: '1'.repeat(40),
    };
    const transientKeys: GitCommitComparison[] = [];

    const unsubscribe = controller.subscribeCommit(protectedKey, () => {});
    controller.toggleExpanded(protectedKey);
    for (let index = 0; index < 33; index += 1) {
      const key: GitCommitComparison = {
        directory: '/repo',
        commitHash: index.toString(16).padStart(40, '0'),
        parentHash: 'f'.repeat(40),
      };
      transientKeys.push(key);
      controller.toggleExpanded(key);
    }
    await flushMicrotasks();
    for (const key of transientKeys) {
      controller.toggleExpanded(key);
    }

    expect(idleScheduler.scheduledCount()).toBeGreaterThan(0);
    idleScheduler.runAll();

    expect(controller.getCommitSnapshot(protectedKey).status).toBe('ready');
    expect(controller.getCommitSnapshot({
      directory: '/repo',
      commitHash: '1'.padStart(40, '0'),
      parentHash: 'f'.repeat(40),
    }).status).toBe('idle');

    unsubscribe();
  });

  test('returns stable snapshot identities for unchanged commit and preview state', async () => {
    const controller = createGitCommitDetailsController({
      directory: '/repo',
      git: createGitStub({
        getCommitFiles: async () => ({ files: [createFile()] }),
        getCommitFileDiff: async () => ({ status: 'ready', original: 'a', modified: 'b' }),
      }),
      scheduleIdle: createIdleScheduler().scheduleIdle,
    });

    const firstCommitSnapshot = controller.getCommitSnapshot(COMPARISON);
    const firstPreviewSnapshot = controller.getPreviewSnapshot();
    expect(firstCommitSnapshot).toBe(controller.getCommitSnapshot(COMPARISON));
    expect(firstPreviewSnapshot).toBe(controller.getPreviewSnapshot());

    controller.toggleExpanded(SECOND_COMPARISON);
    await flushMicrotasks();

    expect(firstCommitSnapshot).toBe(controller.getCommitSnapshot(COMPARISON));
    expect(firstPreviewSnapshot).toBe(controller.getPreviewSnapshot());
  });

  test('treats gitlinks as gitlinks before binary previews and waits for large-preview confirmation', async () => {
    let previewCalls = 0;
    const controller = createGitCommitDetailsController({
      directory: '/repo',
      git: createGitStub({
        getCommitFileDiff: async () => {
          previewCalls += 1;
          return { status: 'ready', original: 'old', modified: 'new' };
        },
      }),
      scheduleIdle: createIdleScheduler().scheduleIdle,
    });

    controller.selectFile(COMPARISON, createFile({ isBinary: true, path: 'bin.dat' }));
    expect(controller.getPreviewSnapshot().status).toBe('binary');

    controller.selectFile(COMPARISON, createFile({ kind: 'gitlink', isBinary: true, objectId: 'a'.repeat(40), originalObjectId: 'b'.repeat(40), path: 'submodule' }));
    const gitlinkSnapshot = controller.getPreviewSnapshot();
    expect(gitlinkSnapshot.status).toBe('gitlink');
    if (gitlinkSnapshot.status === 'gitlink') {
      expect(gitlinkSnapshot.objectId).toBe('a'.repeat(40));
      expect(gitlinkSnapshot.originalObjectId).toBe('b'.repeat(40));
    }

    const largeFile = createFile({ path: 'src/large.ts', insertions: 400, deletions: 200 });
    controller.selectFile(COMPARISON, largeFile);
    const largePreviewSnapshot = controller.getPreviewSnapshot();
    expect(largePreviewSnapshot.status).toBe('confirm-large');
    if (largePreviewSnapshot.status === 'confirm-large') {
      expect(largePreviewSnapshot.file).toEqual(largeFile);
      expect(largePreviewSnapshot.changedLines).toBe(600);
    }
    expect(previewCalls).toBe(0);

    controller.confirmLargePreview();
    await flushMicrotasks();
    expect(previewCalls).toBe(1);
    expect(controller.getPreviewSnapshot().status).toBe('ready');
  });

  test('serializes preview work, coalesces queued selections to the latest file, and preserves same-key stale responses', async () => {
    const first = createDeferred<GitCommitFilePreviewResponse>();
    const second = createDeferred<GitCommitFilePreviewResponse>();
    const third = createDeferred<GitCommitFilePreviewResponse>();
    const requests = [first, second, third];
    const seenPaths: Array<string | null> = [];
    let callIndex = 0;
    const controller = createGitCommitDetailsController({
      directory: '/repo',
      git: createGitStub({
        getCommitFileDiff: async (_directory, request) => {
          seenPaths.push(request.modifiedPath);
          const current = requests[callIndex];
          callIndex += 1;
          return current.promise;
        },
      }),
      scheduleIdle: createIdleScheduler().scheduleIdle,
    });

    const firstFile = createFile({ path: 'src/first.ts' });
    const secondFile = createFile({ path: 'src/second.ts' });
    const thirdFile = createFile({ path: 'src/third.ts' });

    controller.selectFile(COMPARISON, firstFile);
    controller.selectFile(COMPARISON, secondFile);
    controller.selectFile(COMPARISON, thirdFile);
    expect(seenPaths).toEqual(['src/first.ts']);

    first.resolve({ status: 'ready', original: 'old first', modified: 'new first' });
    await flushMicrotasks();
    expect(seenPaths).toEqual(['src/first.ts', 'src/third.ts']);
    const queuedPreviewSnapshot = controller.getPreviewSnapshot();
    expect(queuedPreviewSnapshot.status).toBe('loading');
    if (queuedPreviewSnapshot.status === 'loading') {
      expect(queuedPreviewSnapshot.file).toEqual(thirdFile);
    }

    controller.clearSelection();
    controller.selectFile(COMPARISON, thirdFile);

    second.resolve({ status: 'ready', original: 'stale old', modified: 'stale new' });
    await flushMicrotasks();

    expect(seenPaths).toEqual(['src/first.ts', 'src/third.ts', 'src/third.ts']);
    const refreshedPreviewSnapshot = controller.getPreviewSnapshot();
    expect(refreshedPreviewSnapshot.status).toBe('loading');
    if (refreshedPreviewSnapshot.status === 'loading') {
      expect(refreshedPreviewSnapshot.file).toEqual(thirdFile);
    }

    third.resolve({ status: 'ready', original: 'fresh old', modified: 'fresh new' });
    await flushMicrotasks();

    const finalPreviewSnapshot = controller.getPreviewSnapshot();
    expect(finalPreviewSnapshot.status).toBe('ready');
    if (finalPreviewSnapshot.status === 'ready') {
      expect(finalPreviewSnapshot.file).toEqual(thirdFile);
      expect(finalPreviewSnapshot.original).toBe('fresh old');
      expect(finalPreviewSnapshot.modified).toBe('fresh new');
    }
  });

  test('retries preview errors manually and trims UTF-16 preview cache bytes without retaining oversized results', async () => {
    const filesByPath = new Map<string, GitCommitChangedFile>();
    const calls: string[] = [];
    const idleScheduler = createIdleScheduler();
    const utf16PreviewText = 'u'.repeat(1_500_000);
    const controller = createGitCommitDetailsController({
      directory: '/repo',
      git: createGitStub({
        getCommitFileDiff: async (_directory, request) => {
          const path = request.modifiedPath ?? request.originalPath ?? '';
          calls.push(path);
          if (path === 'src/error.ts') {
            if (calls.filter((callPath) => callPath === path).length === 1) {
              throw new Error('preview offline');
            }
            return { status: 'ready', original: 'retry old', modified: 'retry new' };
          }
          if (path === 'src/too-large.ts') {
            return { status: 'too-large', totalBytes: 9 * 1024 * 1024, maxBytes: 8 * 1024 * 1024 };
          }
          if (path.startsWith('src/utf16-')) {
            return {
              status: 'ready',
              original: utf16PreviewText,
              modified: utf16PreviewText,
            };
          }
          return {
            status: 'ready',
            original: 'o'.repeat(path.startsWith('src/big') ? 4 * 1024 * 1024 : 1),
            modified: 'm'.repeat(path.startsWith('src/big') ? 4 * 1024 * 1024 : 1),
          };
        },
      }),
      scheduleIdle: idleScheduler.scheduleIdle,
    });

    const errorFile = createFile({ path: 'src/error.ts' });
    filesByPath.set(errorFile.path, errorFile);
    controller.selectFile(COMPARISON, errorFile);
    await flushMicrotasks();
    const previewErrorSnapshot = controller.getPreviewSnapshot();
    expect(previewErrorSnapshot.status).toBe('error');
    if (previewErrorSnapshot.status === 'error') {
      expect(previewErrorSnapshot.retryCount).toBe(1);
      expect(previewErrorSnapshot.error.message).toBe('preview offline');
    }

    controller.retryPreview();
    await flushMicrotasks();
    const retriedPreviewSnapshot = controller.getPreviewSnapshot();
    expect(retriedPreviewSnapshot.status).toBe('ready');
    if (retriedPreviewSnapshot.status === 'ready') {
      expect(retriedPreviewSnapshot.modified).toBe('retry new');
    }

    for (let index = 0; index < 12; index += 1) {
      const file = createFile({ path: `src/small-${index}.ts` });
      filesByPath.set(file.path, file);
      controller.selectFile(COMPARISON, file);
      await flushMicrotasks();
    }

    controller.selectFile(COMPARISON, createFile({ path: 'src/small-0.ts' }));
    await flushMicrotasks();
    const callCountAfterCachedRead = calls.filter((path) => path === 'src/small-0.ts').length;
    expect(callCountAfterCachedRead).toBe(1);

    const utf16One = createFile({ path: 'src/utf16-one.ts' });
    const utf16Two = createFile({ path: 'src/utf16-two.ts' });
    controller.selectFile(COMPARISON, utf16One);
    await flushMicrotasks();
    controller.selectFile(COMPARISON, utf16Two);
    await flushMicrotasks();
    idleScheduler.runAll();
    controller.selectFile(COMPARISON, createFile({ path: 'src/utf16-one.ts' }));
    await flushMicrotasks();
    expect(calls.filter((path) => path === 'src/utf16-one.ts').length).toBe(2);
    expect(calls.filter((path) => path === 'src/utf16-two.ts').length).toBe(1);

    controller.selectFile(COMPARISON, createFile({ path: 'src/too-large.ts' }));
    await flushMicrotasks();
    expect(controller.getPreviewSnapshot().status).toBe('too-large');
    controller.clearSelection();
    controller.selectFile(COMPARISON, createFile({ path: 'src/too-large.ts' }));
    await flushMicrotasks();
    expect(calls.filter((path) => path === 'src/too-large.ts').length).toBe(2);
  });

  test('stops notifications and ignores settled work after disposal', async () => {
    const deferred = createDeferred<GitCommitFilesResponse>();
    let notifications = 0;
    const controller = createGitCommitDetailsController({
      directory: '/repo',
      git: createGitStub({
        getCommitFiles: async () => deferred.promise,
      }),
      scheduleIdle: createIdleScheduler().scheduleIdle,
    });

    controller.subscribeCommit(COMPARISON, () => {
      notifications += 1;
    });

    controller.toggleExpanded(COMPARISON);
    controller.dispose();
    deferred.resolve({ files: [createFile()] });
    await flushMicrotasks();

    expect(notifications).toBe(1);
    expect(controller.getCommitSnapshot(COMPARISON).status).toBe('idle');
    expect(controller.getPreviewSnapshot().status).toBe('idle');
  });
});
