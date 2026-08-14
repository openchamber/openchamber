import { beforeEach, describe, expect, test, vi } from 'vitest';
import express from 'express';
import request from 'supertest';

// The GitHub route handlers lazy-import ./index.js (via getGitHubLibraries)
// for auth + repo resolution, so mocking the module is enough to exercise the
// read routes without real GitHub credentials or a temp data dir.
const mockState = vi.hoisted(() => ({
  getOctokitOrNull: vi.fn(),
  clearGitHubAuth: vi.fn(),
  octokit: {
    rest: {
      pulls: {
        listCommits: vi.fn(),
        get: vi.fn(),
        update: vi.fn(),
        createReview: vi.fn(),
        createReviewComment: vi.fn(),
        listReviewComments: vi.fn(),
        listFiles: vi.fn(),
      },
      issues: {
        listEventsForTimeline: vi.fn(),
        createComment: vi.fn(),
        update: vi.fn(),
        listMilestonesForRepo: vi.fn(),
        listComments: vi.fn(),
      },
    },
  },
}));

vi.mock('./index.js', () => ({
  getOctokitOrNull: mockState.getOctokitOrNull,
  clearGitHubAuth: mockState.clearGitHubAuth,
  resolveGitHubRepoFromDirectory: vi.fn(async () => ({
    repo: { owner: 'owner', repo: 'repo', url: 'https://github.com/owner/repo' },
  })),
}));

const { registerGitHubRoutes } = await import('./routes.js');

const createApp = () => {
  const app = express();
  app.use(express.json());
  registerGitHubRoutes(app);
  return app;
};

beforeEach(() => {
  mockState.getOctokitOrNull.mockReset();
  mockState.clearGitHubAuth.mockReset();
  mockState.octokit.rest.pulls.listCommits.mockReset();
  mockState.octokit.rest.pulls.get.mockReset();
  mockState.octokit.rest.pulls.update.mockReset();
  mockState.octokit.rest.pulls.createReview.mockReset();
  mockState.octokit.rest.pulls.createReviewComment.mockReset();
  mockState.octokit.rest.pulls.listReviewComments.mockReset();
  mockState.octokit.rest.pulls.listFiles.mockReset();
  mockState.octokit.rest.issues.listEventsForTimeline.mockReset();
  mockState.octokit.rest.issues.createComment.mockReset();
  mockState.octokit.rest.issues.update.mockReset();
  mockState.octokit.rest.issues.listMilestonesForRepo.mockReset();
  mockState.octokit.rest.issues.listComments.mockReset();
  mockState.getOctokitOrNull.mockImplementation(() => mockState.octokit);
});

describe('GitHub pull request enrichment routes', () => {
  test('pulls/commits maps commits with shortSha and summary', async () => {
    mockState.octokit.rest.pulls.listCommits.mockResolvedValue({
      data: [
        {
          sha: 'abc123def4567890',
          commit: {
            message: 'Add the API\n\nAdds the public API',
            committer: { date: '2026-01-01T10:00:00Z' },
          },
          author: { login: 'alice', id: 42, avatar_url: 'https://avatars.githubusercontent.com/u/42' },
          committer: null,
          parents: [{ sha: 'parent-one' }],
        },
      ],
    });

    const app = createApp();
    const response = await request(app).get('/api/github/pulls/commits?directory=%2Ftmp%2Fwork&number=9');

    expect(response.status).toBe(200);
    expect(response.body).toMatchObject({
      connected: true,
      repo: { owner: 'owner', repo: 'repo' },
      commits: [
        {
          sha: 'abc123def4567890',
          shortSha: 'abc123d',
          message: 'Add the API\n\nAdds the public API',
          summary: 'Add the API',
          author: { login: 'alice', id: 42, avatarUrl: 'https://avatars.githubusercontent.com/u/42' },
          committer: null,
          committedAt: '2026-01-01T10:00:00Z',
          parents: ['parent-one'],
        },
      ],
    });
    expect(mockState.octokit.rest.pulls.listCommits).toHaveBeenCalledWith({
      owner: 'owner',
      repo: 'repo',
      pull_number: 9,
      per_page: 100,
    });
  });

  test('pulls/timeline maps timeline events with lowercased types', async () => {
    mockState.octokit.rest.issues.listEventsForTimeline.mockResolvedValue({
      data: [
        { id: 1, event: 'committed', actor: { login: 'alice', id: 42, avatar_url: 'u' }, created_at: '2026-01-01T10:00:00Z', commit_id: 'abc123def4567890' },
        { id: 2, event: 'CLOSED', actor: { login: 'alice', id: 42, avatar_url: 'u' }, created_at: '2026-01-02T10:00:00Z' },
        { id: 3, event: 'reviewed', actor: null, created_at: '2026-01-03T10:00:00Z', body: 'LGTM' },
      ],
    });

    const app = createApp();
    const response = await request(app).get('/api/github/pulls/timeline?directory=%2Ftmp%2Fwork&number=9');

    expect(response.status).toBe(200);
    expect(response.body).toMatchObject({
      connected: true,
      events: [
        { id: '1', type: 'committed', author: { login: 'alice', id: 42 }, createdAt: '2026-01-01T10:00:00Z', commitSha: 'abc123def4567890' },
        { id: '2', type: 'closed', author: { login: 'alice', id: 42 } },
        { id: '3', type: 'reviewed', author: null, body: 'LGTM' },
      ],
    });
    expect(mockState.octokit.rest.issues.listEventsForTimeline).toHaveBeenCalledWith({
      owner: 'owner',
      repo: 'repo',
      issue_number: 9,
      per_page: 100,
    });
  });

  test('pulls/commits returns connected:false when not authenticated', async () => {
    mockState.getOctokitOrNull.mockImplementation(() => null);

    const app = createApp();
    const response = await request(app).get('/api/github/pulls/commits?directory=%2Ftmp%2Fwork&number=9');

    expect(response.status).toBe(200);
    expect(response.body).toEqual({ connected: false });
  });

  test('pulls/commits requires directory and number', async () => {
    const app = createApp();
    const response = await request(app).get('/api/github/pulls/commits?directory=%2Ftmp%2Fwork');
    expect(response.status).toBe(400);
    expect(response.body).toEqual({ error: 'directory and number are required' });
  });
});

describe('GitHub write routes', () => {
  test('issues/comment creates a comment and returns the envelope', async () => {
    mockState.octokit.rest.issues.createComment.mockResolvedValue({
      data: {
        id: 1001,
        html_url: 'https://github.com/owner/repo/issues/7#issuecomment-1001',
        body: 'Hello',
        created_at: '2026-01-01T10:00:00Z',
        updated_at: '2026-01-01T10:00:00Z',
        user: { login: 'alice', id: 42, avatar_url: 'https://avatars.githubusercontent.com/u/42' },
      },
    });

    const app = createApp();
    const response = await request(app)
      .post('/api/github/issues/comment')
      .send({ directory: '/tmp/work', number: 7, body: 'Hello' });

    expect(response.status).toBe(200);
    expect(response.body).toMatchObject({
      connected: true,
      repo: { owner: 'owner', repo: 'repo' },
      comment: {
        id: 1001,
        url: 'https://github.com/owner/repo/issues/7#issuecomment-1001',
        body: 'Hello',
        createdAt: '2026-01-01T10:00:00Z',
        author: { login: 'alice', id: 42, avatarUrl: 'https://avatars.githubusercontent.com/u/42' },
      },
    });
    expect(mockState.octokit.rest.issues.createComment).toHaveBeenCalledWith({
      owner: 'owner',
      repo: 'repo',
      issue_number: 7,
      body: 'Hello',
    });
  });

  test('issues/comment returns connected:false when not authenticated', async () => {
    mockState.getOctokitOrNull.mockImplementation(() => null);

    const app = createApp();
    const response = await request(app)
      .post('/api/github/issues/comment')
      .send({ directory: '/tmp/work', number: 7, body: 'Hello' });

    expect(response.status).toBe(200);
    expect(response.body).toEqual({ connected: false });
  });

  test('issues/comment requires directory, number, and body', async () => {
    const app = createApp();
    const response = await request(app)
      .post('/api/github/issues/comment')
      .send({ directory: '/tmp/work', number: 7 });

    expect(response.status).toBe(400);
    expect(response.body).toEqual({ error: 'directory, number, body are required' });
  });

  test('issues/update passes state and labels through', async () => {
    mockState.octokit.rest.issues.update.mockResolvedValue({
      data: {
        number: 7,
        title: 'Bug',
        body: 'desc',
        html_url: 'https://github.com/owner/repo/issues/7',
        state: 'closed',
        created_at: '2026-01-01T10:00:00Z',
        updated_at: '2026-01-02T10:00:00Z',
        user: { login: 'alice', id: 42, avatar_url: 'u' },
        labels: [{ name: 'bug', color: 'd73a4a' }],
        assignees: [{ login: 'bob', id: 43, avatar_url: 'u' }],
        milestone: { title: 'v1.0', state: 'open' },
        comments: 3,
      },
    });

    const app = createApp();
    const response = await request(app)
      .patch('/api/github/issues/update')
      .send({ directory: '/tmp/work', number: 7, state: 'closed', labels: ['bug'] });

    expect(response.status).toBe(200);
    expect(response.body).toMatchObject({
      connected: true,
      repo: { owner: 'owner', repo: 'repo' },
      issue: {
        number: 7,
        title: 'Bug',
        state: 'closed',
        labels: [{ name: 'bug', color: 'd73a4a' }],
        assignees: [{ login: 'bob', id: 43 }],
        milestone: { title: 'v1.0', state: 'open' },
        commentsCount: 3,
      },
    });
    expect(mockState.octokit.rest.issues.update).toHaveBeenCalledWith({
      owner: 'owner',
      repo: 'repo',
      issue_number: 7,
      state: 'closed',
      labels: ['bug'],
    });
  });

  test('issues/update resolves milestone title to a number (case-insensitive)', async () => {
    mockState.octokit.rest.issues.listMilestonesForRepo.mockResolvedValue({
      data: [{ number: 5, title: 'v1.0', state: 'open' }],
    });
    mockState.octokit.rest.issues.update.mockResolvedValue({
      data: { number: 7, title: 'Bug', html_url: 'u', state: 'open', user: null, labels: [], assignees: [], milestone: null, body: '' },
    });

    const app = createApp();
    const response = await request(app)
      .patch('/api/github/issues/update')
      .send({ directory: '/tmp/work', number: 7, milestone: 'V1.0' });

    expect(response.status).toBe(200);
    expect(mockState.octokit.rest.issues.listMilestonesForRepo).toHaveBeenCalledWith({
      owner: 'owner',
      repo: 'repo',
      state: 'all',
      per_page: 100,
    });
    expect(mockState.octokit.rest.issues.update).toHaveBeenCalledWith(
      expect.objectContaining({ milestone: 5 })
    );
  });

  test('issues/update returns 400 when the milestone title matches nothing', async () => {
    mockState.octokit.rest.issues.listMilestonesForRepo.mockResolvedValue({ data: [] });

    const app = createApp();
    const response = await request(app)
      .patch('/api/github/issues/update')
      .send({ directory: '/tmp/work', number: 7, milestone: 'nope' });

    expect(response.status).toBe(400);
    expect(response.body).toEqual({ error: 'Milestone not found' });
    expect(mockState.octokit.rest.issues.update).not.toHaveBeenCalled();
  });

  test('issues/update passes milestone null through to clear it', async () => {
    mockState.octokit.rest.issues.update.mockResolvedValue({
      data: { number: 7, title: 'Bug', html_url: 'u', state: 'open', user: null, labels: [], assignees: [], milestone: null, body: '' },
    });

    const app = createApp();
    const response = await request(app)
      .patch('/api/github/issues/update')
      .send({ directory: '/tmp/work', number: 7, milestone: null });

    expect(response.status).toBe(200);
    expect(mockState.octokit.rest.issues.listMilestonesForRepo).not.toHaveBeenCalled();
    expect(mockState.octokit.rest.issues.update).toHaveBeenCalledWith(
      expect.objectContaining({ milestone: null })
    );
  });

  test('pulls/comment posts to the PR issue thread', async () => {
    mockState.octokit.rest.issues.createComment.mockResolvedValue({
      data: {
        id: 2001,
        html_url: 'https://github.com/owner/repo/pull/9#issuecomment-2001',
        body: 'Thanks',
        created_at: '2026-01-01T10:00:00Z',
        updated_at: '2026-01-01T10:00:00Z',
        user: { login: 'alice', id: 42, avatar_url: 'u' },
      },
    });

    const app = createApp();
    const response = await request(app)
      .post('/api/github/pulls/comment')
      .send({ directory: '/tmp/work', number: 9, body: 'Thanks' });

    expect(response.status).toBe(200);
    expect(response.body).toMatchObject({
      connected: true,
      comment: { id: 2001, body: 'Thanks', author: { login: 'alice', id: 42 } },
    });
    expect(mockState.octokit.rest.issues.createComment).toHaveBeenCalledWith({
      owner: 'owner',
      repo: 'repo',
      issue_number: 9,
      body: 'Thanks',
    });
  });

  test('pulls/review-comment creates a reply when inReplyToId is provided', async () => {
    mockState.octokit.rest.pulls.createReviewComment.mockResolvedValue({
      data: {
        id: 3001,
        html_url: 'u',
        body: 'reply',
        path: 'src/a.ts',
        line: 3,
        position: null,
        created_at: '2026-01-01T10:00:00Z',
        updated_at: '2026-01-01T10:00:00Z',
        user: { login: 'alice', id: 42, avatar_url: 'u' },
      },
    });

    const app = createApp();
    const response = await request(app)
      .post('/api/github/pulls/review-comment')
      .send({ directory: '/tmp/work', number: 9, body: 'reply', inReplyToId: 2999 });

    expect(response.status).toBe(200);
    expect(response.body).toMatchObject({
      connected: true,
      comment: { id: 3001, body: 'reply', path: 'src/a.ts', line: 3 },
    });
    expect(mockState.octokit.rest.pulls.createReviewComment).toHaveBeenCalledWith({
      owner: 'owner',
      repo: 'repo',
      pull_number: 9,
      body: 'reply',
      in_reply_to_id: 2999,
    });
    expect(mockState.octokit.rest.pulls.get).not.toHaveBeenCalled();
  });

  test('pulls/review-comment resolves the PR head sha for a new inline comment', async () => {
    mockState.octokit.rest.pulls.get.mockResolvedValue({ data: { head: { sha: 'abc123def4567890' } } });
    mockState.octokit.rest.pulls.createReviewComment.mockResolvedValue({
      data: {
        id: 3002,
        html_url: 'u',
        body: 'nit',
        path: 'src/a.ts',
        line: 5,
        position: 1,
        created_at: '2026-01-01T10:00:00Z',
        updated_at: '2026-01-01T10:00:00Z',
        user: { login: 'alice', id: 42, avatar_url: 'u' },
      },
    });

    const app = createApp();
    const response = await request(app)
      .post('/api/github/pulls/review-comment')
      .send({ directory: '/tmp/work', number: 9, body: 'nit', path: 'src/a.ts', line: 5 });

    expect(response.status).toBe(200);
    expect(response.body).toMatchObject({
      connected: true,
      comment: { id: 3002, body: 'nit', path: 'src/a.ts', line: 5, position: 1 },
    });
    expect(mockState.octokit.rest.pulls.get).toHaveBeenCalledWith({
      owner: 'owner',
      repo: 'repo',
      pull_number: 9,
    });
    expect(mockState.octokit.rest.pulls.createReviewComment).toHaveBeenCalledWith({
      owner: 'owner',
      repo: 'repo',
      pull_number: 9,
      body: 'nit',
      commit_id: 'abc123def4567890',
      path: 'src/a.ts',
      line: 5,
    });
  });

  test('pulls/review-comment requires path and line for a new inline comment', async () => {
    const app = createApp();
    const response = await request(app)
      .post('/api/github/pulls/review-comment')
      .send({ directory: '/tmp/work', number: 9, body: 'nit' });

    expect(response.status).toBe(400);
    expect(response.body).toEqual({ error: 'path and line are required for a new review comment' });
    expect(mockState.octokit.rest.pulls.createReviewComment).not.toHaveBeenCalled();
  });

  test('pulls/review maps the submitted review and invalidates the PR context cache', async () => {
    mockState.octokit.rest.pulls.get.mockResolvedValue({
      data: {
        number: 9,
        title: 'T',
        body: '',
        html_url: 'u',
        state: 'open',
        draft: false,
        base: { ref: 'main' },
        head: { ref: 'feature' },
        user: { login: 'alice', id: 42, avatar_url: 'u' },
      },
    });
    mockState.octokit.rest.issues.listComments.mockResolvedValue({ data: [] });
    mockState.octokit.rest.pulls.listReviewComments.mockResolvedValue({ data: [] });
    mockState.octokit.rest.pulls.listFiles.mockResolvedValue({ data: [] });

    const app = createApp();
    await request(app).get('/api/github/pulls/context?directory=%2Ftmp%2Fwork&number=9');
    const pullsGetCallsAfterContext = mockState.octokit.rest.pulls.get.mock.calls.length;

    mockState.octokit.rest.pulls.createReview.mockResolvedValue({
      data: {
        id: 4001,
        state: 'APPROVED',
        submitted_at: '2026-01-01T10:00:00Z',
        body: 'LGTM',
        commit_id: 'abc123def4567890',
        user: { login: 'alice', id: 42, avatar_url: 'u' },
      },
    });

    const reviewResponse = await request(app)
      .post('/api/github/pulls/review')
      .send({ directory: '/tmp/work', number: 9, event: 'APPROVE', body: 'LGTM' });

    expect(reviewResponse.status).toBe(200);
    expect(reviewResponse.body).toMatchObject({
      connected: true,
      repo: { owner: 'owner', repo: 'repo' },
      review: {
        id: '4001',
        state: 'APPROVED',
        submittedAt: '2026-01-01T10:00:00Z',
        body: 'LGTM',
        commitSha: 'abc123def4567890',
        author: { login: 'alice', id: 42 },
      },
    });
    expect(mockState.octokit.rest.pulls.createReview).toHaveBeenCalledWith({
      owner: 'owner',
      repo: 'repo',
      pull_number: 9,
      event: 'APPROVE',
      body: 'LGTM',
    });

    // The PR context cache must have been invalidated: the next context fetch
    // re-resolves the PR instead of serving the cached copy.
    await request(app).get('/api/github/pulls/context?directory=%2Ftmp%2Fwork&number=9');
    expect(mockState.octokit.rest.pulls.get.mock.calls.length).toBe(pullsGetCallsAfterContext + 1);
  });

  test('pulls/review requires directory, number, and event', async () => {
    const app = createApp();
    const response = await request(app)
      .post('/api/github/pulls/review')
      .send({ directory: '/tmp/work', number: 9 });

    expect(response.status).toBe(400);
    expect(response.body).toEqual({ error: 'directory, number, event are required' });
  });

  test('pr/update branches to issues.update and applies draft via pulls.update', async () => {
    mockState.octokit.rest.issues.update.mockResolvedValue({
      data: {
        number: 9,
        title: 'T',
        body: '',
        html_url: 'u',
        state: 'open',
        draft: false,
        base: { ref: 'main' },
        head: { ref: 'feature' },
        mergeable: true,
        mergeable_state: 'clean',
        user: null,
        labels: [{ name: 'bug', color: 'd73a4a' }],
        assignees: [],
        milestone: null,
      },
    });
    mockState.octokit.rest.pulls.update.mockResolvedValue({
      data: {
        number: 9,
        title: 'T',
        body: '',
        html_url: 'u',
        state: 'open',
        draft: true,
        base: { ref: 'main' },
        head: { ref: 'feature' },
        mergeable: true,
        mergeable_state: 'clean',
        user: null,
        labels: [{ name: 'bug', color: 'd73a4a' }],
        assignees: [],
        milestone: null,
      },
    });

    const app = createApp();
    const response = await request(app)
      .post('/api/github/pr/update')
      .send({
        directory: '/tmp/work',
        number: 9,
        title: 'T',
        state: 'closed',
        draft: true,
        labels: ['bug'],
        assignees: ['alice'],
        milestone: null,
      });

    expect(response.status).toBe(200);
    expect(response.body).toMatchObject({ number: 9, state: 'open', draft: true });
    expect(mockState.octokit.rest.issues.update).toHaveBeenCalledWith(
      expect.objectContaining({
        owner: 'owner',
        repo: 'repo',
        issue_number: 9,
        state: 'closed',
        labels: ['bug'],
        assignees: ['alice'],
        milestone: null,
      })
    );
    expect(mockState.octokit.rest.pulls.update).toHaveBeenCalledWith({
      owner: 'owner',
      repo: 'repo',
      pull_number: 9,
      draft: true,
    });
  });

  test('pr/update keeps title/body on pulls.update when no extended fields are present', async () => {
    mockState.octokit.rest.pulls.update.mockResolvedValue({
      data: {
        number: 9,
        title: 'New title',
        body: '',
        html_url: 'u',
        state: 'open',
        draft: false,
        base: { ref: 'main' },
        head: { ref: 'feature' },
        mergeable: true,
        mergeable_state: 'clean',
        user: null,
      },
    });

    const app = createApp();
    const response = await request(app)
      .post('/api/github/pr/update')
      .send({ directory: '/tmp/work', number: 9, title: 'New title' });

    expect(response.status).toBe(200);
    expect(mockState.octokit.rest.pulls.update).toHaveBeenCalledWith({
      owner: 'owner',
      repo: 'repo',
      pull_number: 9,
      title: 'New title',
    });
    expect(mockState.octokit.rest.issues.update).not.toHaveBeenCalled();
  });

  test('pr/update returns 400 when the milestone title matches nothing', async () => {
    mockState.octokit.rest.issues.listMilestonesForRepo.mockResolvedValue({ data: [] });

    const app = createApp();
    const response = await request(app)
      .post('/api/github/pr/update')
      .send({ directory: '/tmp/work', number: 9, title: 'T', milestone: 'nope' });

    expect(response.status).toBe(400);
    expect(response.body).toEqual({ error: 'Milestone not found' });
    expect(mockState.octokit.rest.issues.update).not.toHaveBeenCalled();
  });
});
