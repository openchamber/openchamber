import { afterEach, beforeEach, describe, expect, mock, test } from 'bun:test';
import type {
  GiteaAPI,
  GiteaComment,
  GiteaIssue,
  GiteaPullRequest,
  GiteaUserSummary,
  GitHubAPI,
  GitHubCheckRun,
  GitHubChecksSummary,
  GitHubIssue,
  GitHubIssueComment,
  GitHubPullRequestSummary,
  GitHubUserSummary,
  GitLabAPI,
  GitLabIssue,
  GitLabIssueComment,
  GitLabMergeRequest,
  GitLabUserSummary,
} from '@/lib/api/types';
import { buildForgeProvider, createGitlabForgeProvider } from '@/lib/forge/adapters';
import {
  mapCheckRunState,
  mapGithubCheckSummary,
  mapGithubContext,
  mapGithubIssue,
  mapGithubIssueComment,
  mapGithubPr,
  mapGithubReviewComment,
  mapGiteaComment,
  mapGiteaContext,
  mapGiteaIssue,
  mapGiteaPr,
  mapGitlabContext,
  mapGitlabIssue,
  mapGitlabMr,
  mapGitlabNoteComment,
  stateOf,
} from '@/lib/forge/normalize';

// ---------------------------------------------------------------------------
// Fixtures
// ---------------------------------------------------------------------------

const githubUser = (): GitHubUserSummary => ({
  login: 'octocat',
  id: 1,
  name: 'Octo Cat',
  avatarUrl: 'https://avatars.example/octocat',
});

const githubPr: GitHubPullRequestSummary = {
  number: 42,
  title: 'Add forge facade',
  body: 'A body',
  url: 'https://github.com/acme/widget/pull/42',
  state: 'open',
  draft: true,
  base: 'main',
  head: 'feat/forge',
  headSha: 'abc123',
  mergeable: true,
  mergeableState: 'clean',
  author: githubUser(),
  createdAt: '2026-01-02T03:04:05Z',
  updatedAt: '2026-01-03T04:05:06Z',
};

const githubIssue: GitHubIssue = {
  number: 7,
  title: 'Bug in forge',
  body: 'Details',
  url: 'https://github.com/acme/widget/issues/7',
  state: 'closed',
  author: githubUser(),
  labels: [{ name: 'bug', color: 'd73a4a' }],
  assignees: [githubUser()],
  createdAt: '2026-01-02T03:04:05Z',
  updatedAt: '2026-01-04T05:06:07Z',
};

const githubIssueComment: GitHubIssueComment = {
  id: 1001,
  body: 'First!',
  url: 'https://github.com/acme/widget/issues/7#issuecomment-1001',
  author: githubUser(),
  createdAt: '2026-01-02T04:00:00Z',
};

const gitlabUser = (): GitLabUserSummary => ({
  username: 'gluser',
  id: 5,
  name: 'GL User',
  avatarUrl: 'https://avatars.example/gluser',
  webUrl: 'https://gitlab.example/gluser',
});

const gitlabMr: GitLabMergeRequest = {
  number: 99,
  title: 'Draft: Add MR support',
  body: 'MR body',
  url: 'https://gitlab.example/acme/widget/-/merge_requests/99',
  state: 'opened',
  draft: false,
  author: gitlabUser(),
  sourceBranch: 'feat/mr',
  targetBranch: 'main',
  createdAt: '2026-02-01T00:00:00Z',
  updatedAt: '2026-02-02T00:00:00Z',
  headSha: 'def456',
};

const gitlabIssue: GitLabIssue = {
  number: 8,
  title: 'GL issue',
  body: 'GL body',
  url: 'https://gitlab.example/acme/widget/-/issues/8',
  state: 'opened',
  author: gitlabUser(),
  assignees: [gitlabUser()],
  labels: ['frontend', 'bug'],
  createdAt: '2026-02-01T00:00:00Z',
  updatedAt: '2026-02-03T00:00:00Z',
};

const gitlabNote: GitLabIssueComment = {
  id: 3003,
  body: 'a note',
  url: 'https://gitlab.example/acme/widget/-/issues/8#note_3003',
  author: gitlabUser(),
  createdAt: '2026-02-01T01:00:00Z',
};

const giteaUser = (): GiteaUserSummary => ({
  username: 'guser',
  id: 3,
  name: 'G User',
  avatarUrl: 'https://avatars.example/guser',
  webUrl: 'https://gitea.example/guser',
});

const giteaPr: GiteaPullRequest = {
  number: 11,
  title: 'Add gitea PR',
  body: 'gitea body',
  url: 'https://gitea.example/acme/widget/pulls/11',
  state: 'merged',
  author: giteaUser(),
  labels: ['backend'],
  sourceBranch: 'feat/gitea',
  targetBranch: 'main',
  mergeable: true,
  createdAt: '2026-03-01T00:00:00Z',
  updatedAt: '2026-03-02T00:00:00Z',
};

const giteaIssue: GiteaIssue = {
  number: 12,
  title: 'gitea issue',
  body: 'issue body',
  url: 'https://gitea.example/acme/widget/issues/12',
  state: 'open',
  author: giteaUser(),
  labels: ['bug'],
  createdAt: '2026-03-01T00:00:00Z',
  updatedAt: '2026-03-02T00:00:00Z',
};

const giteaComment: GiteaComment = {
  id: 4004,
  body: 'gitea note',
  url: 'https://gitea.example/acme/widget/issues/12#issuecomment-4004',
  author: giteaUser(),
  createdAt: '2026-03-01T01:00:00Z',
};

const checks: GitHubChecksSummary = { state: 'failure', total: 3, success: 1, failure: 1, pending: 1 };

const checkRuns: GitHubCheckRun[] = [
  {
    name: 'build',
    status: 'completed',
    conclusion: 'success',
    startedAt: '2026-01-01T00:00:00Z',
    completedAt: '2026-01-01T00:01:00Z',
    detailsUrl: 'https://github.com/acme/widget/actions/runs/1',
    output: { title: 'Build', summary: 'all green' },
  },
  { name: 'lint', status: 'in_progress', startedAt: '2026-01-01T00:00:00Z' },
  { name: 'test', status: 'completed', conclusion: 'cancelled' },
  { name: 'doc', status: 'completed', conclusion: 'skipped' },
  { name: 'perf', status: 'completed', conclusion: 'timed_out' },
  {
    name: 'annotated',
    status: 'completed',
    conclusion: 'failure',
    annotations: [{ path: 'src/a.ts', startLine: 3, endLine: 3, level: 'error', message: 'boom', title: 'TS error' }],
  },
];

// ---------------------------------------------------------------------------
// Normalization
// ---------------------------------------------------------------------------

describe('stateOf', () => {
  test('maps provider state strings onto the normalized lifecycle state', () => {
    expect(stateOf('open')).toBe('open');
    expect(stateOf('opened')).toBe('open');
    expect(stateOf('closed')).toBe('closed');
    expect(stateOf('merged')).toBe('merged');
    expect(stateOf(undefined)).toBe('closed');
    expect(stateOf(null)).toBe('closed');
    expect(stateOf('unexpected')).toBe('closed');
  });
});

describe('github normalization', () => {
  test('maps a GitHub PR', () => {
    const pr = mapGithubPr(githubPr);
    expect(pr.number).toBe(42);
    expect(pr.state).toBe('open');
    expect(pr.draft).toBe(true);
    expect(pr.base.ref).toBe('main');
    expect(pr.head.ref).toBe('feat/forge');
    expect(pr.head.repo).toBeNull();
    expect(pr.headSha).toBe('abc123');
    expect(pr.mergeable).toBe(true);
    expect(pr.mergeableState).toBe('clean');
    expect(pr.labels).toEqual([]);
    expect(pr.assignees).toEqual([]);
    expect(pr.author?.id).toBe('octocat');
    expect(pr.author?.login).toBe('octocat');
    expect(pr.url).toBe('https://github.com/acme/widget/pull/42');
  });

  test('maps a GitHub issue', () => {
    const issue = mapGithubIssue(githubIssue);
    expect(issue.number).toBe(7);
    expect(issue.state).toBe('closed');
    expect(issue.body).toBe('Details');
    expect(issue.labels).toEqual([{ name: 'bug', color: 'd73a4a' }]);
    expect(issue.assignees).toHaveLength(1);
    expect(issue.assignees?.[0]?.id).toBe('octocat');
    expect(issue.milestone).toBeNull();
    expect(issue.url).toBe('https://github.com/acme/widget/issues/7');
  });

  test('maps GitHub issue and review comments', () => {
    const comment = mapGithubIssueComment(githubIssueComment);
    expect(comment.id).toBe('1001');
    expect(comment.body).toBe('First!');
    expect(comment.author?.id).toBe('octocat');
    expect(comment.inReplyToId).toBeNull();
    expect(comment.path).toBeNull();
    expect(comment.line).toBeNull();

    const reviewComment = {
      id: 2002,
      body: 'Lint this',
      url: 'https://github.com/acme/widget/pull/42#discussion_r2002',
      author: githubUser(),
      path: 'src/forge.ts',
      position: 12,
      createdAt: '2026-01-03T05:00:00Z',
    };  // Shape of GitHubPullRequestReviewComment, which api/types keeps local.
    const mapped = mapGithubReviewComment(reviewComment);
    expect(mapped.id).toBe('2002');
    expect(mapped.path).toBe('src/forge.ts');
    expect(mapped.line).toBe(12);
    expect(mapped.inReplyToId).toBeNull();
    expect(mapped.commitSha).toBeNull();
  });

  test('maps a GitHub PR context', () => {
    const context = mapGithubContext({
      connected: true,
      repo: { owner: 'acme', repo: 'widget', url: 'https://github.com/acme/widget' },
      pr: githubPr,
      issueComments: [githubIssueComment],
      reviewComments: [],
      files: [{ filename: 'src/forge.ts', status: 'modified', additions: 2, deletions: 1, patch: '@@' }],
      diff: '--- a/src/forge.ts',
      checks,
      checkRuns,
    });
    expect(context.connected).toBe(true);
    expect(context.repo?.owner).toBe('acme');
    expect(context.repo?.provider).toBe('github');
    expect(context.pr?.number).toBe(42);
    expect(context.issueComments).toHaveLength(1);
    expect(context.reviewComments).toEqual([]);
    expect(context.files[0]).toEqual({
      filename: 'src/forge.ts',
      status: 'modified',
      additions: 2,
      deletions: 1,
      patch: '@@',
    });
    expect(context.diff).toContain('forge.ts');
    expect(context.checks?.state).toBe('failure');
  });
});

describe('github checks', () => {
  test('maps the check summary and check runs', () => {
    const summary = mapGithubCheckSummary(checks, checkRuns);
    expect(summary.state).toBe('failure');
    expect(summary.total).toBe(3);
    expect(summary.success).toBe(1);
    expect(summary.checks).toHaveLength(6);

    const byName = Object.fromEntries(summary.checks.map((c) => [c.name, c.state]));
    expect(byName['build']).toBe('success');
    expect(byName['lint']).toBe('pending');
    expect(byName['test']).toBe('cancelled');
    expect(byName['doc']).toBe('skipped');
    expect(byName['perf']).toBe('failure');

    const build = summary.checks.find((c) => c.name === 'build');
    expect(build?.kind).toBe('check-run');
    expect(build?.url).toBe('https://github.com/acme/widget/actions/runs/1');
    expect(build?.details?.title).toBe('Build');
    expect(build?.details?.summary).toBe('all green');

    const annotated = summary.checks.find((c) => c.name === 'annotated');
    expect(annotated?.details?.annotations?.[0]).toEqual({
      path: 'src/a.ts',
      startLine: 3,
      endLine: 3,
      level: 'error',
      message: 'boom',
      title: 'TS error',
    });
  });

  test('omits checks when the context carries none', () => {
    const context = mapGithubContext({ connected: true, pr: githubPr });
    expect(context.checks).toBeNull();
  });

  test('maps check run states from status/conclusion pairs', () => {
    expect(mapCheckRunState('queued')).toBe('pending');
    expect(mapCheckRunState('in_progress')).toBe('pending');
    expect(mapCheckRunState('completed')).toBe('unknown');
    expect(mapCheckRunState('completed', 'success')).toBe('success');
    expect(mapCheckRunState('completed', 'neutral')).toBe('success');
    expect(mapCheckRunState('completed', 'failure')).toBe('failure');
    expect(mapCheckRunState('completed', 'timed_out')).toBe('failure');
    expect(mapCheckRunState('completed', 'cancelled')).toBe('cancelled');
    expect(mapCheckRunState('completed', 'skipped')).toBe('skipped');
    expect(mapCheckRunState('completed', 'stale')).toBe('skipped');
    expect(mapCheckRunState('completed', 'action_required')).toBe('pending');
    expect(mapCheckRunState('completed', 'made-up')).toBe('unknown');
  });
});

describe('gitlab normalization', () => {
  test('maps a GitLab MR, mapping opened state and draft-by-title-prefix', () => {
    const mr = mapGitlabMr(gitlabMr);
    expect(mr.number).toBe(99);
    expect(mr.state).toBe('open');
    expect(mr.draft).toBe(true);
    expect(mr.base.ref).toBe('main');
    expect(mr.head.ref).toBe('feat/mr');
    expect(mr.headSha).toBe('def456');
    expect(mr.labels).toEqual([]);
    expect(mr.assignees).toEqual([]);
    expect(mr.author?.id).toBe('5');
    expect(mr.author?.url).toBe('https://gitlab.example/gluser');
    expect(mr.url).toBe('https://gitlab.example/acme/widget/-/merge_requests/99');
  });

  test('GitLab MR draft detection follows the draft flag when the title has no prefix', () => {
    expect(mapGitlabMr({ ...gitlabMr, title: 'Add MR support' }).draft).toBe(false);
    expect(mapGitlabMr({ ...gitlabMr, title: 'Add MR support', draft: true }).draft).toBe(true);
  });

  test('maps a GitLab issue', () => {
    const issue = mapGitlabIssue(gitlabIssue);
    expect(issue.number).toBe(8);
    expect(issue.state).toBe('open');
    expect(issue.body).toBe('GL body');
    expect(issue.labels).toEqual([{ name: 'frontend' }, { name: 'bug' }]);
    expect(issue.assignees).toHaveLength(1);
    expect(issue.assignees?.[0]?.id).toBe('5');
    expect(issue.milestone).toBeNull();
  });

  test('maps a GitLab note comment', () => {
    const comment = mapGitlabNoteComment(gitlabNote);
    expect(comment.id).toBe('3003');
    expect(comment.body).toBe('a note');
    expect(comment.author?.login).toBe('gluser');
  });

  test('maps a GitLab MR context', () => {
    const context = mapGitlabContext({
      connected: true,
      repo: {
        namespace: 'acme',
        project: 'widget',
        host: 'gitlab.example',
        url: 'https://gitlab.example/acme/widget',
        baseUrl: 'https://gitlab.example',
      },
      mr: gitlabMr,
      comments: [gitlabNote],
      files: [{ filename: 'src/gl.ts', status: 'added', additions: 1, deletions: 0 }],
      diff: '--- a/src/gl.ts',
    });
    expect(context.connected).toBe(true);
    expect(context.repo?.owner).toBe('acme');
    expect(context.repo?.repo).toBe('widget');
    expect(context.pr?.number).toBe(99);
    expect(context.issueComments).toHaveLength(1);
    expect(context.reviewComments).toEqual([]);
    expect(context.files[0]?.filename).toBe('src/gl.ts');
    expect(context.checks).toBeNull();
  });
});

describe('gitea normalization', () => {
  test('maps a Gitea PR', () => {
    const pr = mapGiteaPr(giteaPr);
    expect(pr.number).toBe(11);
    expect(pr.state).toBe('merged');
    expect(pr.draft).toBe(false);
    expect(pr.base.ref).toBe('main');
    expect(pr.head.ref).toBe('feat/gitea');
    expect(pr.labels).toEqual([{ name: 'backend' }]);
    expect(pr.assignees).toEqual([]);
    expect(pr.mergeable).toBe(true);
    expect(pr.author?.id).toBe('3');
    expect(pr.url).toBe('https://gitea.example/acme/widget/pulls/11');
  });

  test('maps a Gitea issue', () => {
    const issue = mapGiteaIssue(giteaIssue);
    expect(issue.number).toBe(12);
    expect(issue.state).toBe('open');
    expect(issue.labels).toEqual([{ name: 'bug' }]);
    expect(issue.assignees).toEqual([]);
    expect(issue.body).toBe('issue body');
  });

  test('maps a Gitea comment', () => {
    const comment = mapGiteaComment(giteaComment);
    expect(comment.id).toBe('4004');
    expect(comment.body).toBe('gitea note');
    expect(comment.author?.login).toBe('guser');
    expect(comment.url).toBe('https://gitea.example/acme/widget/issues/12#issuecomment-4004');
  });

  test('maps a Gitea PR context', () => {
    const context = mapGiteaContext({
      connected: true,
      repo: { owner: 'acme', repo: 'widget', url: 'https://gitea.example/acme/widget' },
      pr: giteaPr,
      comments: [giteaComment],
      files: [{ filename: 'src/gitea.ts', status: 'modified', additions: 3, deletions: 1, patch: '@@' }],
      diff: '--- a/src/gitea.ts',
    });
    expect(context.connected).toBe(true);
    expect(context.repo?.provider).toBe('gitea');
    expect(context.pr?.number).toBe(11);
    expect(context.issueComments).toHaveLength(1);
    expect(context.reviewComments).toEqual([]);
    expect(context.files[0]?.additions).toBe(3);
    expect(context.checks).toBeNull();
  });
});

// ---------------------------------------------------------------------------
// Adapter factory
// ---------------------------------------------------------------------------

describe('buildForgeProvider', () => {
  test('returns null when the kind has no registered API', () => {
    expect(buildForgeProvider('github', {})).toBeNull();
    expect(buildForgeProvider('gitlab', {})).toBeNull();
    expect(buildForgeProvider('gitea', {})).toBeNull();
  });

  test('builds a GitHub adapter with GitHub capabilities', () => {
    const provider = buildForgeProvider('github', { github: {} as GitHubAPI });
    expect(provider?.kind).toBe('github');
    expect(provider?.capabilities).toEqual({
      checks: 'check-runs',
      reviews: 'submit',
      draft: true,
      labels: true,
      assignees: true,
      milestones: true,
      timelineEvents: true,
      inlineComments: true,
      threads: true,
    });
  });

  test('builds a GitLab adapter with approve-only reviews and no inline comments', () => {
    const provider = buildForgeProvider('gitlab', { gitlab: {} as GitLabAPI });
    expect(provider?.kind).toBe('gitlab');
    expect(provider?.capabilities).toEqual({
      checks: 'none',
      reviews: 'approve-only',
      draft: true,
      labels: true,
      assignees: true,
      milestones: true,
      timelineEvents: true,
      inlineComments: false,
      threads: true,
    });
  });

  test('builds a Gitea adapter with commit-statuses checks and no drafts', () => {
    const provider = buildForgeProvider('gitea', { gitea: {} as GiteaAPI });
    expect(provider?.kind).toBe('gitea');
    expect(provider?.capabilities).toEqual({
      checks: 'commit-statuses',
      reviews: 'submit',
      draft: false,
      labels: true,
      assignees: true,
      milestones: true,
      timelineEvents: true,
      inlineComments: true,
      threads: true,
    });
  });
});

describe('adapters gracefully degrade', () => {
  test('return null / disconnected envelopes when runtime methods are missing', async () => {
    const provider = createGitlabForgeProvider({} as unknown as GitLabAPI);

    expect(await provider.getPullRequestForBranch('/repo', 'main')).toBeNull();
    expect(await provider.listPullRequests('/repo')).toEqual({
      connected: false,
      repo: null,
      prs: [],
      page: 1,
      hasMore: false,
    });
    expect(await provider.listIssues('/repo')).toEqual({
      connected: false,
      repo: null,
      issues: [],
      page: 1,
      hasMore: false,
    });
    const context = await provider.getPullRequestContext('/repo', 1);
    expect(context.connected).toBe(false);
    expect(context.issueComments).toEqual([]);
    expect(context.reviewComments).toEqual([]);
    const detail = await provider.getIssue('/repo', 1);
    expect(detail.connected).toBe(false);
    expect(detail.comments).toEqual([]);
    expect(detail.commentsError).toBeNull();
  });

  test('swallow wire failures into the graceful envelope', async () => {
    const api = {
      mrsList: async () => {
        throw new Error('boom');
      },
    } as unknown as GitLabAPI;
    const provider = createGitlabForgeProvider(api);

    expect(await provider.getPullRequestForBranch('/repo', 'main')).toBeNull();
    const list = await provider.listPullRequests('/repo');
    expect(list.connected).toBe(false);
    expect(list.prs).toEqual([]);
  });

  test('mark commentsError when the issue loads but its comments fail', async () => {
    const api = {
      issueGet: async () => ({
        connected: true,
        issue: { number: 1, title: 't', url: 'u', state: 'opened', author: { username: 'u', id: 1 }, labels: [] },
      }),
      issueComments: async () => {
        throw new Error('boom');
      },
    } as unknown as GitLabAPI;
    const provider = createGitlabForgeProvider(api);

    const detail = await provider.getIssue('/repo', 1);
    expect(detail.connected).toBe(true);
    expect(detail.issue?.number).toBe(1);
    expect(detail.comments).toEqual([]);
    expect(detail.commentsError).toBeTruthy();
    expect(typeof detail.commentsError).toBe('string');
  });

  test('clear commentsError when the issue and its comments load', async () => {
    const api = {
      issueGet: async () => ({
        connected: true,
        issue: { number: 1, title: 't', url: 'u', state: 'opened', author: { username: 'u', id: 1 }, labels: [] },
      }),
      issueComments: async () => ({
        connected: true,
        comments: [{ id: 1, body: 'hi', url: 'u', author: { username: 'u', id: 1 }, createdAt: '2026-01-01T00:00:00Z' }],
      }),
    } as unknown as GitLabAPI;
    const provider = createGitlabForgeProvider(api);

    const detail = await provider.getIssue('/repo', 1);
    expect(detail.connected).toBe(true);
    expect(detail.comments).toHaveLength(1);
    expect(detail.commentsError).toBeNull();
  });
});

describe('getPullRequestForBranch', () => {
  test('GitLab prefers the opened MR over a merged one for the branch', async () => {
    const api = {
      mrsList: async () => ({
        connected: true,
        mrs: [
          { number: 3, title: 'MR 3', url: 'u3', state: 'merged', draft: false, author: { username: 'u', id: 1 }, sourceBranch: 'feat/a', targetBranch: 'main' },
          { number: 7, title: 'MR 7', url: 'u7', state: 'opened', draft: false, author: { username: 'u', id: 1 }, sourceBranch: 'feat/a', targetBranch: 'main' },
        ],
        page: 1,
        hasMore: false,
      }),
    } as unknown as GitLabAPI;

    const provider = createGitlabForgeProvider(api);
    const pr = await provider.getPullRequestForBranch('/repo', 'feat/a');
    expect(pr?.number).toBe(7);
    expect(pr?.state).toBe('open');
  });

  test('Gitea falls back to a merged PR when no open one exists', async () => {
    const api = {
      prsList: async () => ({
        connected: true,
        prs: [
          { number: 5, title: 'PR 5', url: 'u5', state: 'merged', draft: false, author: { username: 'u', id: 1 }, labels: [], sourceBranch: 'feat/b', targetBranch: 'main' },
          { number: 9, title: 'PR 9', url: 'u9', state: 'closed', draft: false, author: { username: 'u', id: 1 }, labels: [], sourceBranch: 'feat/b', targetBranch: 'main' },
        ],
        page: 1,
        hasMore: false,
      }),
    } as unknown as GiteaAPI;

    const provider = buildForgeProvider('gitea', { gitea: api });
    const pr = await provider?.getPullRequestForBranch('/repo', 'feat/b');
    expect(pr?.number).toBe(5);
    expect(pr?.state).toBe('merged');
  });
});

// ---------------------------------------------------------------------------
// Imperative helper (getForgeProviderForDirectory)
// ---------------------------------------------------------------------------

let gitProviderKind: 'github' | 'gitlab' | 'gitea' | 'other' | null = null;
let hasRegisteredForgeApis = false;

mock.module('@/lib/gitProvider', () => ({
  resolveGitProvider: async () => gitProviderKind,
  useGitProvider: () => gitProviderKind,
}));

mock.module('@/contexts/runtimeAPIRegistry', () => ({
  getRegisteredRuntimeAPIs: () => {
    if (!hasRegisteredForgeApis) return null;
    return {
      github: {
        prsList: async () => ({ connected: true, prs: [], page: 1, hasMore: false }),
      },
    };
  },
}));

const { getForgeProviderForDirectory } = await import('@/hooks/useForgeProvider');

describe('getForgeProviderForDirectory', () => {
  beforeEach(() => {
    gitProviderKind = 'github';
    hasRegisteredForgeApis = true;
  });

  afterEach(() => {
    gitProviderKind = null;
    hasRegisteredForgeApis = false;
  });

  test('builds a provider for a detected kind with a registered API', async () => {
    const provider = await getForgeProviderForDirectory('/repo');
    expect(provider?.kind).toBe('github');
    expect(provider?.capabilities.checks).toBe('check-runs');
  });

  test('returns null when the directory is classified as other', async () => {
    gitProviderKind = 'other';
    expect(await getForgeProviderForDirectory('/repo')).toBeNull();
  });

  test('returns null when the runtime has no registered APIs', async () => {
    hasRegisteredForgeApis = false;
    expect(await getForgeProviderForDirectory('/repo')).toBeNull();
  });

  test('returns null when the API for the detected kind is absent', async () => {
    gitProviderKind = 'gitlab';
    expect(await getForgeProviderForDirectory('/repo')).toBeNull();
  });
});
