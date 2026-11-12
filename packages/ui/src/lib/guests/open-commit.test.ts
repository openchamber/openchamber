import { afterEach, describe, expect, test } from 'bun:test';

import type { GitAPI, GitLogEntry, GitLogOptions } from '@/lib/api/types';
import { commitSelectionKey, useCommitSelectionStore } from '@/stores/useCommitSelectionStore';
import { useGitStore } from '@/stores/useGitStore';
import { useUIStore } from '@/stores/useUIStore';
import { openGuestCommit } from './open-commit';

const commit: GitLogEntry = {
  hash: 'abcdef1234567890abcdef1234567890abcdef12', date: '2026-09-24T10:00:00Z', message: 'Fix the graph', refs: '', body: '',
  author_name: 'Ada', author_email: 'ada@example.com', filesChanged: 1, insertions: 2, deletions: 1, parents: [],
};

const fakeGit = (entries: GitLogEntry[], seen: GitLogOptions[] = []): Pick<GitAPI, 'getGitLog'> => ({
  getGitLog: async (_directory: string, options?: GitLogOptions) => {
    if (options) seen.push(options);
    return { all: entries, latest: entries[0] ?? null, total: entries.length };
  },
});
const noBranch = async () => null;

describe('openGuestCommit', () => {
  afterEach(() => { useCommitSelectionStore.setState({ selections: new Map() }); });

  test('reads the commit itself, selects it for the Diff view, and opens commit scope', async () => {
    const seen: GitLogOptions[] = [];
    const result = await openGuestCommit({ sha: 'abcdef1', directory: '/repo', git: fakeGit([commit], seen), supported: true, currentBranch: noBranch });
    expect(result).toEqual({ ok: true });
    expect(seen).toEqual([{ maxCount: 1, to: 'abcdef1' }]);
    const key = commitSelectionKey('/repo', null, useGitStore.getState().runtimeKey);
    expect(useCommitSelectionStore.getState().selections.get(key)?.hash).toBe(commit.hash);
    const tabs = useUIStore.getState().contextPanelByDirectory['/repo']?.tabs ?? [];
    expect(tabs.some((tab) => tab.mode === 'diff' && tab.diffScope === 'commit')).toBe(true);
  });

  test('refuses before touching git when unsupported, malformed, or without a project', async () => {
    const seen: GitLogOptions[] = [];
    const git = fakeGit([commit], seen);
    expect(await openGuestCommit({ sha: 'abcdef1', directory: '/repo', git, supported: false, currentBranch: noBranch })).toMatchObject({ ok: false, code: 'UNSUPPORTED' });
    expect(await openGuestCommit({ sha: '--output=x', directory: '/repo', git, supported: true, currentBranch: noBranch })).toMatchObject({ ok: false, code: 'HOST_REJECTED' });
    expect(await openGuestCommit({ sha: 'abcdef1', directory: null, git, supported: true, currentBranch: noBranch })).toMatchObject({ ok: false, code: 'NO_DIRECTORY' });
    expect(seen).toEqual([]);
  });

  test('a hash git resolves to a different commit is not found', async () => {
    expect(await openGuestCommit({ sha: '1234567', directory: '/repo', git: fakeGit([commit]), supported: true, currentBranch: noBranch }))
      .toMatchObject({ ok: false, code: 'NOT_FOUND' });
    expect(await openGuestCommit({ sha: '1234567', directory: '/repo', git: fakeGit([]), supported: true, currentBranch: noBranch }))
      .toMatchObject({ ok: false, code: 'NOT_FOUND' });
  });
});
