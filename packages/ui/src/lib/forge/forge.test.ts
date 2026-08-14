import { afterEach, beforeEach, describe, expect, mock, test } from 'bun:test';
import type {
  GiteaAPI,
  GiteaComment,
  GiteaCommitStatus,
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
import { buildForgeProvider, createGiteaForgeProvider, createGithubForgeProvider, createGitlabForgeProvider } from '@/lib/forge/adapters';
import {
  aggregateStatusState,
  firstLine,
  mapCheckRunState,
  mapGiteaAssignee,
  mapGiteaCommits,
  mapGiteaComment,
  mapGiteaContext,
  mapGiteaIssue,
  mapGiteaPr,
  mapGiteaReviewsToEvents,
  mapGiteaReview,
  mapGiteaStatuses,
  mapGithubAssignee,
  mapGithubCheckSummary,
  mapGithubCommits,
  mapGithubContext,
  mapGithubIssue,
  mapGithubIssueComment,
  mapGithubPr,
  mapGithubReview,
  mapGithubReviewComment,
  mapGithubTimelineEvents,
  mapGitlabCommits,
  mapGitlabContext,
  mapGitlabIssue,
  mapGitlabMember,
  mapGitlabMr,
  mapGitlabNoteComment,
  mapGitlabTimelineEvents,
  mapReviewState,
  mapStatusState,
  normalizeEventType,
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

  test('maps enriched GitHub PR metadata (labels/assignees/milestone/comments)', () => {
    const pr = mapGithubPr({
      ...githubPr,
      labels: [{ name: 'bug', color: 'd73a4a' }],
      assignees: [githubUser()],
      milestone: { title: 'v2.0' },
      commentsCount: 3,
    });
    expect(pr.labels).toEqual([{ name: 'bug', color: 'd73a4a' }]);
    expect(pr.assignees).toHaveLength(1);
    expect(pr.assignees?.[0]?.id).toBe('octocat');
    expect(pr.milestone?.title).toBe('v2.0');
    expect(pr.commentsCount).toBe(3);
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

describe('repo-scoped lookup normalization', () => {
  test('maps a GitHub repo assignee', () => {
    expect(mapGithubAssignee(githubUser())).toEqual({
      id: 'octocat',
      login: 'octocat',
      name: 'Octo Cat',
      avatarUrl: 'https://avatars.example/octocat',
    });
  });

  test('maps a GitLab project member', () => {
    expect(mapGitlabMember(gitlabUser())).toEqual({
      id: '5',
      login: 'gluser',
      name: 'GL User',
      avatarUrl: 'https://avatars.example/gluser',
      url: 'https://gitlab.example/gluser',
    });
  });

  test('maps a Gitea repo assignee', () => {
    expect(mapGiteaAssignee(giteaUser())).toEqual({
      id: '3',
      login: 'guser',
      name: 'G User',
      avatarUrl: 'https://avatars.example/guser',
      url: 'https://gitea.example/guser',
    });
  });
});

// ---------------------------------------------------------------------------
// Rich-view normalization (commits / timeline / checks)
// ---------------------------------------------------------------------------

describe('shared rich-view helpers', () => {
  test('firstLine extracts the first message line', () => {
    expect(firstLine('one line')).toBe('one line');
    expect(firstLine('first\nsecond')).toBe('first');
    expect(firstLine('')).toBe('');
  });

  test('normalizeEventType maps provider types onto the vocabulary', () => {
    expect(normalizeEventType('opened')).toBe('opened');
    expect(normalizeEventType('merged')).toBe('merged');
    expect(normalizeEventType('labeled')).toBe('labeled');
    expect(normalizeEventType('cross-referenced')).toBe('referenced');
    expect(normalizeEventType('mystery-event')).toBe('other');
  });

  test('mapStatusState collapses error/warning onto failure/pending', () => {
    expect(mapStatusState('success')).toBe('success');
    expect(mapStatusState('failure')).toBe('failure');
    expect(mapStatusState('error')).toBe('failure');
    expect(mapStatusState('pending')).toBe('pending');
    expect(mapStatusState('warning')).toBe('pending');
    expect(mapStatusState('unknown')).toBe('unknown');
    expect(mapStatusState('something-else')).toBe('unknown');
  });

  test('aggregateStatusState is failure > pending > success', () => {
    expect(aggregateStatusState([])).toBe('success');
    expect(aggregateStatusState([{ state: 'success', name: 'a' }])).toBe('success');
    expect(aggregateStatusState([{ state: 'success', name: 'a' }, { state: 'pending', name: 'b' }])).toBe('pending');
    expect(aggregateStatusState([{ state: 'pending', name: 'a' }, { state: 'error', name: 'b' }])).toBe('failure');
    expect(aggregateStatusState([{ state: 'failure', name: 'a' }])).toBe('failure');
  });
});

describe('commit normalization', () => {
  test('maps GitHub commits using shortSha and first-line summaries', () => {
    const commits = mapGithubCommits([{
      sha: 'abc123',
      shortSha: 'abc1234',
      message: 'Summary line\n\nFull body',
      author: githubUser(),
      committedAt: '2026-01-02T03:04:05Z',
      parents: ['parent-1'],
    }]);
    expect(commits[0]).toEqual({
      sha: 'abc123',
      shortSha: 'abc1234',
      message: 'Summary line\n\nFull body',
      summary: 'Summary line',
      author: { id: 'octocat', login: 'octocat', name: 'Octo Cat', avatarUrl: 'https://avatars.example/octocat' },
      committedAt: '2026-01-02T03:04:05Z',
      parents: ['parent-1'],
    });
  });

  test('GitHub commits fall back to the first message line when summary is absent', () => {
    const [commit] = mapGithubCommits([{
      sha: 'abc123',
      shortSha: 'abc1234',
      message: 'Title line\n\nBody',
      parents: [],
    }]);
    expect(commit.summary).toBe('Title line');
    expect(commit.author).toBeFalsy();
    expect(commit.parents).toEqual([]);
  });

  test('maps GitLab commits with an author synthesized from authorName', () => {
    const commits = mapGitlabCommits([{
      sha: 'def456',
      shortSha: 'def4567',
      message: 'MR commit',
      authorName: 'GL User',
      committedAt: '2026-02-01T00:00:00Z',
      parents: [],
    }]);
    expect(commits[0].shortSha).toBe('def4567');
    expect(commits[0].author).toEqual({ id: 'GL User', login: 'GL User', name: 'GL User' });
  });

  test('maps Gitea commits, deriving shortSha from the full sha', () => {
    const commits = mapGiteaCommits([{
      sha: '0123456789abcdef0123456789abcdef01234567',
      message: 'gitea commit',
      author: giteaUser(),
      committedAt: '2026-03-01T00:00:00Z',
      parents: [],
    }]);
    expect(commits[0].shortSha).toBe('0123456');
    expect(commits[0].author?.login).toBe('guser');
  });
});

describe('timeline normalization', () => {
  test('maps GitHub timeline events with source provenance', () => {
    const events = mapGithubTimelineEvents([
      { id: '1', type: 'opened', author: githubUser(), createdAt: '2026-01-02T03:04:05Z' },
      { id: '2', type: 'cross-referenced' },
      { id: '3', type: 'mystery-type', body: 'x' },
    ]);
    expect(events[0].type).toBe('opened');
    expect(events[0].id).toBe('1');
    expect(events[0].author?.login).toBe('octocat');
    expect(events[0].source).toBe('github-timeline');
    expect(events[1].type).toBe('referenced');
    expect(events[2].type).toBe('other');
  });

  test('maps GitLab timeline events as system notes', () => {
    const events = mapGitlabTimelineEvents([
      { id: '9', type: 'approved', author: gitlabUser(), createdAt: '2026-02-01T00:00:00Z' },
    ]);
    expect(events[0].type).toBe('approved');
    expect(events[0].author?.login).toBe('gluser');
    expect(events[0].source).toBe('gitlab-system-note');
  });

  test('synthesizes Gitea timeline events from reviews, skipping PENDING', () => {
    const events = mapGiteaReviewsToEvents([
      { id: '1', state: 'APPROVED', author: giteaUser(), submittedAt: '2026-03-01T00:00:00Z', body: 'LGTM', commitSha: 'abc123' },
      { id: '2', state: 'REQUEST_CHANGES', author: giteaUser() },
      { id: '3', state: 'COMMENT' },
      { id: '4', state: 'PENDING' },
      { id: '5', state: 'DISMISSED' },
    ]);
    expect(events).toHaveLength(4);
    expect(events[0]).toEqual({
      id: '1',
      type: 'approved',
      author: { id: '3', login: 'guser', name: 'G User', avatarUrl: 'https://avatars.example/guser', url: 'https://gitea.example/guser' },
      createdAt: '2026-03-01T00:00:00Z',
      body: 'LGTM',
      commitSha: 'abc123',
      source: 'gitea-review',
    });
    expect(events[1].type).toBe('requested-changes');
    expect(events[2].type).toBe('commented');
    expect(events[3].type).toBe('other');
  });
});

describe('gitea commit-status normalization', () => {
  const statuses: GiteaCommitStatus[] = [
    { state: 'success', name: 'ci' },
    { state: 'failure', name: 'lint' },
    { state: 'pending', name: 'test' },
    { state: 'error', name: 'build' },
    { state: 'warning', name: 'docs' },
    { state: 'unknown', name: 'mystery' },
  ];

  test('maps statuses onto a checks summary with aggregated state', () => {
    const summary = mapGiteaStatuses(statuses);
    expect(summary.state).toBe('failure');
    expect(summary.total).toBe(6);
    expect(summary.success).toBe(1);
    expect(summary.failure).toBe(2);
    expect(summary.pending).toBe(2);
    expect(summary.checks[0]).toEqual({
      kind: 'commit-status',
      name: 'ci',
      state: 'success',
      url: undefined,
      description: undefined,
      startedAt: undefined,
      completedAt: undefined,
    });
    expect(summary.checks[1].state).toBe('failure');
    expect(summary.checks[3].state).toBe('failure');
    expect(summary.checks[4].state).toBe('pending');
    expect(summary.checks[5].state).toBe('unknown');
  });

  test('carries url and description onto the normalized checks', () => {
    const [check] = mapGiteaStatuses([
      { state: 'pending', name: 'deploy', url: 'https://gitea.example/status/1', description: 'Deploying…', createdAt: '2026-03-01T00:00:00Z' },
    ]).checks;
    expect(check.url).toBe('https://gitea.example/status/1');
    expect(check.description).toBe('Deploying…');
    expect(check.startedAt).toBe('2026-03-01T00:00:00Z');
    expect(check.completedAt).toBe('2026-03-01T00:00:00Z');
  });
});

// ---------------------------------------------------------------------------
// Review normalization
// ---------------------------------------------------------------------------

describe('review normalization', () => {
  test('mapReviewState maps provider states onto the normalized vocabulary', () => {
    expect(mapReviewState('APPROVED')).toBe('approved');
    expect(mapReviewState('approved')).toBe('approved');
    expect(mapReviewState('CHANGES_REQUESTED')).toBe('requested-changes');
    expect(mapReviewState('REQUEST_CHANGES')).toBe('requested-changes');
    expect(mapReviewState('request_changes')).toBe('requested-changes');
    expect(mapReviewState('COMMENTED')).toBe('commented');
    expect(mapReviewState('COMMENT')).toBe('commented');
    expect(mapReviewState('DISMISSED')).toBe('dismissed');
    expect(mapReviewState('mystery')).toBe('pending');
  });

  test('maps a GitHub review', () => {
    const review = mapGithubReview({
      id: 'r1',
      state: 'APPROVED',
      author: githubUser(),
      submittedAt: '2026-01-01T00:00:00Z',
      body: 'LGTM',
      commitSha: 'abc123',
    });
    expect(review).toEqual({
      id: 'r1',
      state: 'approved',
      author: { id: 'octocat', login: 'octocat', name: 'Octo Cat', avatarUrl: 'https://avatars.example/octocat' },
      submittedAt: '2026-01-01T00:00:00Z',
      body: 'LGTM',
      commitSha: 'abc123',
    });
  });

  test('maps a Gitea review, collapsing REQUEST_CHANGES', () => {
    const review = mapGiteaReview({ id: 'r2', state: 'REQUEST_CHANGES', author: giteaUser(), body: 'fix it' });
    expect(review.state).toBe('requested-changes');
    expect(review.author?.login).toBe('guser');
    expect(review.submittedAt).toBe(undefined);
  });
});

// ---------------------------------------------------------------------------
// Write operations
// ---------------------------------------------------------------------------

describe('write operations: addComment', () => {
  test('github routes issue/pull and parses sourceRepo', async () => {
    let issueArgs: Record<string, unknown> = {};
    let prArgs: Record<string, unknown> = {};
    const api = {
      issueComment: async (input: Record<string, unknown>) => {
        issueArgs = input;
        return { connected: true, comment: githubIssueComment };
      },
      prComment: async (input: Record<string, unknown>) => {
        prArgs = input;
        return { connected: true, comment: githubIssueComment };
      },
    } as unknown as GitHubAPI;
    const provider = createGithubForgeProvider(api);

    const issueResult = await provider.addComment!(
      '/repo', { kind: 'issue', number: 7 }, { body: 'hi' }, { sourceRepo: 'upstream/widget' },
    );
    expect(issueResult.ok).toBe(true);
    expect(issueResult.comment?.id).toBe('1001');
    expect(issueResult.comment?.body).toBe('First!');
    expect(issueArgs).toEqual({ directory: '/repo', number: 7, body: 'hi', owner: 'upstream', repo: 'widget' });

    const prResult = await provider.addComment!('/repo', { kind: 'pull', number: 42 }, { body: 'yo' });
    expect(prResult.ok).toBe(true);
    expect(prArgs).toEqual({ directory: '/repo', number: 42, body: 'yo', owner: undefined, repo: undefined });
  });

  test('gitlab routes issue/pull and parses multi-segment namespaces', async () => {
    let issueArgs: Record<string, unknown> = {};
    let mrArgs: Record<string, unknown> = {};
    const api = {
      issueComment: async (input: Record<string, unknown>) => {
        issueArgs = input;
        return { connected: true, comment: gitlabNote };
      },
      mrComment: async (input: Record<string, unknown>) => {
        mrArgs = input;
        return { connected: true, comment: gitlabNote };
      },
    } as unknown as GitLabAPI;
    const provider = createGitlabForgeProvider(api);

    const issueResult = await provider.addComment!(
      '/repo', { kind: 'issue', number: 8 }, { body: 'hi' }, { sourceRepo: 'group/sub/proj' },
    );
    expect(issueResult.ok).toBe(true);
    expect(issueResult.comment?.author?.login).toBe('gluser');
    expect(issueArgs).toEqual({ directory: '/repo', number: 8, body: 'hi', namespace: 'group/sub', project: 'proj' });

    const mrResult = await provider.addComment!('/repo', { kind: 'pull', number: 99 }, { body: 'yo' });
    expect(mrResult.ok).toBe(true);
    expect(mrArgs).toEqual({ directory: '/repo', number: 99, body: 'yo', namespace: undefined, project: undefined });
  });

  test('gitea routes issue/pull and parses sourceRepo', async () => {
    let issueArgs: Record<string, unknown> = {};
    let prArgs: Record<string, unknown> = {};
    const api = {
      issueComment: async (input: Record<string, unknown>) => {
        issueArgs = input;
        return { connected: true, comment: giteaComment };
      },
      prComment: async (input: Record<string, unknown>) => {
        prArgs = input;
        return { connected: true, comment: giteaComment };
      },
    } as unknown as GiteaAPI;
    const provider = createGiteaForgeProvider(api);

    const issueResult = await provider.addComment!(
      '/repo', { kind: 'issue', number: 12 }, { body: 'hi' }, { sourceRepo: 'acme/widget' },
    );
    expect(issueResult.ok).toBe(true);
    expect(issueResult.comment?.id).toBe('4004');
    expect(issueArgs).toEqual({ directory: '/repo', number: 12, body: 'hi', owner: 'acme', repo: 'widget' });

    const prResult = await provider.addComment!('/repo', { kind: 'pull', number: 11 }, { body: 'yo' });
    expect(prResult.ok).toBe(true);
    expect(prArgs).toEqual({ directory: '/repo', number: 11, body: 'yo', owner: undefined, repo: undefined });
  });
});

describe('write operations: replyToThread', () => {
  test('github posts a review-comment reply on pulls with the numeric inReplyToId', async () => {
    let reviewArgs: Record<string, unknown> = {};
    const api = {
      prReviewComment: async (input: Record<string, unknown>) => {
        reviewArgs = input;
        return {
          connected: true,
          comment: {
            id: 2002,
            body: 'reply',
            url: 'u',
            author: githubUser(),
            path: 'src/a.ts',
            line: 5,
            createdAt: '2026-01-01T00:00:00Z',
          },
        };
      },
    } as unknown as GitHubAPI;
    const provider = createGithubForgeProvider(api);

    const result = await provider.replyToThread!(
      '/repo', { kind: 'pull', number: 42 },
      { body: 'reply', inReplyToId: '2002', path: 'src/a.ts', line: 5 },
    );
    expect(result.ok).toBe(true);
    expect(reviewArgs.inReplyToId).toBe(2002);
    expect(reviewArgs.path).toBe('src/a.ts');
    expect(reviewArgs.line).toBe(5);
    expect(result.comment?.id).toBe('2002');
    expect(result.comment?.path).toBe('src/a.ts');
  });

  test('github falls back to a flat comment on issues', async () => {
    let issueArgs: Record<string, unknown> = {};
    const api = {
      issueComment: async (input: Record<string, unknown>) => {
        issueArgs = input;
        return { connected: true, comment: githubIssueComment };
      },
    } as unknown as GitHubAPI;
    const provider = createGithubForgeProvider(api);

    const result = await provider.replyToThread!(
      '/repo', { kind: 'issue', number: 7 }, { body: 'thread reply', inReplyToId: '1001' },
    );
    expect(result.ok).toBe(true);
    expect(issueArgs.body).toBe('thread reply');
  });

  test('gitlab and gitea reply as flat comments, ignoring the thread anchor', async () => {
    let mrArgs: Record<string, unknown> = {};
    const gitlab = createGitlabForgeProvider({
      mrComment: async (input: Record<string, unknown>) => {
        mrArgs = input;
        return { connected: true, comment: gitlabNote };
      },
    } as unknown as GitLabAPI);
    const glResult = await gitlab.replyToThread!(
      '/repo', { kind: 'pull', number: 99 }, { body: 'gl reply', inReplyToId: '3003' },
    );
    expect(glResult.ok).toBe(true);
    expect(mrArgs.body).toBe('gl reply');
    expect(mrArgs.inReplyToId).toBe(undefined);

    let giteaArgs: Record<string, unknown> = {};
    const gitea = createGiteaForgeProvider({
      prComment: async (input: Record<string, unknown>) => {
        giteaArgs = input;
        return { connected: true, comment: giteaComment };
      },
    } as unknown as GiteaAPI);
    const gtResult = await gitea.replyToThread!(
      '/repo', { kind: 'pull', number: 11 }, { body: 'gt reply', inReplyToId: '4004' },
    );
    expect(gtResult.ok).toBe(true);
    expect(giteaArgs.body).toBe('gt reply');
    expect(giteaArgs.inReplyToId).toBe(undefined);
  });
});

describe('write operations: updateEntity', () => {
  test('github resolves the current title and passes state through on pulls', async () => {
    let updateArgs: Record<string, unknown> = {};
    const api = {
      prContext: async () => ({ connected: true, pr: { ...githubPr, title: 'Add forge facade' } }),
      prUpdate: async (input: Record<string, unknown>) => {
        updateArgs = input;
        return { number: 42, title: 'Add forge facade', url: 'u', state: 'closed', draft: false, base: 'main', head: 'feat' };
      },
    } as unknown as GitHubAPI;
    const provider = createGithubForgeProvider(api);

    const result = await provider.updateEntity!('/repo', { kind: 'pull', number: 42 }, { state: 'closed' });
    expect(result.ok).toBe(true);
    expect(updateArgs).toEqual({ directory: '/repo', number: 42, title: 'Add forge facade', state: 'closed' });
    expect(result.entity?.number).toBe(42);
    expect(result.entity?.state).toBe('closed');
  });

  test('github issue updates pass title/body/state straight through', async () => {
    let updateArgs: Record<string, unknown> = {};
    const api = {
      issueUpdate: async (input: Record<string, unknown>) => {
        updateArgs = input;
        return { connected: true, issue: { ...githubIssue, state: 'open', title: 'Renamed' } };
      },
    } as unknown as GitHubAPI;
    const provider = createGithubForgeProvider(api);

    const result = await provider.updateEntity!(
      '/repo', { kind: 'issue', number: 7 }, { title: 'Renamed', body: 'New body', state: 'open' },
    );
    expect(result.ok).toBe(true);
    expect(updateArgs).toEqual({
      directory: '/repo', number: 7, title: 'Renamed', body: 'New body', state: 'open', owner: undefined, repo: undefined,
    });
    expect(result.entity?.title).toBe('Renamed');
    expect(result.entity?.state).toBe('open');
  });

  test('gitlab passes state and the parsed namespace through on issues', async () => {
    let issueArgs: Record<string, unknown> = {};
    const api = {
      issueUpdate: async (input: Record<string, unknown>) => {
        issueArgs = input;
        return { connected: true, issue: { ...gitlabIssue, state: 'closed' } };
      },
    } as unknown as GitLabAPI;
    const provider = createGitlabForgeProvider(api);

    const result = await provider.updateEntity!(
      '/repo', { kind: 'issue', number: 8 }, { state: 'closed' }, { sourceRepo: 'acme/widget' },
    );
    expect(result.ok).toBe(true);
    expect(issueArgs.state).toBe('closed');
    expect(issueArgs.namespace).toBe('acme');
    expect(issueArgs.project).toBe('widget');
    expect(result.entity?.state).toBe('closed');
  });

  test('gitlab maps the MR body onto the description field', async () => {
    let mrArgs: Record<string, unknown> = {};
    const api = {
      mrUpdate: async (input: Record<string, unknown>) => {
        mrArgs = input;
        return { ...gitlabMr, title: 'New MR title' };
      },
    } as unknown as GitLabAPI;
    const provider = createGitlabForgeProvider(api);

    const result = await provider.updateEntity!(
      '/repo', { kind: 'pull', number: 99 }, { title: 'New MR title', body: 'MR body 2', state: 'closed' },
    );
    expect(result.ok).toBe(true);
    expect(mrArgs.description).toBe('MR body 2');
    expect(mrArgs.state).toBe('closed');
    expect(result.entity?.title).toBe('New MR title');
  });

  test('gitea passes state through on pulls', async () => {
    let prArgs: Record<string, unknown> = {};
    const api = {
      prUpdate: async (input: Record<string, unknown>) => {
        prArgs = input;
        return { number: 11, title: 't', url: 'u', state: 'closed', labels: [], sourceBranch: 'feat/gitea', targetBranch: 'main', author: giteaUser() };
      },
    } as unknown as GiteaAPI;
    const provider = createGiteaForgeProvider(api);

    const result = await provider.updateEntity!('/repo', { kind: 'pull', number: 11 }, { state: 'closed' });
    expect(result.ok).toBe(true);
    expect(prArgs.state).toBe('closed');
    expect(result.entity?.state).toBe('closed');
  });
});

describe('write operations: submitReview', () => {
  test('github maps normalized events onto the wire events', async () => {
    const events: Record<string, unknown>[] = [];
    const api = {
      prSubmitReview: async (input: Record<string, unknown>) => {
        events.push(input);
        return { connected: true, review: { id: 'r1', state: 'APPROVED', author: githubUser(), submittedAt: '2026-01-01T00:00:00Z', body: 'LGTM', commitSha: 'abc123' } };
      },
    } as unknown as GitHubAPI;
    const provider = createGithubForgeProvider(api);

    const result = await provider.submitReview!('/repo', { kind: 'pull', number: 42 }, { event: 'approve', body: 'LGTM' });
    expect(result.ok).toBe(true);
    expect(result.review?.state).toBe('approved');
    expect(result.review?.author?.login).toBe('octocat');
    expect(result.review?.commitSha).toBe('abc123');

    await provider.submitReview!('/repo', { kind: 'pull', number: 42 }, { event: 'request-changes' });
    await provider.submitReview!('/repo', { kind: 'pull', number: 42 }, { event: 'comment' });
    expect(events.map((e) => e.event)).toEqual(['APPROVE', 'REQUEST_CHANGES', 'COMMENT']);
  });

  test('gitea maps events onto APPROVED/REQUEST_CHANGES/COMMENT', async () => {
    const events: Record<string, unknown>[] = [];
    const api = {
      prSubmitReview: async (input: Record<string, unknown>) => {
        events.push(input);
        return { connected: true, review: { id: 'r2', state: 'APPROVED', author: giteaUser() } };
      },
    } as unknown as GiteaAPI;
    const provider = createGiteaForgeProvider(api);

    await provider.submitReview!('/repo', { kind: 'pull', number: 11 }, { event: 'approve' });
    await provider.submitReview!('/repo', { kind: 'pull', number: 11 }, { event: 'request-changes' });
    await provider.submitReview!('/repo', { kind: 'pull', number: 11 }, { event: 'comment' });
    expect(events.map((e) => e.event)).toEqual(['APPROVED', 'REQUEST_CHANGES', 'COMMENT']);
  });

  test('gitlab approves only; request-changes and comment are unsupported', async () => {
    let approveArgs: Record<string, unknown> = {};
    const api = {
      mrApprove: async (input: Record<string, unknown>) => {
        approveArgs = input;
        return { connected: true, approved: true };
      },
    } as unknown as GitLabAPI;
    const provider = createGitlabForgeProvider(api);

    const okResult = await provider.submitReview!('/repo', { kind: 'pull', number: 99 }, { event: 'approve' });
    expect(okResult.ok).toBe(true);
    expect(okResult.review).toEqual({ id: '', state: 'approved' });
    expect(approveArgs).toEqual({ directory: '/repo', number: 99, namespace: undefined, project: undefined });

    expect(await provider.submitReview!('/repo', { kind: 'pull', number: 99 }, { event: 'request-changes' }))
      .toEqual({ ok: false, error: 'not supported' });
    expect(await provider.submitReview!('/repo', { kind: 'pull', number: 99 }, { event: 'comment' }))
      .toEqual({ ok: false, error: 'not supported' });
  });
});

describe('write operations: toggleDraft', () => {
  test('github passes the draft flag along with the current title', async () => {
    let updateArgs: Record<string, unknown> = {};
    const api = {
      prContext: async () => ({ connected: true, pr: { ...githubPr, title: 'Add forge facade' } }),
      prUpdate: async (input: Record<string, unknown>) => {
        updateArgs = input;
        return { number: 42, title: 'Add forge facade', url: 'u', state: 'open', draft: true, base: 'main', head: 'feat' };
      },
    } as unknown as GitHubAPI;
    const provider = createGithubForgeProvider(api);

    const result = await provider.toggleDraft!('/repo', { kind: 'pull', number: 42 }, true);
    expect(result.ok).toBe(true);
    expect(updateArgs.draft).toBe(true);
    expect(updateArgs.title).toBe('Add forge facade');
    expect((result.entity as { draft?: boolean } | null)?.draft).toBe(true);
  });

  test('gitlab prepends and strips the Draft: prefix idempotently', async () => {
    let currentTitle = 'Add MR support';
    const updatedTitles: string[] = [];
    const api = {
      mrContext: async () => ({ connected: true, mr: { ...gitlabMr, title: currentTitle } }),
      mrUpdate: async (input: Record<string, unknown>) => {
        currentTitle = input.title as string;
        updatedTitles.push(currentTitle);
        return { ...gitlabMr, title: currentTitle };
      },
    } as unknown as GitLabAPI;
    const provider = createGitlabForgeProvider(api);

    await provider.toggleDraft!('/repo', { kind: 'pull', number: 99 }, true);
    expect(updatedTitles.at(-1)).toBe('Draft: Add MR support');

    await provider.toggleDraft!('/repo', { kind: 'pull', number: 99 }, true);
    expect(updatedTitles.at(-1)).toBe('Draft: Add MR support');

    await provider.toggleDraft!('/repo', { kind: 'pull', number: 99 }, false);
    expect(updatedTitles.at(-1)).toBe('Add MR support');
  });

  test('gitea does not implement toggleDraft (capability draft:false)', () => {
    const provider = createGiteaForgeProvider({} as unknown as GiteaAPI);
    expect(provider.toggleDraft).toBe(undefined);
  });
});

describe('write operations: updateMetadata', () => {
  test('github passes labels/assignees/milestone through', async () => {
    let issueArgs: Record<string, unknown> = {};
    const api = {
      issueUpdate: async (input: Record<string, unknown>) => {
        issueArgs = input;
        return { connected: true, issue: githubIssue };
      },
    } as unknown as GitHubAPI;
    const provider = createGithubForgeProvider(api);

    const result = await provider.updateMetadata!(
      '/repo', { kind: 'issue', number: 7 }, { labels: ['bug'], assignees: ['octocat'], milestone: 'v2.0' },
    );
    expect(result.ok).toBe(true);
    expect(issueArgs.labels).toEqual(['bug']);
    expect(issueArgs.assignees).toEqual(['octocat']);
    expect(issueArgs.milestone).toBe('v2.0');
  });

  test('gitlab sends labels/assignee logins/milestone; the server resolves logins to IDs', async () => {
    let issueArgs: Record<string, unknown> = {};
    const api = {
      issueUpdate: async (input: Record<string, unknown>) => {
        issueArgs = input;
        return { connected: true, issue: gitlabIssue };
      },
    } as unknown as GitLabAPI;
    const provider = createGitlabForgeProvider(api);

    const result = await provider.updateMetadata!(
      '/repo', { kind: 'issue', number: 8 }, { labels: ['frontend'], assignees: ['gluser'], milestone: null },
    );
    expect(result.ok).toBe(true);
    expect(issueArgs.labels).toEqual(['frontend']);
    expect(issueArgs.milestone).toBeNull();
    expect(issueArgs.assignees).toEqual(['gluser']);
  });

  test('gitea issue metadata passes through; PR metadata is unsupported', async () => {
    let issueArgs: Record<string, unknown> = {};
    const api = {
      issueUpdate: async (input: Record<string, unknown>) => {
        issueArgs = input;
        return { connected: true, issue: giteaIssue };
      },
    } as unknown as GiteaAPI;
    const provider = createGiteaForgeProvider(api);

    const issueResult = await provider.updateMetadata!(
      '/repo', { kind: 'issue', number: 12 }, { labels: ['bug'], assignees: ['guser'] },
    );
    expect(issueResult.ok).toBe(true);
    expect(issueArgs.labels).toEqual(['bug']);
    expect(issueArgs.assignees).toEqual(['guser']);

    const prResult = await provider.updateMetadata!('/repo', { kind: 'pull', number: 11 }, { labels: ['backend'] });
    expect(prResult).toEqual({ ok: false, error: 'not supported' });
  });
});

describe('write operations degrade gracefully', () => {
  test('absent runtime methods return {ok:false} without throwing', async () => {
    const github = createGithubForgeProvider({} as unknown as GitHubAPI);
    expect(await github.addComment!('/repo', { kind: 'issue', number: 1 }, { body: 'x' }))
      .toEqual({ ok: false, error: 'failed to load' });
    expect(await github.replyToThread!('/repo', { kind: 'pull', number: 1 }, { body: 'x' }))
      .toEqual({ ok: false, error: 'failed to load' });
    expect(await github.updateEntity!('/repo', { kind: 'issue', number: 1 }, { state: 'closed' }))
      .toEqual({ ok: false, error: 'failed to load' });
    expect(await github.submitReview!('/repo', { kind: 'pull', number: 1 }, { event: 'approve' }))
      .toEqual({ ok: false, error: 'failed to load' });
    expect(await github.toggleDraft!('/repo', { kind: 'pull', number: 1 }, true))
      .toEqual({ ok: false, error: 'failed to load' });
    expect(await github.updateMetadata!('/repo', { kind: 'issue', number: 1 }, {}))
      .toEqual({ ok: false, error: 'failed to load' });

    const gitlab = createGitlabForgeProvider({} as unknown as GitLabAPI);
    expect(await gitlab.submitReview!('/repo', { kind: 'pull', number: 1 }, { event: 'approve' }))
      .toEqual({ ok: false, error: 'failed to load' });
    expect(await gitlab.toggleDraft!('/repo', { kind: 'pull', number: 1 }, true))
      .toEqual({ ok: false, error: 'failed to load' });

    const gitea = createGiteaForgeProvider({} as unknown as GiteaAPI);
    expect(await gitea.submitReview!('/repo', { kind: 'pull', number: 1 }, { event: 'approve' }))
      .toEqual({ ok: false, error: 'failed to load' });
  });

  test('github updateEntity/toggleDraft degrade when the title cannot be resolved', async () => {
    const github = createGithubForgeProvider({} as unknown as GitHubAPI);
    // prContext absent → resolvePrTitle returns null → no title, graceful failure.
    expect(await github.updateEntity!('/repo', { kind: 'pull', number: 42 }, { state: 'closed' }))
      .toEqual({ ok: false, error: 'failed to load' });
    expect(await github.toggleDraft!('/repo', { kind: 'pull', number: 42 }, true))
      .toEqual({ ok: false, error: 'failed to load' });
  });

  test('wire failures degrade to {ok:false} instead of throwing', async () => {
    const api = {
      issueComment: async () => {
        throw new Error('boom');
      },
      mrApprove: async () => {
        throw new Error('boom');
      },
    } as unknown as GitHubAPI;
    const github = createGithubForgeProvider(api);
    expect(await github.addComment!('/repo', { kind: 'issue', number: 1 }, { body: 'x' }))
      .toEqual({ ok: false, error: 'failed to load' });

    const gitlab = createGitlabForgeProvider(api as unknown as GitLabAPI);
    expect(await gitlab.submitReview!('/repo', { kind: 'pull', number: 1 }, { event: 'approve' }))
      .toEqual({ ok: false, error: 'failed to load' });
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
      userSearch: true,
      labelSearch: true,
      milestoneSearch: true,
      branchSearch: true,
      tagSearch: true,
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
      userSearch: true,
      labelSearch: true,
      milestoneSearch: true,
      branchSearch: true,
      tagSearch: true,
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
      userSearch: true,
      labelSearch: true,
      milestoneSearch: true,
      branchSearch: true,
      tagSearch: true,
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

describe('rich-view adapter wiring', () => {
  test('github getCommits maps prCommits and passes the sourceRepo selector', async () => {
    const api = {
      prCommits: async (_directory: string, _number: number, options?: { sourceRepo?: { owner: string; repo: string } | null }) => {
        expect(options?.sourceRepo).toEqual({ owner: 'upstream', repo: 'widget' });
        return {
          connected: true,
          repo: { owner: 'acme', repo: 'widget', url: 'https://github.com/acme/widget' },
          commits: [{ sha: 'abc123', shortSha: 'abc1234', message: 'm', parents: [] }],
        };
      },
    } as unknown as GitHubAPI;
    const provider = createGithubForgeProvider(api);
    const result = await provider.getCommits!('/repo', 1, { sourceRepo: 'upstream/widget' });
    expect(result.connected).toBe(true);
    expect(result.repo?.owner).toBe('acme');
    expect(result.commits[0]?.shortSha).toBe('abc1234');
    expect(result.error).toBeFalsy();
  });

  test('github getTimeline maps prTimeline; getChecks returns null', async () => {
    const api = {
      prTimeline: async () => ({
        connected: true,
        events: [{ id: '1', type: 'opened', author: githubUser() }],
      }),
    } as unknown as GitHubAPI;
    const provider = createGithubForgeProvider(api);
    const timeline = await provider.getTimeline!('/repo', 1);
    expect(timeline.events[0]?.source).toBe('github-timeline');
    expect(await provider.getChecks!('/repo', 1)).toBeNull();
  });

  test('gitlab getTimeline maps mrTimeline as system-note events', async () => {
    const api = {
      mrTimeline: async () => ({
        connected: true,
        events: [{ id: '1', type: 'approved' }],
      }),
    } as unknown as GitLabAPI;
    const provider = createGitlabForgeProvider(api);
    const timeline = await provider.getTimeline!('/repo', 1);
    expect(timeline.events[0]?.source).toBe('gitlab-system-note');
    expect(await provider.getChecks!('/repo', 1)).toBeNull();
  });

  test('gitea getTimeline synthesizes events from prReviews', async () => {
    const api = {
      prReviews: async () => ({
        connected: true,
        reviews: [{ id: '1', state: 'APPROVED', author: giteaUser() }],
      }),
    } as unknown as GiteaAPI;
    const provider = createGiteaForgeProvider(api);
    const timeline = await provider.getTimeline!('/repo', 1);
    expect(timeline.events[0]?.type).toBe('approved');
    expect(timeline.events[0]?.source).toBe('gitea-review');
  });

  test('gitea getChecks maps prStatuses onto a commit-status summary', async () => {
    const api = {
      prStatuses: async () => ({
        connected: true,
        statuses: [{ state: 'pending', name: 'ci' }],
      }),
    } as unknown as GiteaAPI;
    const provider = createGiteaForgeProvider(api);
    const result = await provider.getChecks!('/repo', 1);
    expect(result?.connected).toBe(true);
    expect(result?.checks?.state).toBe('pending');
    expect(result?.checks?.checks[0]?.kind).toBe('commit-status');
    expect(result?.error).toBeFalsy();
  });

  test('absent runtime methods degrade to disconnected envelopes', async () => {
    const github = createGithubForgeProvider({} as unknown as GitHubAPI);
    expect(await github.getCommits!('/repo', 1)).toEqual({ connected: false, repo: null, commits: [] });
    expect(await github.getTimeline!('/repo', 1)).toEqual({ connected: false, repo: null, events: [] });
    expect(await github.getChecks!('/repo', 1)).toBeNull();

    const gitea = createGiteaForgeProvider({} as unknown as GiteaAPI);
    expect(await gitea.getCommits!('/repo', 1)).toEqual({ connected: false, repo: null, commits: [] });
    expect(await gitea.getTimeline!('/repo', 1)).toEqual({ connected: false, repo: null, events: [] });
    expect(await gitea.getChecks!('/repo', 1)).toEqual({ connected: false, repo: null, checks: null });
  });

  test('wire failures set a stable error instead of throwing', async () => {
    const api = {
      prCommits: async () => { throw new Error('boom'); },
      prTimeline: async () => { throw new Error('boom'); },
    } as unknown as GitHubAPI;
    const provider = createGithubForgeProvider(api);
    const commits = await provider.getCommits!('/repo', 1);
    expect(commits.connected).toBe(false);
    expect(commits.commits).toEqual([]);
    expect(commits.error).toBe('failed to load');

    const timeline = await provider.getTimeline!('/repo', 1);
    expect(timeline.connected).toBe(false);
    expect(timeline.events).toEqual([]);
    expect(timeline.error).toBe('failed to load');
  });

  test('gitea getChecks wire failure sets a stable error', async () => {
    const api = {
      prStatuses: async () => { throw new Error('boom'); },
    } as unknown as GiteaAPI;
    const provider = createGiteaForgeProvider(api);
    const result = await provider.getChecks!('/repo', 1);
    expect(result?.connected).toBe(false);
    expect(result?.checks).toBeNull();
    expect(result?.error).toBe('failed to load');
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

describe('write operations: createIssue', () => {
  test('github passes title/body/labels and parses sourceRepo', async () => {
    let args: Record<string, unknown> = {};
    const api = {
      issueCreate: async (input: Record<string, unknown>) => {
        args = input;
        return { connected: true, issue: githubIssue };
      },
    } as unknown as GitHubAPI;
    const provider = createGithubForgeProvider(api);

    const result = await provider.createIssue!(
      '/repo',
      { title: 'Add feature', body: 'The body', labels: ['bug'] },
      { sourceRepo: 'upstream/widget' },
    );
    expect(result.ok).toBe(true);
    expect(result.issue?.number).toBe(7);
    expect(args).toEqual({
      directory: '/repo',
      title: 'Add feature',
      body: 'The body',
      labels: ['bug'],
      owner: 'upstream',
      repo: 'widget',
    });
  });

  test('github omits optional fields and fails closed when the api is absent', async () => {
    let called = false;
    const api = {
      issueCreate: async () => {
        called = true;
        return { connected: true, issue: githubIssue };
      },
    } as unknown as GitHubAPI;
    const provider = createGithubForgeProvider(api);

    const result = await provider.createIssue!('/repo', { title: 'T' });
    expect(result.ok).toBe(true);
    expect(called).toBe(true);

    const empty = createGithubForgeProvider({} as unknown as GitHubAPI);
    const failed = await empty.createIssue!('/repo', { title: 'T' });
    expect(failed.ok).toBe(false);
  });

  test('gitlab passes namespace/project from a multi-segment sourceRepo', async () => {
    let args: Record<string, unknown> = {};
    const api = {
      issueCreate: async (input: Record<string, unknown>) => {
        args = input;
        return { connected: true, issue: gitlabIssue };
      },
    } as unknown as GitLabAPI;
    const provider = createGitlabForgeProvider(api);

    const result = await provider.createIssue!(
      '/repo',
      { title: 'Add feature', body: 'The body' },
      { sourceRepo: 'group/sub/proj' },
    );
    expect(result.ok).toBe(true);
    expect(result.issue?.number).toBe(8);
    expect(args).toEqual({
      directory: '/repo',
      title: 'Add feature',
      body: 'The body',
      namespace: 'group/sub',
      project: 'proj',
    });
  });

  test('gitea passes owner/repo and maps the created issue', async () => {
    let args: Record<string, unknown> = {};
    const api = {
      issueCreate: async (input: Record<string, unknown>) => {
        args = input;
        return { connected: true, issue: giteaIssue };
      },
    } as unknown as GiteaAPI;
    const provider = createGiteaForgeProvider(api);

    const result = await provider.createIssue!('/repo', { title: 'Add feature', labels: ['bug'] });
    expect(result.ok).toBe(true);
    expect(result.issue?.number).toBe(12);
    expect(args).toEqual({
      directory: '/repo',
      title: 'Add feature',
      labels: ['bug'],
      owner: undefined,
      repo: undefined,
    });
  });

  test('createIssue degrades to ok:false without throwing on wire failure', async () => {
    const api = {
      issueCreate: async () => {
        throw new Error('boom');
      },
    } as unknown as GitHubAPI;
    const provider = createGithubForgeProvider(api);

    const result = await provider.createIssue!('/repo', { title: 'T' });
    expect(result.ok).toBe(false);
    expect(result.error).toBeTruthy();
  });
});

describe('repo-scoped user search (searchUsers)', () => {
  test('github parses sourceRepo and maps assignees by login', async () => {
    let receivedDirectory = '';
    let receivedQuery = '';
    let receivedOptions: { sourceRepo?: { owner: string; repo: string } | null } | undefined;
    const api = {
      searchUsers: async (
        directory: string,
        query: string,
        options?: { sourceRepo?: { owner: string; repo: string } | null },
      ) => {
        receivedDirectory = directory;
        receivedQuery = query;
        receivedOptions = options;
        return {
          connected: true,
          repo: { owner: 'acme', repo: 'widget', url: 'https://github.com/acme/widget' },
          users: [githubUser()],
        };
      },
    } as unknown as GitHubAPI;
    const provider = createGithubForgeProvider(api);

    const result = await provider.searchUsers!('/repo', 'octo', { sourceRepo: 'upstream/widget' });
    expect(receivedDirectory).toBe('/repo');
    expect(receivedQuery).toBe('octo');
    expect(receivedOptions).toEqual({ sourceRepo: { owner: 'upstream', repo: 'widget' } });
    expect(result.connected).toBe(true);
    expect(result.repo?.owner).toBe('acme');
    expect(result.users).toEqual([{
      id: 'octocat',
      login: 'octocat',
      name: 'Octo Cat',
      avatarUrl: 'https://avatars.example/octocat',
    }]);
  });

  test('github passes connected:false through without an authoritative list', async () => {
    const api = {
      searchUsers: async () => ({ connected: false, repo: null, users: [] }),
    } as unknown as GitHubAPI;
    const provider = createGithubForgeProvider(api);

    const result = await provider.searchUsers!('/repo', 'octo');
    expect(result.connected).toBe(false);
    expect(result.users).toEqual([]);
    expect(result.error).toBeFalsy();
  });

  test('github fails closed with an error when searchUsers is missing', async () => {
    const provider = createGithubForgeProvider({} as unknown as GitHubAPI);
    expect(await provider.searchUsers!('/repo', 'octo')).toEqual({
      connected: false,
      repo: null,
      users: [],
      error: 'failed to load',
    });
  });

  test('github fails closed with an error when the wire call throws', async () => {
    const api = {
      searchUsers: async () => { throw new Error('boom'); },
    } as unknown as GitHubAPI;
    const provider = createGithubForgeProvider(api);

    expect(await provider.searchUsers!('/repo', 'octo')).toEqual({
      connected: false,
      repo: null,
      users: [],
      error: 'failed to load',
    });
  });

  test('gitlab parses namespace/project from a multi-segment sourceRepo and maps members', async () => {
    let receivedOptions: { namespace?: string; project?: string } | undefined;
    const api = {
      searchUsers: async (
        _directory: string,
        _query: string,
        options?: { namespace?: string; project?: string },
      ) => {
        receivedOptions = options;
        return { connected: true, repo: null, users: [gitlabUser()] };
      },
    } as unknown as GitLabAPI;
    const provider = createGitlabForgeProvider(api);

    const result = await provider.searchUsers!('/repo', 'gl', { sourceRepo: 'group/sub/proj' });
    expect(receivedOptions).toEqual({ namespace: 'group/sub', project: 'proj' });
    expect(result.connected).toBe(true);
    expect(result.users).toEqual([{
      id: '5',
      login: 'gluser',
      name: 'GL User',
      avatarUrl: 'https://avatars.example/gluser',
      url: 'https://gitlab.example/gluser',
    }]);
  });

  test('gitlab passes connected:false through without an authoritative list', async () => {
    const api = {
      searchUsers: async () => ({ connected: false, repo: null, users: [] }),
    } as unknown as GitLabAPI;
    const provider = createGitlabForgeProvider(api);

    const result = await provider.searchUsers!('/repo', 'gl');
    expect(result.connected).toBe(false);
    expect(result.users).toEqual([]);
    expect(result.error).toBeFalsy();
  });

  test('gitlab fails closed with an error when searchUsers is missing', async () => {
    const provider = createGitlabForgeProvider({} as unknown as GitLabAPI);
    expect(await provider.searchUsers!('/repo', 'gl')).toEqual({
      connected: false,
      repo: null,
      users: [],
      error: 'failed to load',
    });
  });

  test('gitlab fails closed with an error when the wire call throws', async () => {
    const api = {
      searchUsers: async () => { throw new Error('boom'); },
    } as unknown as GitLabAPI;
    const provider = createGitlabForgeProvider(api);

    expect(await provider.searchUsers!('/repo', 'gl')).toEqual({
      connected: false,
      repo: null,
      users: [],
      error: 'failed to load',
    });
  });

  test('gitea parses owner/repo and maps repo assignees', async () => {
    let receivedOptions: { owner?: string; repo?: string } | undefined;
    const api = {
      searchUsers: async (
        _directory: string,
        _query: string,
        options?: { owner?: string; repo?: string },
      ) => {
        receivedOptions = options;
        return { connected: true, repo: null, users: [giteaUser()] };
      },
    } as unknown as GiteaAPI;
    const provider = createGiteaForgeProvider(api);

    const result = await provider.searchUsers!('/repo', 'g', { sourceRepo: 'acme/widget' });
    expect(receivedOptions).toEqual({ owner: 'acme', repo: 'widget' });
    expect(result.connected).toBe(true);
    expect(result.users).toEqual([{
      id: '3',
      login: 'guser',
      name: 'G User',
      avatarUrl: 'https://avatars.example/guser',
      url: 'https://gitea.example/guser',
    }]);
  });

  test('gitea passes connected:false through without an authoritative list', async () => {
    const api = {
      searchUsers: async () => ({ connected: false, repo: null, users: [] }),
    } as unknown as GiteaAPI;
    const provider = createGiteaForgeProvider(api);

    const result = await provider.searchUsers!('/repo', 'g');
    expect(result.connected).toBe(false);
    expect(result.users).toEqual([]);
    expect(result.error).toBeFalsy();
  });

  test('gitea fails closed with an error when searchUsers is missing', async () => {
    const provider = createGiteaForgeProvider({} as unknown as GiteaAPI);
    expect(await provider.searchUsers!('/repo', 'g')).toEqual({
      connected: false,
      repo: null,
      users: [],
      error: 'failed to load',
    });
  });

  test('gitea fails closed with an error when the wire call throws', async () => {
    const api = {
      searchUsers: async () => { throw new Error('boom'); },
    } as unknown as GiteaAPI;
    const provider = createGiteaForgeProvider(api);

    expect(await provider.searchUsers!('/repo', 'g')).toEqual({
      connected: false,
      repo: null,
      users: [],
      error: 'failed to load',
    });
  });
});
