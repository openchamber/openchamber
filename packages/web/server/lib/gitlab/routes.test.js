import fs from 'fs';
import os from 'os';
import path from 'path';
import { afterAll, beforeEach, describe, expect, test, vi } from 'vitest';
import express from 'express';
import request from 'supertest';

const TEMP_DATA_DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'openchamber-gitlab-routes-'));
process.env.OPENCHAMBER_DATA_DIR = TEMP_DATA_DIR;

// Resolve a fake git remote so directory-based repo resolution finds a GitLab
// repo without touching the real filesystem/git.
vi.mock('../git/index.js', () => ({
  getRemoteUrl: vi.fn(async () => 'git@gitlab.com:group/sub.git'),
}));

const { registerGitLabRoutes } = await import('./routes.js');
const { setGitLabAuth, clearGitLabAuth, getGitLabAuth, getGitLabAuthAccounts, GITLAB_AUTH_FILE } = await import('./index.js');

afterAll(() => {
  fs.rmSync(TEMP_DATA_DIR, { recursive: true, force: true });
});

// clearGitLabAuth only drops the *current* account (multi-account model), so a
// full wipe is done by removing the auth file between tests.
const resetAuthFile = () => {
  if (fs.existsSync(GITLAB_AUTH_FILE)) {
    fs.unlinkSync(GITLAB_AUTH_FILE);
  }
};

const aliceUser = {
  id: 42,
  username: 'alice',
  name: 'Alice Example',
  state: 'active',
  avatar_url: 'https://gitlab.com/uploads/-/avatar.png',
  web_url: 'https://gitlab.com/alice',
  email: 'alice@example.com',
};

const jsonResponse = (data, { status = 200, headers = {} } = {}) =>
  new Response(JSON.stringify(data), { status, headers: { 'content-type': 'application/json', ...headers } });

const scriptedFetch = (handlers) => {
  const fetchMock = vi.fn(async (url, options) => {
    const str = String(url);
    for (const handler of handlers) {
      const result = handler(str, options);
      if (result !== null && result !== undefined) {
        return result;
      }
    }
    return jsonResponse({ message: `unhandled request: ${str}` }, { status: 500 });
  });
  globalThis.fetch = fetchMock;
  return fetchMock;
};

const matches = (pattern) => (url) => pattern.test(url);

const createApp = () => {
  const app = express();
  app.use(express.json());
  registerGitLabRoutes(app);
  return app;
};

describe('GitLab auth routes', () => {
  beforeEach(() => {
    resetAuthFile();
    vi.restoreAllMocks();
    delete globalThis.fetch;
  });

  test('auth/status returns disconnected with the default base URL', async () => {
    const app = createApp();
    const response = await request(app).get('/api/gitlab/auth/status');
    expect(response.status).toBe(200);
    expect(response.body).toEqual({
      connected: false,
      accounts: [],
      defaultBaseUrl: 'https://gitlab.com',
    });
  });

  test('auth/connect validates the token, stores the account, and reports connected', async () => {
    scriptedFetch([(url) => (matches(/\/api\/v4\/user$/)(url) ? jsonResponse(aliceUser) : null)]);

    const app = createApp();
    const response = await request(app)
      .post('/api/gitlab/auth/connect')
      .send({ accessToken: 'glpat-valid', baseUrl: 'https://gitlab.com' });

    expect(response.status).toBe(200);
    expect(response.body).toMatchObject({
      connected: true,
      user: { username: 'alice', id: 42, name: 'Alice Example', avatarUrl: 'https://gitlab.com/uploads/-/avatar.png', email: 'alice@example.com' },
      defaultBaseUrl: 'https://gitlab.com',
    });
    expect(response.body.accounts).toEqual([
      { id: 'gitlab.com:alice', user: { username: 'alice', name: 'Alice Example', avatarUrl: 'https://gitlab.com/uploads/-/avatar.png', webUrl: 'https://gitlab.com/alice' }, baseUrl: 'https://gitlab.com', current: true },
    ]);
    expect(getGitLabAuth()?.accessToken).toBe('glpat-valid');
  });

  test('auth/connect rejects an invalid token with 400', async () => {
    scriptedFetch([(url) => (matches(/\/api\/v4\/user$/)(url) ? jsonResponse({ message: '401 Unauthorized' }, { status: 401 }) : null)]);

    const app = createApp();
    const response = await request(app)
      .post('/api/gitlab/auth/connect')
      .send({ accessToken: 'glpat-invalid' });

    expect(response.status).toBe(400);
    expect(response.body).toEqual({ error: 'Invalid GitLab access token' });
    expect(getGitLabAuth()).toBeNull();
  });

  test('auth/connect requires an access token', async () => {
    const app = createApp();
    const response = await request(app).post('/api/gitlab/auth/connect').send({});
    expect(response.status).toBe(400);
    expect(response.body).toEqual({ error: 'accessToken is required' });
  });

  test('auth/connect normalizes a scheme-less base URL', async () => {
    const fetchMock = scriptedFetch([(url) => (matches(/\/api\/v4\/user$/)(url) ? jsonResponse(aliceUser) : null)]);

    const app = createApp();
    await request(app)
      .post('/api/gitlab/auth/connect')
      .send({ accessToken: 'glpat-valid', baseUrl: 'gitlab.example.com' });

    expect(fetchMock.mock.calls[0][0]).toBe('https://gitlab.example.com/api/v4/user');
  });

  test('auth/status reports connected with the live user', async () => {
    setGitLabAuth({ accessToken: 'glpat-a', baseUrl: 'gitlab.com', user: aliceUser });
    scriptedFetch([(url) => (matches(/\/api\/v4\/user$/)(url) ? jsonResponse(aliceUser) : null)]);

    const app = createApp();
    const response = await request(app).get('/api/gitlab/auth/status');
    expect(response.status).toBe(200);
    expect(response.body).toMatchObject({
      connected: true,
      user: { username: 'alice', id: 42 },
      defaultBaseUrl: 'https://gitlab.com',
    });
    expect(response.body.accounts).toEqual([
      { id: 'gitlab.com:alice', user: { username: 'alice', name: 'Alice Example', avatarUrl: 'https://gitlab.com/uploads/-/avatar.png', webUrl: 'https://gitlab.com/alice' }, baseUrl: 'https://gitlab.com', current: true },
    ]);
  });

  test('auth/activate returns 404 for an unknown account', async () => {
    const app = createApp();
    const response = await request(app).post('/api/gitlab/auth/activate').send({ accountId: 'gitlab.com:nobody' });
    expect(response.status).toBe(404);
    expect(response.body).toEqual({ error: 'GitLab account not found' });
  });

  test('auth/activate switches the current account', async () => {
    setGitLabAuth({ accessToken: 'glpat-a', baseUrl: 'gitlab.com', user: aliceUser });
    setGitLabAuth({
      accessToken: 'glpat-b',
      baseUrl: 'https://gitlab.example.com',
      user: { ...aliceUser, username: 'bob', name: 'Bob' },
    });
    scriptedFetch([(url) => (matches(/\/api\/v4\/user$/)(url) ? jsonResponse(aliceUser) : null)]);

    const app = createApp();
    const response = await request(app).post('/api/gitlab/auth/activate').send({ accountId: 'gitlab.com:alice' });
    expect(response.status).toBe(200);
    expect(response.body.connected).toBe(true);
    expect(response.body.accounts.find((a) => a.id === 'gitlab.com:alice')?.current).toBe(true);
    expect(getGitLabAuth()?.accountId).toBe('gitlab.com:alice');
  });

  test('DELETE /api/gitlab/auth clears the account', async () => {
    setGitLabAuth({ accessToken: 'glpat-a', baseUrl: 'gitlab.com', user: aliceUser });
    const app = createApp();
    const response = await request(app).delete('/api/gitlab/auth');
    expect(response.status).toBe(200);
    expect(response.body).toEqual({ removed: true });
    expect(getGitLabAuth()).toBeNull();
  });

  test('me returns 401 when not connected', async () => {
    const app = createApp();
    const response = await request(app).get('/api/gitlab/me');
    expect(response.status).toBe(401);
    expect(response.body).toEqual({ error: 'GitLab not connected' });
  });

  test('me returns the connected user', async () => {
    setGitLabAuth({ accessToken: 'glpat-a', baseUrl: 'gitlab.com', user: aliceUser });
    scriptedFetch([(url) => (matches(/\/api\/v4\/user$/)(url) ? jsonResponse(aliceUser) : null)]);

    const app = createApp();
    const response = await request(app).get('/api/gitlab/me');
    expect(response.status).toBe(200);
    expect(response.body).toEqual({
      username: 'alice',
      id: 42,
      name: 'Alice Example',
      avatarUrl: 'https://gitlab.com/uploads/-/avatar.png',
      webUrl: 'https://gitlab.com/alice',
      email: 'alice@example.com',
    });
  });
});

describe('GitLab data routes', () => {
  beforeEach(() => {
    resetAuthFile();
    setGitLabAuth({ accessToken: 'glpat-a', baseUrl: 'gitlab.com', user: aliceUser });
    vi.restoreAllMocks();
    delete globalThis.fetch;
  });

  test('issues/list returns mapped issues with pagination info', async () => {
    scriptedFetch([
      (url) => (matches(/\/api\/v4\/projects\/group%2Fsub\/issues\?/)(url)
        ? jsonResponse(
          [
            {
              iid: 3,
              title: 'Fix the widget',
              web_url: 'https://gitlab.com/group/sub/-/issues/3',
              state: 'opened',
              author: { id: 42, username: 'alice', name: 'Alice Example', avatar_url: 'https://gitlab.com/alice.png' },
              labels: ['bug', 'priority:high'],
            },
          ],
          { headers: { 'x-page': '1', 'x-next-page': '2', 'x-total-pages': '2' } },
        )
        : null),
    ]);

    const app = createApp();
    const response = await request(app).get('/api/gitlab/issues/list?directory=%2Ftmp%2Fwork&page=1');

    expect(response.status).toBe(200);
    expect(response.body).toMatchObject({
      connected: true,
      repo: { namespace: 'group', project: 'sub', host: 'gitlab.com', url: 'https://gitlab.com/group/sub' },
      issues: [
        {
          number: 3,
          title: 'Fix the widget',
          url: 'https://gitlab.com/group/sub/-/issues/3',
          state: 'opened',
          author: { username: 'alice', name: 'Alice Example', avatarUrl: 'https://gitlab.com/alice.png' },
          labels: ['bug', 'priority:high'],
        },
      ],
      page: 1,
      hasMore: true,
    });
  });

  test('issues/list sends the search query and opened state filter', async () => {
    const fetchMock = scriptedFetch([(url) => (matches(/\/issues\?/)(url) ? jsonResponse([]) : null)]);

    const app = createApp();
    await request(app).get('/api/gitlab/issues/list?directory=%2Ftmp%2Fwork&query=login');

    const requestedUrl = String(fetchMock.mock.calls[0][0]);
    expect(requestedUrl).toContain('state=opened');
    expect(requestedUrl).toContain('search=login');
    expect(requestedUrl).toContain('per_page=50');
  });

  test('issues/list reports connected:false when not authenticated', async () => {
    clearGitLabAuth();
    const app = createApp();
    const response = await request(app).get('/api/gitlab/issues/list?directory=%2Ftmp%2Fwork');
    expect(response.status).toBe(200);
    expect(response.body).toMatchObject({ connected: false, issues: [] });
  });

  test('issues/get returns a full issue', async () => {
    scriptedFetch([
      (url) => (matches(/\/issues\/7$/)(url)
        ? jsonResponse({
          iid: 7,
          title: 'Broken import',
          web_url: 'https://gitlab.com/group/sub/-/issues/7',
          state: 'opened',
          description: 'It breaks at startup',
          created_at: '2026-01-01T10:00:00Z',
          updated_at: '2026-01-02T10:00:00Z',
          author: { id: 42, username: 'alice', name: 'Alice Example', avatar_url: 'https://gitlab.com/alice.png' },
          assignees: [{ id: 43, username: 'bob', name: 'Bob', avatar_url: 'https://gitlab.com/bob.png' }],
          labels: ['bug'],
        })
        : null),
    ]);

    const app = createApp();
    const response = await request(app).get('/api/gitlab/issues/get?directory=%2Ftmp%2Fwork&number=7');

    expect(response.status).toBe(200);
    expect(response.body).toMatchObject({
      connected: true,
      issue: {
        number: 7,
        title: 'Broken import',
        state: 'opened',
        body: 'It breaks at startup',
        createdAt: '2026-01-01T10:00:00Z',
        updatedAt: '2026-01-02T10:00:00Z',
        author: { username: 'alice', name: 'Alice Example' },
        assignees: [{ username: 'bob', name: 'Bob' }],
        labels: ['bug'],
      },
    });
  });

  test('issues/get returns 404 for a missing issue', async () => {
    scriptedFetch([(url) => (matches(/\/issues\/999$/)(url) ? jsonResponse({ message: 'Not found' }, { status: 404 }) : null)]);

    const app = createApp();
    const response = await request(app).get('/api/gitlab/issues/get?directory=%2Ftmp%2Fwork&number=999');
    expect(response.status).toBe(404);
    expect(response.body).toEqual({ error: 'Issue not found' });
  });

  test('issues/comments skips system notes and links notes to the issue URL', async () => {
    scriptedFetch([
      (url) => (matches(/\/issues\/7$/)(url)
        ? jsonResponse({ iid: 7, web_url: 'https://gitlab.com/group/sub/-/issues/7' })
        : null),
      (url) => (matches(/\/issues\/7\/notes\?/)(url)
        ? jsonResponse([
          { id: 1, body: 'system note', system: true, author: { id: 1, username: 'system' }, created_at: '2026-01-01T00:00:00Z' },
          { id: 2, body: 'Looks good to me', system: false, author: { id: 42, username: 'alice', name: 'Alice Example' }, created_at: '2026-01-01T01:00:00Z' },
        ])
        : null),
    ]);

    const app = createApp();
    const response = await request(app).get('/api/gitlab/issues/comments?directory=%2Ftmp%2Fwork&number=7');

    expect(response.status).toBe(200);
    expect(response.body.comments).toEqual([
      {
        id: 2,
        url: 'https://gitlab.com/group/sub/-/issues/7#note_2',
        body: 'Looks good to me',
        createdAt: '2026-01-01T01:00:00Z',
        updatedAt: undefined,
        author: { username: 'alice', name: 'Alice Example', avatarUrl: null, id: 42 },
      },
    ]);
  });

  test('mrs/list returns mapped merge requests', async () => {
    scriptedFetch([
      (url) => (matches(/\/merge_requests\?/)(url)
        ? jsonResponse([
          {
            iid: 9,
            title: 'Add the API',
            web_url: 'https://gitlab.com/group/sub/-/merge_requests/9',
            state: 'opened',
            draft: false,
            work_in_progress: false,
            author: { id: 42, username: 'alice', name: 'Alice Example', avatar_url: 'https://gitlab.com/alice.png' },
            source_branch: 'feat/api',
            target_branch: 'main',
          },
        ])
        : null),
    ]);

    const app = createApp();
    const response = await request(app).get('/api/gitlab/mrs/list?directory=%2Ftmp%2Fwork');

    expect(response.status).toBe(200);
    expect(response.body).toMatchObject({
      connected: true,
      mrs: [
        {
          number: 9,
          title: 'Add the API',
          state: 'opened',
          draft: false,
          author: { username: 'alice', name: 'Alice Example' },
          sourceBranch: 'feat/api',
          targetBranch: 'main',
        },
      ],
      page: 1,
      hasMore: false,
    });
  });

  test('mrs/context returns mr, comments, files, and a concatenated diff', async () => {
    scriptedFetch([
      (url) => (matches(/\/merge_requests\/9$/)(url)
        ? jsonResponse({
          iid: 9,
          title: 'Add the API',
          web_url: 'https://gitlab.com/group/sub/-/merge_requests/9',
          state: 'opened',
          draft: false,
          description: 'Adds the public API',
          created_at: '2026-01-01T10:00:00Z',
          updated_at: '2026-01-02T10:00:00Z',
          author: { id: 42, username: 'alice', name: 'Alice Example', avatar_url: 'https://gitlab.com/alice.png' },
          source_branch: 'feat/api',
          target_branch: 'main',
          sha: 'abc123def456',
        })
        : null),
      (url) => (matches(/\/merge_requests\/9\/notes\?/)(url)
        ? jsonResponse([
          { id: 11, body: 'LGTM', system: false, author: { id: 43, username: 'bob', name: 'Bob' }, created_at: '2026-01-02T11:00:00Z' },
        ])
        : null),
      (url) => (matches(/\/merge_requests\/9\/diffs\?/)(url)
        ? jsonResponse([
          {
            old_path: 'src/a.ts',
            new_path: 'src/a.ts',
            new_file: false,
            renamed_file: false,
            deleted_file: false,
            diff: '--- a/src/a.ts\n+++ b/src/a.ts\n@@ -1,3 +1,4 @@\n import x\n+export const added = 1\n-export const old = 2\n context line\n',
          },
          {
            old_path: 'src/new.ts',
            new_path: 'src/new.ts',
            new_file: true,
            renamed_file: false,
            deleted_file: false,
            diff: '--- a/src/new.ts\n+++ b/src/new.ts\n@@ -0,0 +1,2 @@\n+line one\n+line two\n',
          },
        ])
        : null),
    ]);

    const app = createApp();
    const response = await request(app).get('/api/gitlab/mrs/context?directory=%2Ftmp%2Fwork&number=9&diff=1');

    expect(response.status).toBe(200);
    expect(response.body).toMatchObject({
      connected: true,
      mr: {
        number: 9,
        title: 'Add the API',
        state: 'opened',
        draft: false,
        body: 'Adds the public API',
        sourceBranch: 'feat/api',
        targetBranch: 'main',
        headSha: 'abc123def456',
      },
      comments: [{ id: 11, body: 'LGTM', author: { username: 'bob', name: 'Bob' } }],
      files: [
        { filename: 'src/a.ts', status: 'modified', additions: 1, deletions: 1, changes: 2 },
        { filename: 'src/new.ts', status: 'added', additions: 2, deletions: 0, changes: 2 },
      ],
    });
    // diff field concatenates the two patches
    expect(response.body.diff).toContain('export const added = 1');
    expect(response.body.diff).toContain('line two');
  });

  test('repo/branches returns branch names', async () => {
    scriptedFetch([
      (url) => (matches(/\/repository\/branches\?/)(url)
        ? jsonResponse([{ name: 'main' }, { name: 'feat/api' }])
        : null),
    ]);

    const app = createApp();
    const response = await request(app).get('/api/gitlab/repo/branches?namespace=group&project=sub');
    expect(response.status).toBe(200);
    expect(response.body).toEqual({ branches: ['main', 'feat/api'] });
  });

  test('repo/branches requires namespace and project', async () => {
    const app = createApp();
    const response = await request(app).get('/api/gitlab/repo/branches?namespace=group');
    expect(response.status).toBe(400);
    expect(response.body).toEqual({ error: 'namespace and project are required' });
  });

  test('data routes surface a 503 when GitLab rate limits', async () => {
    scriptedFetch([(url) => (matches(/\/issues\?/)(url) ? jsonResponse({}, { status: 429, headers: { 'retry-after': '30' } }) : null)]);

    const app = createApp();
    const response = await request(app).get('/api/gitlab/issues/list?directory=%2Ftmp%2Fwork');
    expect(response.status).toBe(503);
    expect(response.body).toEqual({ error: 'GitLab rate limited' });
  });
});
