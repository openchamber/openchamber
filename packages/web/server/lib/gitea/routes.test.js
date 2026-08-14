import fs from 'fs';
import os from 'os';
import path from 'path';
import { afterAll, beforeEach, describe, expect, test, vi } from 'vitest';
import express from 'express';
import request from 'supertest';

const TEMP_DATA_DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'openchamber-gitea-routes-'));
process.env.OPENCHAMBER_DATA_DIR = TEMP_DATA_DIR;

// Resolve a fake git remote so directory-based repo resolution finds a Gitea
// repo without touching the real filesystem/git.
vi.mock('../git/index.js', () => ({
  getRemoteUrl: vi.fn(async () => 'git@gitea.example.com:owner/repo.git'),
}));

const { registerGiteaRoutes } = await import('./routes.js');
const { setGiteaAuth, clearGiteaAuth, getGiteaAuth, getGiteaAuthAccounts, GITEA_AUTH_FILE } = await import('./index.js');

afterAll(() => {
  fs.rmSync(TEMP_DATA_DIR, { recursive: true, force: true });
});

// clearGiteaAuth only drops the *current* account (multi-account model), so a
// full wipe is done by removing the auth file between tests.
const resetAuthFile = () => {
  if (fs.existsSync(GITEA_AUTH_FILE)) {
    fs.unlinkSync(GITEA_AUTH_FILE);
  }
};

const aliceUser = {
  id: 42,
  login: 'alice',
  full_name: 'Alice Example',
  avatar_url: 'https://gitea.example.com/avatars/alice.png',
  html_url: 'https://gitea.example.com/alice',
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
  registerGiteaRoutes(app);
  return app;
};

describe('Gitea auth routes', () => {
  beforeEach(() => {
    resetAuthFile();
    vi.restoreAllMocks();
    delete globalThis.fetch;
  });

  test('auth/status returns disconnected with no default base URL', async () => {
    const app = createApp();
    const response = await request(app).get('/api/gitea/auth/status');
    expect(response.status).toBe(200);
    expect(response.body).toEqual({
      connected: false,
      accounts: [],
    });
    expect(response.body.defaultBaseUrl).toBeUndefined();
  });

  test('auth/connect validates the token, stores the account, and reports connected', async () => {
    scriptedFetch([(url) => (matches(/\/api\/v1\/user$/)(url) ? jsonResponse(aliceUser) : null)]);

    const app = createApp();
    const response = await request(app)
      .post('/api/gitea/auth/connect')
      .send({ accessToken: 'gitea-valid', baseUrl: 'https://gitea.example.com' });

    expect(response.status).toBe(200);
    expect(response.body).toMatchObject({
      connected: true,
      user: { username: 'alice', id: 42, name: 'Alice Example', avatarUrl: 'https://gitea.example.com/avatars/alice.png', webUrl: 'https://gitea.example.com/alice', email: 'alice@example.com' },
    });
    expect(response.body.accounts).toEqual([
      { id: 'gitea.example.com:alice', user: { username: 'alice', name: 'Alice Example', avatarUrl: 'https://gitea.example.com/avatars/alice.png', webUrl: 'https://gitea.example.com/alice' }, baseUrl: 'https://gitea.example.com', current: true },
    ]);
    expect(getGiteaAuth()?.accessToken).toBe('gitea-valid');
  });

  test('auth/connect rejects an invalid token with 400', async () => {
    scriptedFetch([(url) => (matches(/\/api\/v1\/user$/)(url) ? jsonResponse({ message: '401 Unauthorized' }, { status: 401 }) : null)]);

    const app = createApp();
    const response = await request(app)
      .post('/api/gitea/auth/connect')
      .send({ accessToken: 'gitea-invalid', baseUrl: 'https://gitea.example.com' });

    expect(response.status).toBe(400);
    expect(response.body).toEqual({ error: 'Invalid Gitea access token' });
    expect(getGiteaAuth()).toBeNull();
  });

  test('auth/connect requires an access token', async () => {
    const app = createApp();
    const response = await request(app)
      .post('/api/gitea/auth/connect')
      .send({ baseUrl: 'https://gitea.example.com' });
    expect(response.status).toBe(400);
    expect(response.body).toEqual({ error: 'accessToken is required' });
  });

  test('auth/connect requires a base URL (no default instance)', async () => {
    const app = createApp();
    const response = await request(app).post('/api/gitea/auth/connect').send({ accessToken: 'gitea-valid' });
    expect(response.status).toBe(400);
    expect(response.body).toEqual({ error: 'baseUrl is required and must be a valid URL' });
  });

  test('auth/connect normalizes a scheme-less base URL', async () => {
    const fetchMock = scriptedFetch([(url) => (matches(/\/api\/v1\/user$/)(url) ? jsonResponse(aliceUser) : null)]);

    const app = createApp();
    await request(app)
      .post('/api/gitea/auth/connect')
      .send({ accessToken: 'gitea-valid', baseUrl: 'gitea.example.com' });

    expect(fetchMock.mock.calls[0][0]).toBe('https://gitea.example.com/api/v1/user');
  });

  test('auth/status reports connected with the live user', async () => {
    setGiteaAuth({ accessToken: 'gitea-a', baseUrl: 'gitea.example.com', user: aliceUser });
    scriptedFetch([(url) => (matches(/\/api\/v1\/user$/)(url) ? jsonResponse(aliceUser) : null)]);

    const app = createApp();
    const response = await request(app).get('/api/gitea/auth/status');
    expect(response.status).toBe(200);
    expect(response.body).toMatchObject({
      connected: true,
      user: { username: 'alice', id: 42 },
    });
    expect(response.body.accounts).toEqual([
      { id: 'gitea.example.com:alice', user: { username: 'alice', name: 'Alice Example', avatarUrl: 'https://gitea.example.com/avatars/alice.png', webUrl: 'https://gitea.example.com/alice' }, baseUrl: 'https://gitea.example.com', current: true },
    ]);
  });

  test('auth/activate returns 404 for an unknown account', async () => {
    const app = createApp();
    const response = await request(app).post('/api/gitea/auth/activate').send({ accountId: 'gitea.example.com:nobody' });
    expect(response.status).toBe(404);
    expect(response.body).toEqual({ error: 'Gitea account not found' });
  });

  test('auth/activate switches the current account', async () => {
    setGiteaAuth({ accessToken: 'gitea-a', baseUrl: 'gitea.example.com', user: aliceUser });
    setGiteaAuth({
      accessToken: 'gitea-b',
      baseUrl: 'https://gitea.other.example',
      user: { ...aliceUser, login: 'bob', full_name: 'Bob' },
    });
    scriptedFetch([(url) => (matches(/\/api\/v1\/user$/)(url) ? jsonResponse(aliceUser) : null)]);

    const app = createApp();
    const response = await request(app).post('/api/gitea/auth/activate').send({ accountId: 'gitea.example.com:alice' });
    expect(response.status).toBe(200);
    expect(response.body.connected).toBe(true);
    expect(response.body.accounts.find((a) => a.id === 'gitea.example.com:alice')?.current).toBe(true);
    expect(getGiteaAuth()?.accountId).toBe('gitea.example.com:alice');
  });

  test('DELETE /api/gitea/auth clears the account', async () => {
    setGiteaAuth({ accessToken: 'gitea-a', baseUrl: 'gitea.example.com', user: aliceUser });
    const app = createApp();
    const response = await request(app).delete('/api/gitea/auth');
    expect(response.status).toBe(200);
    expect(response.body).toEqual({ removed: true });
    expect(getGiteaAuth()).toBeNull();
  });

  test('me returns 401 when not connected', async () => {
    const app = createApp();
    const response = await request(app).get('/api/gitea/me');
    expect(response.status).toBe(401);
    expect(response.body).toEqual({ error: 'Gitea not connected' });
  });

  test('me returns the connected user', async () => {
    setGiteaAuth({ accessToken: 'gitea-a', baseUrl: 'gitea.example.com', user: aliceUser });
    scriptedFetch([(url) => (matches(/\/api\/v1\/user$/)(url) ? jsonResponse(aliceUser) : null)]);

    const app = createApp();
    const response = await request(app).get('/api/gitea/me');
    expect(response.status).toBe(200);
    expect(response.body).toEqual({
      username: 'alice',
      id: 42,
      name: 'Alice Example',
      avatarUrl: 'https://gitea.example.com/avatars/alice.png',
      webUrl: 'https://gitea.example.com/alice',
      email: 'alice@example.com',
    });
  });
});

describe('Gitea data routes', () => {
  beforeEach(() => {
    resetAuthFile();
    setGiteaAuth({ accessToken: 'gitea-a', baseUrl: 'gitea.example.com', user: aliceUser });
    vi.restoreAllMocks();
    delete globalThis.fetch;
  });

  test('issues/list returns mapped issues with pagination info', async () => {
    scriptedFetch([
      (url) => (matches(/\/api\/v1\/repos\/owner\/repo\/issues\?/)(url)
        ? jsonResponse(
          [
            {
              number: 3,
              title: 'Fix the widget',
              html_url: 'https://gitea.example.com/owner/repo/issues/3',
              state: 'open',
              user: { id: 42, login: 'alice', full_name: 'Alice Example', avatar_url: 'https://gitea.example.com/alice.png' },
              labels: [{ id: 1, name: 'bug' }, { id: 2, name: 'priority:high' }],
            },
          ],
          { headers: { link: '<https://gitea.example.com/api/v1/repos/owner/repo/issues?page=2>; rel="next"' } },
        )
        : null),
    ]);

    const app = createApp();
    const response = await request(app).get('/api/gitea/issues/list?directory=%2Ftmp%2Fwork&page=1');

    expect(response.status).toBe(200);
    expect(response.body).toMatchObject({
      connected: true,
      repo: { owner: 'owner', repo: 'repo', host: 'gitea.example.com', url: 'https://gitea.example.com/owner/repo' },
      issues: [
        {
          number: 3,
          title: 'Fix the widget',
          url: 'https://gitea.example.com/owner/repo/issues/3',
          state: 'open',
          author: { username: 'alice', id: 42 },
          labels: ['bug', 'priority:high'],
        },
      ],
      page: 1,
      hasMore: true,
    });
  });

  test('issues/list sends the search query, open state, and type=issues', async () => {
    const fetchMock = scriptedFetch([(url) => (matches(/\/issues\?/)(url) ? jsonResponse([]) : null)]);

    const app = createApp();
    await request(app).get('/api/gitea/issues/list?directory=%2Ftmp%2Fwork&query=login');

    const requestedUrl = String(fetchMock.mock.calls[0][0]);
    expect(requestedUrl).toContain('state=open');
    expect(requestedUrl).toContain('type=issues');
    expect(requestedUrl).toContain('q=login');
    expect(requestedUrl).toContain('limit=50');
  });

  test('issues/list skips entries carrying a pull_request field', async () => {
    scriptedFetch([
      (url) => (matches(/\/issues\?/)(url)
        ? jsonResponse([
          { number: 1, title: 'An issue', html_url: 'u', state: 'open', user: { login: 'alice' }, labels: [] },
          { number: 2, title: 'A pull request', html_url: 'u', state: 'open', user: { login: 'alice' }, labels: [], pull_request: { number: 2 } },
        ])
        : null),
    ]);

    const app = createApp();
    const response = await request(app).get('/api/gitea/issues/list?directory=%2Ftmp%2Fwork');
    expect(response.status).toBe(200);
    expect(response.body.issues).toHaveLength(1);
    expect(response.body.issues[0].number).toBe(1);
  });

  test('issues/list honors owner/repo query params as an override', async () => {
    const fetchMock = scriptedFetch([(url) => (matches(/\/issues\?/)(url) ? jsonResponse([]) : null)]);

    const app = createApp();
    await request(app).get('/api/gitea/issues/list?directory=%2Ftmp%2Fwork&owner=acme&repo=widgets');

    const requestedUrl = String(fetchMock.mock.calls[0][0]);
    expect(requestedUrl).toContain('/repos/acme/widgets/issues');
  });

  test('issues/list reports connected:false when not authenticated', async () => {
    clearGiteaAuth();
    const app = createApp();
    const response = await request(app).get('/api/gitea/issues/list?directory=%2Ftmp%2Fwork');
    expect(response.status).toBe(200);
    expect(response.body).toMatchObject({ connected: false, issues: [] });
  });

  test('issues/get returns a full issue', async () => {
    scriptedFetch([
      (url) => (matches(/\/issues\/7$/)(url)
        ? jsonResponse({
          number: 7,
          title: 'Broken import',
          html_url: 'https://gitea.example.com/owner/repo/issues/7',
          state: 'open',
          body: 'It breaks at startup',
          created_at: '2026-01-01T10:00:00Z',
          updated_at: '2026-01-02T10:00:00Z',
          user: { id: 42, login: 'alice', full_name: 'Alice Example' },
          labels: [{ id: 1, name: 'bug' }],
        })
        : null),
    ]);

    const app = createApp();
    const response = await request(app).get('/api/gitea/issues/get?directory=%2Ftmp%2Fwork&number=7');

    expect(response.status).toBe(200);
    expect(response.body).toMatchObject({
      connected: true,
      issue: {
        number: 7,
        title: 'Broken import',
        state: 'open',
        body: 'It breaks at startup',
        createdAt: '2026-01-01T10:00:00Z',
        updatedAt: '2026-01-02T10:00:00Z',
        author: { username: 'alice', id: 42 },
        labels: ['bug'],
      },
    });
  });

  test('issues/get returns 404 for a missing issue', async () => {
    scriptedFetch([(url) => (matches(/\/issues\/999$/)(url) ? jsonResponse({ message: 'Not found' }, { status: 404 }) : null)]);

    const app = createApp();
    const response = await request(app).get('/api/gitea/issues/get?directory=%2Ftmp%2Fwork&number=999');
    expect(response.status).toBe(404);
    expect(response.body).toEqual({ error: 'Issue not found' });
  });

  test('issues/comments maps Gitea comments', async () => {
    scriptedFetch([
      (url) => (matches(/\/issues\/7\/comments\?/)(url)
        ? jsonResponse([
          {
            id: 2,
            html_url: 'https://gitea.example.com/owner/repo/issues/7#issuecomment-2',
            body: 'Looks good to me',
            user: { id: 42, login: 'alice', full_name: 'Alice Example' },
            created_at: '2026-01-01T01:00:00Z',
          },
        ])
        : null),
    ]);

    const app = createApp();
    const response = await request(app).get('/api/gitea/issues/comments?directory=%2Ftmp%2Fwork&number=7');

    expect(response.status).toBe(200);
    expect(response.body.comments).toEqual([
      {
        id: 2,
        body: 'Looks good to me',
        url: 'https://gitea.example.com/owner/repo/issues/7#issuecomment-2',
        author: { username: 'alice', id: 42 },
        createdAt: '2026-01-01T01:00:00Z',
      },
    ]);
  });

  test('prs/list returns mapped pull requests with open state by default', async () => {
    scriptedFetch([
      (url) => (matches(/\/pulls\?/)(url)
        ? jsonResponse([
          {
            number: 9,
            title: 'Add the API',
            html_url: 'https://gitea.example.com/owner/repo/pulls/9',
            state: 'open',
            merged: false,
            draft: false,
            user: { id: 42, login: 'alice', full_name: 'Alice Example' },
            labels: [{ id: 1, name: 'feature' }],
            head: { ref: 'feat/api' },
            base: { ref: 'main' },
          },
        ])
        : null),
    ]);

    const app = createApp();
    const response = await request(app).get('/api/gitea/prs/list?directory=%2Ftmp%2Fwork');

    expect(response.status).toBe(200);
    expect(response.body).toMatchObject({
      connected: true,
      prs: [
        {
          number: 9,
          title: 'Add the API',
          state: 'open',
          draft: false,
          author: { username: 'alice', id: 42 },
          labels: ['feature'],
          sourceBranch: 'feat/api',
          targetBranch: 'main',
        },
      ],
      page: 1,
      hasMore: false,
    });
  });

  test('prs/list maps merged and closed states correctly', async () => {
    scriptedFetch([
      (url) => (matches(/\/pulls\?/)(url)
        ? jsonResponse([
          { number: 1, title: 'Merged PR', html_url: 'u', state: 'closed', merged: true, draft: false, user: { login: 'alice' }, labels: [], head: { ref: 'a' }, base: { ref: 'main' } },
          { number: 2, title: 'Closed PR', html_url: 'u', state: 'closed', merged: false, draft: false, user: { login: 'alice' }, labels: [], head: { ref: 'b' }, base: { ref: 'main' } },
          { number: 3, title: 'Open PR', html_url: 'u', state: 'open', merged: false, draft: true, user: { login: 'alice' }, labels: [], head: { ref: 'c' }, base: { ref: 'main' } },
        ])
        : null),
    ]);

    const app = createApp();
    const response = await request(app).get('/api/gitea/prs/list?directory=%2Ftmp%2Fwork');

    const prs = response.body.prs;
    expect(prs[0]).toMatchObject({ number: 1, state: 'merged' });
    expect(prs[1]).toMatchObject({ number: 2, state: 'closed' });
    expect(prs[2]).toMatchObject({ number: 3, state: 'open', draft: true });
  });

  test('prs/list with sourceBranch requests all states and filters by head.ref', async () => {
    const fetchMock = scriptedFetch([
      (url) => (matches(/\/pulls\?/)(url)
        ? jsonResponse([
          {
            number: 5,
            title: 'Open PR for feat/api',
            html_url: 'u',
            state: 'open',
            merged: false,
            draft: false,
            user: { login: 'alice' },
            labels: [],
            head: { ref: 'feat/api' },
            base: { ref: 'main' },
          },
          {
            number: 6,
            title: 'Merged PR for feat/api',
            html_url: 'u',
            state: 'closed',
            merged: true,
            draft: false,
            user: { login: 'alice' },
            labels: [],
            head: { ref: 'feat/api' },
            base: { ref: 'main' },
          },
          {
            number: 7,
            title: 'PR for another branch',
            html_url: 'u',
            state: 'open',
            merged: false,
            draft: false,
            user: { login: 'alice' },
            labels: [],
            head: { ref: 'feat/other' },
            base: { ref: 'main' },
          },
        ])
        : null),
    ]);

    const app = createApp();
    const response = await request(app).get('/api/gitea/prs/list?directory=%2Ftmp%2Fwork&sourceBranch=feat%2Fapi');

    expect(response.status).toBe(200);
    const requestedUrl = String(fetchMock.mock.calls[0][0]);
    expect(requestedUrl).toContain('state=all');

    const prs = response.body.prs;
    expect(prs).toHaveLength(2);
    expect(prs.find((pr) => pr.number === 5)).toMatchObject({ state: 'open', sourceBranch: 'feat/api' });
    expect(prs.find((pr) => pr.number === 6)).toMatchObject({ state: 'merged', sourceBranch: 'feat/api' });
  });

  test('prs/list omits the source branch filter when not provided', async () => {
    const fetchMock = scriptedFetch([(url) => (matches(/\/pulls\?/)(url) ? jsonResponse([]) : null)]);

    const app = createApp();
    await request(app).get('/api/gitea/prs/list?directory=%2Ftmp%2Fwork');

    const requestedUrl = String(fetchMock.mock.calls[0][0]);
    expect(requestedUrl).not.toContain('state=all');
    expect(requestedUrl).toContain('state=open');
  });

  test('pr/context returns pr, comments, files, and a raw diff', async () => {
    scriptedFetch([
      (url) => (matches(/\/pulls\/9$/)(url)
        ? jsonResponse({
          number: 9,
          title: 'Add the API',
          html_url: 'https://gitea.example.com/owner/repo/pulls/9',
          state: 'open',
          merged: false,
          draft: false,
          body: 'Adds the public API',
          created_at: '2026-01-01T10:00:00Z',
          updated_at: '2026-01-02T10:00:00Z',
          mergeable: true,
          user: { id: 42, login: 'alice', full_name: 'Alice Example' },
          labels: [{ id: 1, name: 'feature' }],
          head: { ref: 'feat/api' },
          base: { ref: 'main' },
        })
        : null),
      (url) => (matches(/\/issues\/9\/comments\?/)(url)
        ? jsonResponse([
          { id: 11, html_url: 'u', body: 'LGTM', user: { id: 43, login: 'bob', full_name: 'Bob' }, created_at: '2026-01-02T11:00:00Z' },
        ])
        : null),
      (url) => (matches(/\/pulls\/9\/files\?/)(url)
        ? jsonResponse([
          {
            Filename: 'src/a.ts',
            Status: 'modified',
            Additions: 1,
            Deletions: 1,
            Patch: '--- a/src/a.ts\n+++ b/src/a.ts\n@@ -1,3 +1,4 @@\n+export const added = 1\n-export const old = 2\n',
          },
          {
            Filename: 'src/new.ts',
            Status: 'added',
            Additions: 2,
            Deletions: 0,
            Patch: '--- a/src/new.ts\n+++ b/src/new.ts\n@@ -0,0 +1,2 @@\n+line one\n+line two\n',
          },
        ])
        : null),
      (url) => (matches(/\/pulls\/9\.diff$/)(url)
        ? new Response('diff --git a/src/a.ts b/src/a.ts\n@@ -1,3 +1,4 @@\n+export const added = 1\n', { status: 200 })
        : null),
    ]);

    const app = createApp();
    const response = await request(app).get('/api/gitea/pr/context?directory=%2Ftmp%2Fwork&number=9&includeDiff=1');

    expect(response.status).toBe(200);
    expect(response.body).toMatchObject({
      connected: true,
      pr: {
        number: 9,
        title: 'Add the API',
        state: 'open',
        draft: false,
        body: 'Adds the public API',
        mergeable: true,
        merged: false,
        sourceBranch: 'feat/api',
        targetBranch: 'main',
      },
      comments: [{ id: 11, body: 'LGTM', author: { username: 'bob', id: 43 } }],
      files: [
        { filename: 'src/a.ts', status: 'modified', additions: 1, deletions: 1 },
        { filename: 'src/new.ts', status: 'added', additions: 2, deletions: 0 },
      ],
    });
    expect(response.body.diff).toContain('export const added = 1');
  });

  test('pr/context falls back to empty files when the files endpoint 404s', async () => {
    scriptedFetch([
      (url) => (matches(/\/pulls\/9$/)(url)
        ? jsonResponse({ number: 9, title: 'T', html_url: 'u', state: 'open', merged: false, draft: false, user: { login: 'alice' }, head: { ref: 'a' }, base: { ref: 'main' } })
        : null),
      (url) => (matches(/\/issues\/9\/comments\?/)(url) ? jsonResponse([]) : null),
      (url) => (matches(/\/pulls\/9\/files\?/)(url) ? jsonResponse({ message: 'Not Found' }, { status: 404 }) : null),
    ]);

    const app = createApp();
    const response = await request(app).get('/api/gitea/pr/context?directory=%2Ftmp%2Fwork&number=9');
    expect(response.status).toBe(200);
    expect(response.body.files).toEqual([]);
  });

  test('repo/branches returns branch names and the default branch from the repo', async () => {
    scriptedFetch([
      (url) => (matches(/\/repos\/owner\/repo\/branches\?/)(url)
        ? jsonResponse([{ name: 'main' }, { name: 'feat/api' }])
        : null),
      (url) => (matches(/\/api\/v1\/repos\/owner\/repo$/)(url)
        ? jsonResponse({ id: 1, full_name: 'owner/repo', default_branch: 'main' })
        : null),
    ]);

    const app = createApp();
    const response = await request(app).get('/api/gitea/repo/branches?owner=owner&repo=repo');
    expect(response.status).toBe(200);
    expect(response.body).toEqual({ branches: ['main', 'feat/api'], defaultBranch: 'main' });
  });

  test('repo/branches returns null defaultBranch when disconnected', async () => {
    clearGiteaAuth();
    const app = createApp();
    const response = await request(app).get('/api/gitea/repo/branches?owner=owner&repo=repo');
    expect(response.status).toBe(200);
    expect(response.body).toEqual({ branches: [], defaultBranch: null });
  });

  test('repo/branches requires owner and repo', async () => {
    const app = createApp();
    const response = await request(app).get('/api/gitea/repo/branches?owner=owner');
    expect(response.status).toBe(400);
    expect(response.body).toEqual({ error: 'owner and repo are required' });
  });

  test('pr/create POSTs title/head/base/body and returns the created PR', async () => {
    const createdPr = {
      number: 12,
      title: 'Add feature',
      html_url: 'https://gitea.example.com/owner/repo/pulls/12',
      state: 'open',
      merged: false,
      draft: false,
      body: 'Adds the feature',
      user: { id: 42, login: 'alice', full_name: 'Alice Example' },
      head: { ref: 'feat/add' },
      base: { ref: 'main' },
    };
    const fetchMock = scriptedFetch([
      (url, options) => {
        if (matches(/\/pulls$/)(url) && options.method === 'POST') {
          return jsonResponse(createdPr, { status: 201 });
        }
        return null;
      },
    ]);

    const app = createApp();
    const response = await request(app)
      .post('/api/gitea/pr/create')
      .send({
        directory: '/tmp/work',
        title: 'Add feature',
        sourceBranch: 'feat/add',
        targetBranch: 'main',
        description: 'Adds the feature',
      });

    expect(response.status).toBe(200);
    expect(response.body).toMatchObject({
      connected: true,
      repo: { owner: 'owner', repo: 'repo', host: 'gitea.example.com' },
      pr: {
        number: 12,
        title: 'Add feature',
        url: 'https://gitea.example.com/owner/repo/pulls/12',
        state: 'open',
        draft: false,
        author: { username: 'alice', id: 42 },
        sourceBranch: 'feat/add',
        targetBranch: 'main',
      },
    });

    const [, options] = fetchMock.mock.calls[0];
    expect(options.method).toBe('POST');
    expect(JSON.parse(options.body)).toEqual({
      title: 'Add feature',
      head: 'feat/add',
      base: 'main',
      body: 'Adds the feature',
    });
  });

  test('pr/create omits body when no description is given', async () => {
    const fetchMock = scriptedFetch([
      (url, options) => {
        if (matches(/\/pulls$/)(url) && options.method === 'POST') {
          return jsonResponse(
            { number: 1, title: 'T', html_url: 'u', state: 'open', merged: false, draft: false, user: { login: 'alice' }, head: { ref: 's' }, base: { ref: 'm' } },
            { status: 201 },
          );
        }
        return null;
      },
    ]);

    const app = createApp();
    await request(app)
      .post('/api/gitea/pr/create')
      .send({ directory: '/tmp/work', title: 'T', sourceBranch: 's', targetBranch: 'm' });

    const [, options] = fetchMock.mock.calls[0];
    const body = JSON.parse(options.body);
    expect(body).toEqual({ title: 'T', head: 's', base: 'm' });
    expect(body.body).toBeUndefined();
  });

  test('pr/create rejects missing fields with 400', async () => {
    const app = createApp();
    const response = await request(app)
      .post('/api/gitea/pr/create')
      .send({ directory: '/tmp/work', title: 'Add feature' });
    expect(response.status).toBe(400);
    expect(response.body).toEqual({ error: 'directory, title, sourceBranch, targetBranch are required' });
  });

  test('pr/create reports connected:false when not authenticated', async () => {
    clearGiteaAuth();
    const app = createApp();
    const response = await request(app)
      .post('/api/gitea/pr/create')
      .send({ directory: '/tmp/work', title: 'Add feature', sourceBranch: 'feat/add', targetBranch: 'main' });
    expect(response.status).toBe(200);
    expect(response.body).toEqual({ connected: false });
  });

  test('pr/create surfaces a 403 as a scope error', async () => {
    scriptedFetch([
      (url, options) => {
        if (matches(/\/pulls$/)(url) && options.method === 'POST') {
          return jsonResponse({ message: '403 Forbidden' }, { status: 403 });
        }
        return null;
      },
    ]);

    const app = createApp();
    const response = await request(app)
      .post('/api/gitea/pr/create')
      .send({ directory: '/tmp/work', title: 'Add feature', sourceBranch: 'feat/add', targetBranch: 'main' });
    expect(response.status).toBe(400);
    expect(response.body).toEqual({ error: 'Your Gitea token needs write:repository scope to create pull requests' });
  });

  test('pr/update PATCHes title/body and returns the updated PR', async () => {
    const fetchMock = scriptedFetch([
      (url, options) => {
        if (matches(/\/pulls\/12$/)(url) && options.method === 'PATCH') {
          return jsonResponse({
            number: 12,
            title: 'Updated title',
            html_url: 'u',
            state: 'open',
            merged: false,
            draft: false,
            user: { id: 42, login: 'alice' },
            head: { ref: 'feat/add' },
            base: { ref: 'main' },
          });
        }
        return null;
      },
    ]);

    const app = createApp();
    const response = await request(app)
      .patch('/api/gitea/pr/update')
      .send({ directory: '/tmp/work', number: 12, title: 'Updated title', description: 'New body' });

    expect(response.status).toBe(200);
    expect(response.body).toMatchObject({
      connected: true,
      pr: { number: 12, title: 'Updated title', state: 'open', sourceBranch: 'feat/add', targetBranch: 'main' },
    });
    const [, options] = fetchMock.mock.calls[0];
    expect(options.method).toBe('PATCH');
    expect(JSON.parse(options.body)).toEqual({ title: 'Updated title', body: 'New body' });
  });

  test('pr/update omits title/body when not provided', async () => {
    const fetchMock = scriptedFetch([
      (url, options) => {
        if (matches(/\/pulls\/12$/)(url) && options.method === 'PATCH') {
          return jsonResponse({
            number: 12,
            title: 'T',
            html_url: 'u',
            state: 'open',
            merged: false,
            draft: false,
            user: { login: 'alice' },
            head: { ref: 's' },
            base: { ref: 'm' },
          });
        }
        return null;
      },
    ]);

    const app = createApp();
    await request(app).patch('/api/gitea/pr/update').send({ directory: '/tmp/work', number: 12 });

    const [, options] = fetchMock.mock.calls[0];
    expect(JSON.parse(options.body)).toEqual({});
  });

  test('pr/update returns 404 for a missing pull request', async () => {
    scriptedFetch([
      (url, options) => {
        if (matches(/\/pulls\/999$/)(url) && options.method === 'PATCH') {
          return jsonResponse({ message: '404 Not Found' }, { status: 404 });
        }
        return null;
      },
    ]);

    const app = createApp();
    const response = await request(app)
      .patch('/api/gitea/pr/update')
      .send({ directory: '/tmp/work', number: 999, title: 'x' });
    expect(response.status).toBe(404);
    expect(response.body).toEqual({ error: 'Pull request not found' });
  });

  test('pr/merge POSTs Do/MergeMethod and reports merged:true', async () => {
    const fetchMock = scriptedFetch([
      (url, options) => {
        if (matches(/\/pulls\/12\/merge$/)(url) && options.method === 'POST') {
          return jsonResponse({ merged: true, message: 'pull request was merged' });
        }
        return null;
      },
    ]);

    const app = createApp();
    const response = await request(app)
      .post('/api/gitea/pr/merge')
      .send({ directory: '/tmp/work', number: 12 });

    expect(response.status).toBe(200);
    expect(response.body).toEqual({ connected: true, merged: true });
    const [, options] = fetchMock.mock.calls[0];
    expect(options.method).toBe('POST');
    expect(JSON.parse(options.body)).toEqual({ Do: true, MergeMethod: 'merge' });
  });

  test('pr/merge maps the method to MergeMethod', async () => {
    const fetchMock = scriptedFetch([
      (url, options) => {
        if (matches(/\/pulls\/12\/merge$/)(url) && options.method === 'POST') {
          return jsonResponse({ merged: true });
        }
        return null;
      },
    ]);

    const app = createApp();
    await request(app)
      .post('/api/gitea/pr/merge')
      .send({ directory: '/tmp/work', number: 12, method: 'squash' });

    const [, options] = fetchMock.mock.calls[0];
    expect(JSON.parse(options.body)).toEqual({ Do: true, MergeMethod: 'squash' });
  });

  test('pr/merge passes through a Gitea merge rejection as merged:false', async () => {
    scriptedFetch([
      (url, options) => {
        if (matches(/\/pulls\/12\/merge$/)(url) && options.method === 'POST') {
          return jsonResponse({ message: 'This PR is already merged' }, { status: 409 });
        }
        return null;
      },
    ]);

    const app = createApp();
    const response = await request(app)
      .post('/api/gitea/pr/merge')
      .send({ directory: '/tmp/work', number: 12 });

    expect(response.status).toBe(409);
    expect(response.body).toEqual({
      connected: true,
      merged: false,
      message: 'This PR is already merged',
    });
  });

  test('pr/merge surfaces a 403 as a scope error', async () => {
    scriptedFetch([
      (url, options) => {
        if (matches(/\/pulls\/12\/merge$/)(url) && options.method === 'POST') {
          return jsonResponse({ message: '403 Forbidden' }, { status: 403 });
        }
        return null;
      },
    ]);

    const app = createApp();
    const response = await request(app)
      .post('/api/gitea/pr/merge')
      .send({ directory: '/tmp/work', number: 12 });
    expect(response.status).toBe(400);
    expect(response.body).toEqual({ error: 'Your Gitea token needs write:repository scope to merge pull requests' });
  });

  test('prs/commits maps pull request commits with summaries', async () => {
    scriptedFetch([
      (url) => (matches(/\/pulls\/9\/commits\?/)(url)
        ? jsonResponse([
          {
            sha: 'abc123def4567890',
            commit: {
              message: 'Add the API\n\nAdds the public API',
              author: { name: 'Alice Example', email: 'alice@example.com', date: '2026-01-01T10:00:00Z' },
            },
            author: { id: 42, login: 'alice', full_name: 'Alice Example' },
            parents: [{ sha: 'parent-one' }, { sha: 'parent-two' }],
          },
        ])
        : null),
    ]);

    const app = createApp();
    const response = await request(app).get('/api/gitea/prs/commits?directory=%2Ftmp%2Fwork&number=9');

    expect(response.status).toBe(200);
    expect(response.body).toMatchObject({
      connected: true,
      repo: { owner: 'owner', repo: 'repo' },
      commits: [
        {
          sha: 'abc123def4567890',
          message: 'Add the API\n\nAdds the public API',
          summary: 'Add the API',
          author: { username: 'alice', id: 42 },
          committedAt: '2026-01-01T10:00:00Z',
          parents: ['parent-one', 'parent-two'],
        },
      ],
    });
  });

  test('prs/reviews passes review state through and maps the author', async () => {
    scriptedFetch([
      (url) => (matches(/\/pulls\/9\/reviews\?/)(url)
        ? jsonResponse([
          {
            id: 101,
            state: 'APPROVED',
            user: { id: 42, login: 'alice', full_name: 'Alice Example' },
            submitted_at: '2026-01-02T11:00:00Z',
            body: 'LGTM',
            commit_id: 'abc123def4567890',
          },
        ])
        : null),
    ]);

    const app = createApp();
    const response = await request(app).get('/api/gitea/prs/reviews?directory=%2Ftmp%2Fwork&number=9');

    expect(response.status).toBe(200);
    expect(response.body).toMatchObject({
      connected: true,
      reviews: [
        {
          id: '101',
          state: 'APPROVED',
          author: { username: 'alice', id: 42 },
          submittedAt: '2026-01-02T11:00:00Z',
          body: 'LGTM',
          commitSha: 'abc123def4567890',
        },
      ],
    });
  });

  test('prs/statuses resolves the PR head SHA then maps commit statuses', async () => {
    const fetchMock = scriptedFetch([
      (url) => (matches(/\/pulls\/9$/)(url)
        ? jsonResponse({
          number: 9,
          title: 'Add the API',
          html_url: 'u',
          state: 'open',
          merged: false,
          user: { login: 'alice' },
          head: { ref: 'feat/api', sha: 'abc123def4567890' },
          base: { ref: 'main' },
        })
        : null),
      (url) => (matches(/\/commits\/abc123def4567890\/statuses\?/)(url)
        ? jsonResponse([
          { id: 1, state: 'success', context: 'ci/test', description: 'All good', target_url: 'https://ci.example.com/run/1', created_at: '2026-01-02T12:00:00Z' },
          { id: 2, state: 'error', context: 'lint' },
          { id: 3, state: 'warning', context: 'docs' },
        ])
        : null),
    ]);

    const app = createApp();
    const response = await request(app).get('/api/gitea/prs/statuses?directory=%2Ftmp%2Fwork&number=9');

    expect(response.status).toBe(200);
    expect(response.body).toMatchObject({
      connected: true,
      repo: { owner: 'owner', repo: 'repo' },
      statuses: [
        { state: 'success', name: 'ci/test', description: 'All good', url: 'https://ci.example.com/run/1', createdAt: '2026-01-02T12:00:00Z' },
        { state: 'error', name: 'lint' },
        { state: 'warning', name: 'docs' },
      ],
    });

    const requestedUrls = fetchMock.mock.calls.map(([url]) => String(url));
    expect(requestedUrls.some((url) => url.includes('/pulls/9'))).toBe(true);
    expect(requestedUrls.some((url) => url.includes('/commits/abc123def4567890/statuses'))).toBe(true);
  });

  test('prs/commits, prs/reviews, and prs/statuses report connected:false when not authenticated', async () => {
    clearGiteaAuth();
    const app = createApp();
    const commits = await request(app).get('/api/gitea/prs/commits?directory=%2Ftmp%2Fwork&number=9');
    const reviews = await request(app).get('/api/gitea/prs/reviews?directory=%2Ftmp%2Fwork&number=9');
    const statuses = await request(app).get('/api/gitea/prs/statuses?directory=%2Ftmp%2Fwork&number=9');
    expect(commits.body).toMatchObject({ connected: false, commits: [] });
    expect(reviews.body).toMatchObject({ connected: false, reviews: [] });
    expect(statuses.body).toMatchObject({ connected: false, statuses: [] });
  });

  test('issues/comment POSTs a comment and maps it', async () => {
    const fetchMock = scriptedFetch([
      (url, options) => {
        if (matches(/\/issues\/7\/comments$/)(url) && options.method === 'POST') {
          return jsonResponse({
            id: 5,
            body: 'Nice catch',
            html_url: 'https://gitea.example.com/owner/repo/issues/7#issuecomment-5',
            user: { id: 42, login: 'alice', full_name: 'Alice Example' },
            created_at: '2026-01-02T11:00:00Z',
          }, { status: 201 });
        }
        return null;
      },
    ]);

    const app = createApp();
    const response = await request(app)
      .post('/api/gitea/issues/comment')
      .send({ directory: '/tmp/work', number: 7, body: 'Nice catch' });

    expect(response.status).toBe(200);
    expect(response.body).toMatchObject({
      connected: true,
      repo: { owner: 'owner', repo: 'repo', host: 'gitea.example.com' },
      comment: {
        id: 5,
        body: 'Nice catch',
        url: 'https://gitea.example.com/owner/repo/issues/7#issuecomment-5',
        author: { username: 'alice', id: 42 },
        createdAt: '2026-01-02T11:00:00Z',
      },
    });
    const [, options] = fetchMock.mock.calls[0];
    expect(options.method).toBe('POST');
    expect(JSON.parse(options.body)).toEqual({ body: 'Nice catch' });
  });

  test('issues/comment reports connected:false when not authenticated', async () => {
    clearGiteaAuth();
    const app = createApp();
    const response = await request(app)
      .post('/api/gitea/issues/comment')
      .send({ directory: '/tmp/work', number: 7, body: 'hello' });
    expect(response.status).toBe(200);
    expect(response.body).toEqual({ connected: false });
  });

  test('issues/update maps labels, assignees, state, and resolves the milestone title', async () => {
    const fetchMock = scriptedFetch([
      (url) => (matches(/\/milestones\?/)(url)
        ? jsonResponse([{ id: 33, title: 'v1.0', state: 'open' }])
        : null),
      (url, options) => {
        if (matches(/\/issues\/7$/)(url) && options.method === 'PATCH') {
          return jsonResponse({
            number: 7,
            title: 'Updated issue',
            html_url: 'https://gitea.example.com/owner/repo/issues/7',
            state: 'closed',
            body: 'New body',
            user: { id: 42, login: 'alice' },
            labels: [{ id: 1, name: 'bug' }],
            assignees: [{ id: 43, login: 'bob' }],
            milestone: { id: 33, title: 'v1.0', state: 'open' },
          });
        }
        return null;
      },
    ]);

    const app = createApp();
    const response = await request(app)
      .patch('/api/gitea/issues/update')
      .send({
        directory: '/tmp/work',
        number: 7,
        title: 'Updated issue',
        body: 'New body',
        state: 'closed',
        labels: ['bug'],
        assignees: ['bob'],
        milestone: 'v1.0',
      });

    expect(response.status).toBe(200);
    expect(response.body).toMatchObject({
      connected: true,
      issue: {
        number: 7,
        title: 'Updated issue',
        state: 'closed',
        body: 'New body',
        labels: ['bug'],
        assignees: [{ username: 'bob', id: 43 }],
        milestone: { title: 'v1.0', state: 'open' },
      },
    });
    const [, options] = fetchMock.mock.calls[1];
    expect(options.method).toBe('PATCH');
    expect(JSON.parse(options.body)).toEqual({
      title: 'Updated issue',
      body: 'New body',
      state: 'closed',
      labels: ['bug'],
      assignees: ['bob'],
      milestone: 33,
    });
  });

  test('issues/update clears the milestone with unset_milestone', async () => {
    const fetchMock = scriptedFetch([
      (url, options) => {
        if (matches(/\/issues\/7$/)(url) && options.method === 'PATCH') {
          return jsonResponse({ number: 7, title: 'T', html_url: 'u', state: 'open', user: { login: 'alice' } });
        }
        return null;
      },
    ]);

    const app = createApp();
    await request(app)
      .patch('/api/gitea/issues/update')
      .send({ directory: '/tmp/work', number: 7, milestone: null });

    const [, options] = fetchMock.mock.calls[0];
    expect(JSON.parse(options.body)).toEqual({ unset_milestone: true });
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  test('issues/update returns 400 when the milestone title does not match', async () => {
    scriptedFetch([
      (url) => (matches(/\/milestones\?/)(url)
        ? jsonResponse([{ id: 33, title: 'v1.0' }])
        : null),
    ]);

    const app = createApp();
    const response = await request(app)
      .patch('/api/gitea/issues/update')
      .send({ directory: '/tmp/work', number: 7, milestone: 'v2.0' });
    expect(response.status).toBe(400);
    expect(response.body).toEqual({ error: 'Milestone not found' });
  });

  test('prs/comment POSTs a comment on the PR index and maps it', async () => {
    const fetchMock = scriptedFetch([
      (url, options) => {
        if (matches(/\/issues\/12\/comments$/)(url) && options.method === 'POST') {
          return jsonResponse({
            id: 8,
            body: 'LGTM',
            html_url: 'https://gitea.example.com/owner/repo/pulls/12#issuecomment-8',
            user: { id: 43, login: 'bob' },
          }, { status: 201 });
        }
        return null;
      },
    ]);

    const app = createApp();
    const response = await request(app)
      .post('/api/gitea/prs/comment')
      .send({ directory: '/tmp/work', number: 12, body: 'LGTM' });

    expect(response.status).toBe(200);
    expect(response.body).toMatchObject({
      connected: true,
      comment: {
        id: 8,
        body: 'LGTM',
        url: 'https://gitea.example.com/owner/repo/pulls/12#issuecomment-8',
        author: { username: 'bob', id: 43 },
      },
    });
    const [, options] = fetchMock.mock.calls[0];
    expect(options.method).toBe('POST');
    expect(JSON.parse(options.body)).toEqual({ body: 'LGTM' });
  });

  test('prs/review POSTs event/body and maps the review', async () => {
    const fetchMock = scriptedFetch([
      (url, options) => {
        if (matches(/\/pulls\/12\/reviews$/)(url) && options.method === 'POST') {
          return jsonResponse({
            id: 101,
            state: 'APPROVED',
            user: { id: 42, login: 'alice', full_name: 'Alice Example' },
            submitted_at: '2026-01-02T11:00:00Z',
            body: 'LGTM',
            commit_id: 'abc123def4567890',
          }, { status: 201 });
        }
        return null;
      },
    ]);

    const app = createApp();
    const response = await request(app)
      .post('/api/gitea/prs/review')
      .send({ directory: '/tmp/work', number: 12, event: 'APPROVED', body: 'LGTM' });

    expect(response.status).toBe(200);
    expect(response.body).toMatchObject({
      connected: true,
      review: {
        id: '101',
        state: 'APPROVED',
        author: { username: 'alice', id: 42 },
        submittedAt: '2026-01-02T11:00:00Z',
        body: 'LGTM',
        commitSha: 'abc123def4567890',
      },
    });
    const [, options] = fetchMock.mock.calls[0];
    expect(options.method).toBe('POST');
    expect(JSON.parse(options.body)).toEqual({ event: 'APPROVED', body: 'LGTM' });
  });

  test('prs/review rejects an unsupported event with 400', async () => {
    const app = createApp();
    const response = await request(app)
      .post('/api/gitea/prs/review')
      .send({ directory: '/tmp/work', number: 12, event: 'PENDING' });
    expect(response.status).toBe(400);
    expect(response.body).toEqual({ error: 'event must be APPROVED, REQUEST_CHANGES, or COMMENT' });
  });

  test('repo/labels returns mapped labels', async () => {
    scriptedFetch([
      (url) => (matches(/\/labels\?/)(url)
        ? jsonResponse([
          { id: 1, name: 'bug', color: 'd73a4a', description: 'A bug' },
          { id: 2, name: 'enhancement', color: 'a2eeef' },
        ])
        : null),
    ]);

    const app = createApp();
    const response = await request(app).get('/api/gitea/repo/labels?directory=%2Ftmp%2Fwork');

    expect(response.status).toBe(200);
    expect(response.body).toMatchObject({
      connected: true,
      repo: { owner: 'owner', repo: 'repo', host: 'gitea.example.com' },
      labels: [
        { id: 1, name: 'bug', color: 'd73a4a', description: 'A bug' },
        { id: 2, name: 'enhancement', color: 'a2eeef' },
      ],
    });
  });

  test('repo/labels requires directory or owner/repo', async () => {
    const app = createApp();
    const response = await request(app).get('/api/gitea/repo/labels');
    expect(response.status).toBe(400);
    expect(response.body).toEqual({ error: 'directory or owner/repo is required' });
  });

  test('pr/update passes state through to the PATCH payload', async () => {
    const fetchMock = scriptedFetch([
      (url, options) => {
        if (matches(/\/pulls\/12$/)(url) && options.method === 'PATCH') {
          return jsonResponse({
            number: 12,
            title: 'T',
            html_url: 'u',
            state: 'closed',
            merged: false,
            draft: false,
            user: { login: 'alice' },
            head: { ref: 'feat/add' },
            base: { ref: 'main' },
          });
        }
        return null;
      },
    ]);

    const app = createApp();
    const response = await request(app)
      .patch('/api/gitea/pr/update')
      .send({ directory: '/tmp/work', number: 12, state: 'closed' });

    expect(response.status).toBe(200);
    expect(response.body).toMatchObject({
      connected: true,
      pr: { number: 12, state: 'closed' },
    });
    const [, options] = fetchMock.mock.calls[0];
    expect(JSON.parse(options.body)).toEqual({ state: 'closed' });
  });

  // NOTE: keep this test last in the file. The rate-limit cooldown is
  // module-level and has no reset export, so tests after it would short-circuit.
  test('data routes surface a 503 when Gitea rate limits', async () => {
    scriptedFetch([(url) => (matches(/\/issues\?/)(url) ? jsonResponse({}, { status: 429, headers: { 'retry-after': '30' } }) : null)]);

    const app = createApp();
    const response = await request(app).get('/api/gitea/issues/list?directory=%2Ftmp%2Fwork');
    expect(response.status).toBe(503);
    expect(response.body).toEqual({ error: 'Gitea rate limited' });
  });
});
