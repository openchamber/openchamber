import { afterEach, describe, expect, test } from 'bun:test';
import type { GitAPI } from '@/lib/api/types';
import { sessionEvents } from '@/lib/sessionEvents';
import { withGitMutationRefreshHints } from './gitMutationHints';

const hints: Array<{ directory: string; paths?: string[] }> = [];
let unsubscribe: (() => void) | null = null;

const listen = () => {
  unsubscribe = sessionEvents.onGitRefreshHint((hint) => hints.push(hint));
};

afterEach(() => {
  unsubscribe?.();
  unsubscribe = null;
  hints.length = 0;
});

const createGitStub = (overrides: Partial<GitAPI> = {}): GitAPI => ({
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
  getGitUnpushedBranchCounts: async () => ({ counts: {} }),
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
  checkoutBranch: async (_directory, branch) => ({ success: true, branch }),
  createBranch: async (_directory, name) => ({ success: true, branch: name }),
  renameBranch: async (_directory, _oldName, newName) => ({ success: true, branch: newName }),
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
  checkoutCommit: async () => ({ success: true }),
  cherryPick: async () => ({ success: true, conflict: false }),
  revertCommit: async () => ({ success: true, conflict: false }),
  resetToCommit: async () => ({ success: true }),
  stash: async () => ({ success: true }),
  stashPop: async () => ({ success: true }),
  getConflictDetails: async () => ({ statusPorcelain: '', unmergedFiles: [], diff: '', headInfo: '', operation: 'merge' }),
  ...overrides,
});

describe('withGitMutationRefreshHints', () => {
  test('emits one hint with the directory after a successful mutation', async () => {
    listen();
    const git = withGitMutationRefreshHints(createGitStub({
      createGitCommit: async () => ({ success: true, commit: 'b'.repeat(40), branch: 'main', summary: { changes: 0, insertions: 0, deletions: 0 } }),
    }));

    await git.createGitCommit('/repo', 'message');

    expect(hints).toEqual([{ directory: '/repo' }]);
  });

  test('does not emit when the mutation rejects', async () => {
    listen();
    const git = withGitMutationRefreshHints(createGitStub({
      gitPush: async () => {
        throw new Error('rejected');
      },
    }));

    await expect(git.gitPush('/repo')).rejects.toThrow('rejected');

    expect(hints).toEqual([]);
  });

  test('leaves read-only methods untouched and optional methods undefined', () => {
    const getGitStatus: GitAPI['getGitStatus'] = async () => ({
      current: 'main',
      tracking: null,
      ahead: 0,
      behind: 0,
      files: [],
      isClean: true,
    });
    const git = withGitMutationRefreshHints(createGitStub({
      getGitStatus,
      createGitTag: undefined,
    }));

    expect(git.getGitStatus).toBe(getGitStatus);
    expect(git.createGitTag).toBe(undefined);
  });
});
