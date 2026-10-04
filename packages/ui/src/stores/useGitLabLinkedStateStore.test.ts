import { beforeEach, describe, expect, test } from 'bun:test';
import type { GitHubPullRequestRef, GitHubPullRequestSummariesResult } from '@/lib/api/types';
import type { GitLabThreadRef } from '@/lib/linkedIssues';
import { getRuntimeKey } from '@/lib/runtime-switch';
import { useGitLabLinkedStateStore } from './useGitLabLinkedStateStore';

const thread = (instance: string, number: number, kind: 'pull' | 'issue'): GitLabThreadRef => ({
  key: `${instance}/team/app${kind === 'pull' ? '!' : '#'}${number}`, instance, owner: 'team', repo: 'app', number, thread: kind,
});

type Call = { instance: string; refs: GitHubPullRequestRef[]; issueRefs: GitHubPullRequestRef[] };

const api = (answer: (call: Call) => GitHubPullRequestSummariesResult | Error) => {
  const calls: Call[] = [];
  return {
    calls,
    sourceControl: {
      gitlabSummaries: async (instance: string, refs: GitHubPullRequestRef[], issueRefs: GitHubPullRequestRef[] = []) => {
        const call = { instance, refs, issueRefs };
        calls.push(call);
        const result = answer(call);
        if (result instanceof Error) throw result;
        return result;
      },
    },
  };
};

const mergeRequest = (number: number, state: 'open' | 'merged' | 'closed') => ({
  owner: 'team', repo: 'app', number, state, draft: false, title: `MR ${number}`, mergeable: null, mergeableState: null, checks: null,
});

describe('GitLab linked state', () => {
  beforeEach(() => useGitLabLinkedStateStore.getState().resetForRuntimeSwitch());

  test('asks each instance once for its merge requests and issues and stores the answers', async () => {
    const { calls, sourceControl } = api((call) => ({
      connected: true,
      fetchedAt: 1,
      summaries: call.refs.map((ref) => mergeRequest(ref.number, 'open')),
      issueSummaries: call.issueRefs.map((ref) => ({ ...ref, title: 'Issue', state: 'completed' as const })),
    }));
    const refs = [thread('https://gitlab.com', 3, 'pull'), thread('https://gitlab.com', 8, 'issue'), thread('https://git.example', 1, 'pull')];
    await useGitLabLinkedStateStore.getState().sync(refs, sourceControl, 0);

    expect(calls.map((call) => [call.instance, call.refs.length, call.issueRefs.length])).toEqual([
      ['https://gitlab.com', 1, 1],
      ['https://git.example', 1, 0],
    ]);
    const state = useGitLabLinkedStateStore.getState();
    const runtimeKey = getRuntimeKey();
    expect(state.mergeRequests[`${runtimeKey}|${refs[0].key}`]?.state).toBe('open');
    expect(state.issues[`${runtimeKey}|${refs[1].key}`]?.state).toBe('completed');
  });

  test('does not ask about a merged merge request again and keeps state through a failed read', async () => {
    let fail = false;
    const { calls, sourceControl } = api((call) => (fail ? new Error('down') : {
      connected: true, fetchedAt: 1, summaries: call.refs.map((ref) => mergeRequest(ref.number, ref.number === 1 ? 'merged' : 'open')), issueSummaries: [],
    }));
    const merged = thread('https://gitlab.com', 1, 'pull');
    const open = thread('https://gitlab.com', 2, 'pull');
    await useGitLabLinkedStateStore.getState().sync([merged, open], sourceControl, 0);
    fail = true;
    await useGitLabLinkedStateStore.getState().sync([merged, open], sourceControl, 0);

    expect(calls[1].refs.map((ref) => ref.number)).toEqual([2]);
    expect(useGitLabLinkedStateStore.getState().mergeRequests[`${getRuntimeKey()}|${open.key}`]?.state).toBe('open');
  });
});
