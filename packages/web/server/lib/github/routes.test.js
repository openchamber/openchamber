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
      pulls: { listCommits: vi.fn() },
      issues: { listEventsForTimeline: vi.fn() },
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
  mockState.octokit.rest.issues.listEventsForTimeline.mockReset();
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
