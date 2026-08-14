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
        author: { username: 'alice', name: 'Alice Example', avatarUrl: null, id: 42, webUrl: null },
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

  test('mrs/list passes the source branch filter to the GitLab API', async () => {
    const fetchMock = scriptedFetch([(url) => (matches(/\/merge_requests\?/)(url) ? jsonResponse([]) : null)]);

    const app = createApp();
    await request(app).get('/api/gitlab/mrs/list?directory=%2Ftmp%2Fwork&sourceBranch=feat%2Fapi');

    const requestedUrl = String(fetchMock.mock.calls[0][0]);
    expect(requestedUrl).toContain('state=opened');
    expect(requestedUrl).toContain('source_branch=feat%2Fapi');
    expect(requestedUrl).toContain('per_page=50');
  });

  test('mrs/list omits the source branch filter when not provided', async () => {
    const fetchMock = scriptedFetch([(url) => (matches(/\/merge_requests\?/)(url) ? jsonResponse([]) : null)]);

    const app = createApp();
    await request(app).get('/api/gitlab/mrs/list?directory=%2Ftmp%2Fwork');

    const requestedUrl = String(fetchMock.mock.calls[0][0]);
    expect(requestedUrl).not.toContain('source_branch');
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

  test('repo/branches returns branch names and the default branch', async () => {
    scriptedFetch([
      (url) => (matches(/\/repository\/branches\?/)(url)
        ? jsonResponse([{ name: 'main', default: true }, { name: 'feat/api' }])
        : null),
    ]);

    const app = createApp();
    const response = await request(app).get('/api/gitlab/repo/branches?namespace=group&project=sub');
    expect(response.status).toBe(200);
    expect(response.body).toEqual({ branches: ['main', 'feat/api'], defaultBranch: 'main' });
  });

  test('repo/branches returns null defaultBranch when no branch is marked default', async () => {
    scriptedFetch([
      (url) => (matches(/\/repository\/branches\?/)(url)
        ? jsonResponse([{ name: 'main' }, { name: 'feat/api' }])
        : null),
    ]);

    const app = createApp();
    const response = await request(app).get('/api/gitlab/repo/branches?namespace=group&project=sub');
    expect(response.status).toBe(200);
    expect(response.body).toEqual({ branches: ['main', 'feat/api'], defaultBranch: null });
  });

  test('repo/branches returns empty branches and null defaultBranch when not connected', async () => {
    clearGitLabAuth();
    const app = createApp();
    const response = await request(app).get('/api/gitlab/repo/branches?namespace=group&project=sub');
    expect(response.status).toBe(200);
    expect(response.body).toEqual({ branches: [], defaultBranch: null });
  });

  test('repo/branches requires namespace and project', async () => {
    const app = createApp();
    const response = await request(app).get('/api/gitlab/repo/branches?namespace=group');
    expect(response.status).toBe(400);
    expect(response.body).toEqual({ error: 'namespace and project are required' });
  });

  test('mrs/create POSTs source/target/title and returns the created MR summary', async () => {
    const createdMr = {
      iid: 12,
      title: 'Add feature',
      web_url: 'https://gitlab.com/group/sub/-/merge_requests/12',
      state: 'opened',
      draft: false,
      work_in_progress: false,
      author: {
        id: 42,
        username: 'alice',
        name: 'Alice Example',
        avatar_url: 'https://gitlab.com/alice.png',
        web_url: 'https://gitlab.com/alice',
      },
      source_branch: 'feat/add',
      target_branch: 'main',
    };
    const fetchMock = scriptedFetch([
      (url, options) => {
        if (matches(/\/merge_requests$/)(url) && options.method === 'POST') {
          return jsonResponse(createdMr, { status: 201 });
        }
        return null;
      },
    ]);

    const app = createApp();
    const response = await request(app)
      .post('/api/gitlab/mrs/create')
      .send({
        directory: '/tmp/work',
        title: 'Add feature',
        sourceBranch: 'feat/add',
        targetBranch: 'main',
        description: 'Adds the feature',
        removeSourceBranch: true,
      });

    expect(response.status).toBe(200);
    expect(response.body).toMatchObject({
      connected: true,
      repo: { namespace: 'group', project: 'sub', host: 'gitlab.com' },
      mr: {
        number: 12,
        title: 'Add feature',
        url: 'https://gitlab.com/group/sub/-/merge_requests/12',
        state: 'opened',
        draft: false,
        author: {
          username: 'alice',
          name: 'Alice Example',
          avatarUrl: 'https://gitlab.com/alice.png',
          webUrl: 'https://gitlab.com/alice',
        },
        sourceBranch: 'feat/add',
        targetBranch: 'main',
      },
    });

    const [, options] = fetchMock.mock.calls[0];
    expect(options.method).toBe('POST');
    expect(JSON.parse(options.body)).toEqual({
      source_branch: 'feat/add',
      target_branch: 'main',
      title: 'Add feature',
      description: 'Adds the feature',
      remove_source_branch: true,
    });
  });

  test('mrs/create defaults remove_source_branch to false and omits description', async () => {
    const fetchMock = scriptedFetch([
      (url, options) => {
        if (matches(/\/merge_requests$/)(url) && options.method === 'POST') {
          return jsonResponse(
            { iid: 1, title: 'T', web_url: 'u', state: 'opened', draft: false, author: {}, source_branch: 's', target_branch: 'm' },
            { status: 201 },
          );
        }
        return null;
      },
    ]);

    const app = createApp();
    await request(app)
      .post('/api/gitlab/mrs/create')
      .send({ directory: '/tmp/work', title: 'T', sourceBranch: 's', targetBranch: 'm' });

    const [, options] = fetchMock.mock.calls[0];
    const body = JSON.parse(options.body);
    expect(body).toEqual({ source_branch: 's', target_branch: 'm', title: 'T', remove_source_branch: false });
    expect(body.description).toBeUndefined();
  });

  test('mrs/create rejects missing fields with 400', async () => {
    const app = createApp();
    const response = await request(app)
      .post('/api/gitlab/mrs/create')
      .send({ directory: '/tmp/work', title: 'Add feature' });
    expect(response.status).toBe(400);
    expect(response.body).toEqual({ error: 'directory, title, sourceBranch, targetBranch are required' });
  });

  test('mrs/create reports connected:false when not authenticated', async () => {
    clearGitLabAuth();
    const app = createApp();
    const response = await request(app)
      .post('/api/gitlab/mrs/create')
      .send({ directory: '/tmp/work', title: 'Add feature', sourceBranch: 'feat/add', targetBranch: 'main' });
    expect(response.status).toBe(200);
    expect(response.body).toEqual({ connected: false });
  });

  test('mrs/create surfaces a 403 as an api-scope error', async () => {
    scriptedFetch([
      (url, options) => {
        if (matches(/\/merge_requests$/)(url) && options.method === 'POST') {
          return jsonResponse({ message: '403 Forbidden' }, { status: 403 });
        }
        return null;
      },
    ]);

    const app = createApp();
    const response = await request(app)
      .post('/api/gitlab/mrs/create')
      .send({ directory: '/tmp/work', title: 'Add feature', sourceBranch: 'feat/add', targetBranch: 'main' });
    expect(response.status).toBe(400);
    expect(response.body).toEqual({ error: 'Your GitLab token needs the api scope to create merge requests' });
  });

  test('mrs/create surfaces GitLab validation errors with the api message', async () => {
    scriptedFetch([
      (url, options) => {
        if (matches(/\/merge_requests$/)(url) && options.method === 'POST') {
          return jsonResponse({ message: { source_branch: ['is missing'], title: ['is invalid'] } }, { status: 400 });
        }
        return null;
      },
    ]);

    const app = createApp();
    const response = await request(app)
      .post('/api/gitlab/mrs/create')
      .send({ directory: '/tmp/work', title: 'Add feature', sourceBranch: 'feat/add', targetBranch: 'main' });
    expect(response.status).toBe(400);
    expect(response.body).toEqual({ error: 'source_branch: is missing; title: is invalid' });
  });

  test('mrs/update PUTs title/description and returns the updated MR summary', async () => {
    const fetchMock = scriptedFetch([
      (url, options) => {
        if (matches(/\/merge_requests\/12$/)(url) && options.method === 'PUT') {
          return jsonResponse({
            iid: 12,
            title: 'Updated title',
            web_url: 'https://gitlab.com/group/sub/-/merge_requests/12',
            state: 'opened',
            draft: false,
            work_in_progress: false,
            author: { id: 42, username: 'alice', name: 'Alice Example', avatar_url: 'https://gitlab.com/alice.png' },
            source_branch: 'feat/add',
            target_branch: 'main',
          });
        }
        return null;
      },
    ]);

    const app = createApp();
    const response = await request(app)
      .put('/api/gitlab/mrs/update')
      .send({ directory: '/tmp/work', number: 12, title: 'Updated title', description: 'New body' });

    expect(response.status).toBe(200);
    expect(response.body).toMatchObject({
      connected: true,
      mr: { number: 12, title: 'Updated title', state: 'opened', sourceBranch: 'feat/add', targetBranch: 'main' },
    });
    const [, options] = fetchMock.mock.calls[0];
    expect(options.method).toBe('PUT');
    expect(JSON.parse(options.body)).toEqual({ title: 'Updated title', description: 'New body' });
  });

  test('mrs/update omits title/description when not provided', async () => {
    const fetchMock = scriptedFetch([
      (url, options) => {
        if (matches(/\/merge_requests\/12$/)(url) && options.method === 'PUT') {
          return jsonResponse({
            iid: 12,
            title: 'T',
            web_url: 'u',
            state: 'opened',
            draft: false,
            author: {},
            source_branch: 's',
            target_branch: 'm',
          });
        }
        return null;
      },
    ]);

    const app = createApp();
    await request(app).put('/api/gitlab/mrs/update').send({ directory: '/tmp/work', number: 12 });

    const [, options] = fetchMock.mock.calls[0];
    expect(JSON.parse(options.body)).toEqual({});
  });

  test('mrs/update returns 404 for a missing merge request', async () => {
    scriptedFetch([
      (url, options) => {
        if (matches(/\/merge_requests\/999$/)(url) && options.method === 'PUT') {
          return jsonResponse({ message: '404 Not Found' }, { status: 404 });
        }
        return null;
      },
    ]);

    const app = createApp();
    const response = await request(app)
      .put('/api/gitlab/mrs/update')
      .send({ directory: '/tmp/work', number: 999, title: 'x' });
    expect(response.status).toBe(404);
    expect(response.body).toEqual({ error: 'Merge request not found' });
  });

  test('mrs/merge PUTs squash and reports merged:true', async () => {
    const fetchMock = scriptedFetch([
      (url, options) => {
        if (matches(/\/merge_requests\/12\/merge$/)(url) && options.method === 'PUT') {
          return jsonResponse({ iid: 12, state: 'merged' });
        }
        return null;
      },
    ]);

    const app = createApp();
    const response = await request(app)
      .put('/api/gitlab/mrs/merge')
      .send({ directory: '/tmp/work', number: 12, squash: true });

    expect(response.status).toBe(200);
    expect(response.body).toEqual({ connected: true, merged: true });
    const [, options] = fetchMock.mock.calls[0];
    expect(options.method).toBe('PUT');
    expect(JSON.parse(options.body)).toEqual({ squash: true });
  });

  test('mrs/merge passes through a GitLab merge rejection as merged:false', async () => {
    scriptedFetch([
      (url, options) => {
        if (matches(/\/merge_requests\/12\/merge$/)(url) && options.method === 'PUT') {
          return jsonResponse({ message: '405 Method Not Allowed: This merge request is not open' }, { status: 405 });
        }
        return null;
      },
    ]);

    const app = createApp();
    const response = await request(app)
      .put('/api/gitlab/mrs/merge')
      .send({ directory: '/tmp/work', number: 12 });

    expect(response.status).toBe(405);
    expect(response.body).toEqual({
      connected: true,
      merged: false,
      message: '405 Method Not Allowed: This merge request is not open',
    });
  });

  test('mrs/merge surfaces a 403 as an api-scope error', async () => {
    scriptedFetch([
      (url, options) => {
        if (matches(/\/merge_requests\/12\/merge$/)(url) && options.method === 'PUT') {
          return jsonResponse({ message: '403 Forbidden' }, { status: 403 });
        }
        return null;
      },
    ]);

    const app = createApp();
    const response = await request(app)
      .put('/api/gitlab/mrs/merge')
      .send({ directory: '/tmp/work', number: 12 });

    expect(response.status).toBe(400);
    expect(response.body).toEqual({ error: 'Your GitLab token needs the api scope to create merge requests' });
  });

  test('mrs/commits maps merge request commits with shortSha and summary', async () => {
    scriptedFetch([
      (url) => (matches(/\/merge_requests\/9\/commits\?/)(url)
        ? jsonResponse([
          {
            id: 'abc123def456',
            short_id: 'abc123d',
            title: 'Add the API',
            message: 'Add the API\n\nAdds the public API',
            author_name: 'Alice Example',
            author_email: 'alice@example.com',
            committed_date: '2026-01-01T10:00:00Z',
            parent_ids: ['parent-one'],
          },
        ])
        : null),
    ]);

    const app = createApp();
    const response = await request(app).get('/api/gitlab/mrs/commits?directory=%2Ftmp%2Fwork&number=9');

    expect(response.status).toBe(200);
    expect(response.body).toMatchObject({
      connected: true,
      repo: { namespace: 'group', project: 'sub' },
      commits: [
        {
          sha: 'abc123def456',
          shortSha: 'abc123d',
          message: 'Add the API\n\nAdds the public API',
          summary: 'Add the API',
          authorName: 'Alice Example',
          committedAt: '2026-01-01T10:00:00Z',
          parents: ['parent-one'],
        },
      ],
    });
  });

  test('mrs/timeline keeps only system notes and infers event types', async () => {
    scriptedFetch([
      (url) => (matches(/\/merge_requests\/9\/notes\?/)(url)
        ? jsonResponse([
          { id: 1, body: 'alice merged changes', system: true, author: { id: 42, username: 'alice' }, created_at: '2026-01-02T11:00:00Z' },
          { id: 2, body: 'Looks good to me', system: false, author: { id: 42, username: 'alice' }, created_at: '2026-01-02T12:00:00Z' },
          { id: 3, body: 'removed label bug', system: true, author: { id: 1, username: 'system' }, created_at: '2026-01-02T13:00:00Z' },
        ])
        : null),
    ]);

    const app = createApp();
    const response = await request(app).get('/api/gitlab/mrs/timeline?directory=%2Ftmp%2Fwork&number=9');

    expect(response.status).toBe(200);
    expect(response.body).toMatchObject({
      connected: true,
      events: [
        { id: '1', type: 'merged', body: 'alice merged changes', author: { username: 'alice', id: 42 }, createdAt: '2026-01-02T11:00:00Z' },
        { id: '3', type: 'unlabeled', body: 'removed label bug', createdAt: '2026-01-02T13:00:00Z' },
      ],
    });
  });

  test('mrs/commits and mrs/timeline report connected:false when not authenticated', async () => {
    clearGitLabAuth();
    const app = createApp();
    const commits = await request(app).get('/api/gitlab/mrs/commits?directory=%2Ftmp%2Fwork&number=9');
    const timeline = await request(app).get('/api/gitlab/mrs/timeline?directory=%2Ftmp%2Fwork&number=9');
    expect(commits.body).toMatchObject({ connected: false, commits: [] });
    expect(timeline.body).toMatchObject({ connected: false, events: [] });
  });

  test('issues/comment POSTs a note and links it to the issue URL', async () => {
    const fetchMock = scriptedFetch([
      (url, options) => {
        if (matches(/\/issues\/7$/)(url) && (!options.method || options.method === 'GET')) {
          return jsonResponse({ iid: 7, web_url: 'https://gitlab.com/group/sub/-/issues/7' });
        }
        if (matches(/\/issues\/7\/notes$/)(url) && options.method === 'POST') {
          return jsonResponse({ id: 5, body: 'Nice catch', author: { id: 42, username: 'alice', name: 'Alice Example' } }, { status: 201 });
        }
        return null;
      },
    ]);

    const app = createApp();
    const response = await request(app)
      .post('/api/gitlab/issues/comment')
      .send({ directory: '/tmp/work', number: 7, body: 'Nice catch' });

    expect(response.status).toBe(200);
    expect(response.body).toMatchObject({
      connected: true,
      repo: { namespace: 'group', project: 'sub', host: 'gitlab.com' },
      comment: {
        id: 5,
        url: 'https://gitlab.com/group/sub/-/issues/7#note_5',
        body: 'Nice catch',
        author: { username: 'alice', name: 'Alice Example', id: 42 },
      },
    });
    const [, options] = fetchMock.mock.calls[1];
    expect(options.method).toBe('POST');
    expect(JSON.parse(options.body)).toEqual({ body: 'Nice catch' });
  });

  test('issues/comment reports connected:false when not authenticated', async () => {
    clearGitLabAuth();
    const app = createApp();
    const response = await request(app)
      .post('/api/gitlab/issues/comment')
      .send({ directory: '/tmp/work', number: 7, body: 'hello' });
    expect(response.status).toBe(200);
    expect(response.body).toEqual({ connected: false });
  });

  test('issues/comment surfaces a 403 as an api-scope error', async () => {
    scriptedFetch([
      (url, options) => {
        if (matches(/\/issues\/7$/)(url)) {
          return jsonResponse({ iid: 7, web_url: 'https://gitlab.com/group/sub/-/issues/7' });
        }
        if (matches(/\/issues\/7\/notes$/)(url) && options.method === 'POST') {
          return jsonResponse({ message: '403 Forbidden' }, { status: 403 });
        }
        return null;
      },
    ]);

    const app = createApp();
    const response = await request(app)
      .post('/api/gitlab/issues/comment')
      .send({ directory: '/tmp/work', number: 7, body: 'hello' });
    expect(response.status).toBe(400);
    expect(response.body).toEqual({ error: 'Your GitLab token needs the api scope to create issue comments' });
  });

  test('issues/update maps state_event, labels, assignee_ids, and resolves the milestone title', async () => {
    const fetchMock = scriptedFetch([
      (url) => (matches(/\/milestones\?/)(url)
        ? jsonResponse([{ id: 33, title: 'v1.0', state: 'active' }])
        : null),
      (url, options) => {
        if (matches(/\/issues\/7$/)(url) && options.method === 'PUT') {
          return jsonResponse({
            iid: 7,
            title: 'Updated issue',
            web_url: 'https://gitlab.com/group/sub/-/issues/7',
            state: 'closed',
            description: 'New body',
            author: { id: 42, username: 'alice', name: 'Alice Example' },
            labels: ['bug'],
            assignees: [{ id: 43, username: 'bob' }],
            milestone: { id: 33, title: 'v1.0', state: 'active' },
          });
        }
        return null;
      },
    ]);

    const app = createApp();
    const response = await request(app)
      .put('/api/gitlab/issues/update')
      .send({
        directory: '/tmp/work',
        number: 7,
        title: 'Updated issue',
        body: 'New body',
        state: 'closed',
        labels: ['bug'],
        assigneeIds: [43],
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
        milestone: { title: 'v1.0', state: 'active' },
      },
    });
    const [, options] = fetchMock.mock.calls[1];
    expect(options.method).toBe('PUT');
    expect(JSON.parse(options.body)).toEqual({
      title: 'Updated issue',
      description: 'New body',
      state_event: 'close',
      labels: ['bug'],
      assignee_ids: [43],
      milestone_id: 33,
    });
  });

  test('issues/update maps state open to state_event reopen', async () => {
    const fetchMock = scriptedFetch([
      (url, options) => {
        if (matches(/\/issues\/7$/)(url) && options.method === 'PUT') {
          return jsonResponse({ iid: 7, title: 'T', web_url: 'u', state: 'opened', author: {} });
        }
        return null;
      },
    ]);

    const app = createApp();
    await request(app)
      .put('/api/gitlab/issues/update')
      .send({ directory: '/tmp/work', number: 7, state: 'open' });

    const [, options] = fetchMock.mock.calls[0];
    expect(JSON.parse(options.body)).toEqual({ state_event: 'reopen' });
  });

  test('issues/update clears the milestone when null is sent', async () => {
    const fetchMock = scriptedFetch([
      (url, options) => {
        if (matches(/\/issues\/7$/)(url) && options.method === 'PUT') {
          return jsonResponse({ iid: 7, title: 'T', web_url: 'u', state: 'opened', author: {} });
        }
        return null;
      },
    ]);

    const app = createApp();
    await request(app)
      .put('/api/gitlab/issues/update')
      .send({ directory: '/tmp/work', number: 7, milestone: null });

    const [, options] = fetchMock.mock.calls[0];
    expect(JSON.parse(options.body)).toEqual({ milestone_id: null });
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
      .put('/api/gitlab/issues/update')
      .send({ directory: '/tmp/work', number: 7, milestone: 'v2.0' });
    expect(response.status).toBe(400);
    expect(response.body).toEqual({ error: 'Milestone not found' });
  });

  test('mrs/comment POSTs an MR note and links it to the MR URL', async () => {
    const fetchMock = scriptedFetch([
      (url, options) => {
        if (matches(/\/merge_requests\/12$/)(url) && (!options.method || options.method === 'GET')) {
          return jsonResponse({ iid: 12, web_url: 'https://gitlab.com/group/sub/-/merge_requests/12' });
        }
        if (matches(/\/merge_requests\/12\/notes$/)(url) && options.method === 'POST') {
          return jsonResponse({ id: 8, body: 'LGTM', author: { id: 43, username: 'bob' } }, { status: 201 });
        }
        return null;
      },
    ]);

    const app = createApp();
    const response = await request(app)
      .post('/api/gitlab/mrs/comment')
      .send({ directory: '/tmp/work', number: 12, body: 'LGTM' });

    expect(response.status).toBe(200);
    expect(response.body).toMatchObject({
      connected: true,
      comment: {
        id: 8,
        url: 'https://gitlab.com/group/sub/-/merge_requests/12#note_8',
        body: 'LGTM',
        author: { username: 'bob', id: 43 },
      },
    });
    const [, options] = fetchMock.mock.calls[1];
    expect(options.method).toBe('POST');
    expect(JSON.parse(options.body)).toEqual({ body: 'LGTM' });
  });

  test('mrs/approve POSTs the approve request and reports approved:true', async () => {
    const fetchMock = scriptedFetch([
      (url, options) => {
        if (matches(/\/merge_requests\/12\/approve$/)(url) && options.method === 'POST') {
          return jsonResponse({ id: 1, state: 'approved' });
        }
        return null;
      },
    ]);

    const app = createApp();
    const response = await request(app)
      .post('/api/gitlab/mrs/approve')
      .send({ directory: '/tmp/work', number: 12 });

    expect(response.status).toBe(200);
    expect(response.body).toMatchObject({
      connected: true,
      repo: { namespace: 'group', project: 'sub', host: 'gitlab.com' },
      approved: true,
    });
    const [, options] = fetchMock.mock.calls[0];
    expect(options.method).toBe('POST');
  });

  test('mrs/approve returns 404 for a missing merge request', async () => {
    scriptedFetch([
      (url, options) => {
        if (matches(/\/merge_requests\/999\/approve$/)(url) && options.method === 'POST') {
          return jsonResponse({ message: '404 Not Found' }, { status: 404 });
        }
        return null;
      },
    ]);

    const app = createApp();
    const response = await request(app)
      .post('/api/gitlab/mrs/approve')
      .send({ directory: '/tmp/work', number: 999 });
    expect(response.status).toBe(404);
    expect(response.body).toEqual({ error: 'Merge request not found' });
  });

  test('mrs/update maps state, labels, assignee_ids, and resolves the milestone title', async () => {
    const fetchMock = scriptedFetch([
      (url) => (matches(/\/milestones\?/)(url)
        ? jsonResponse([{ id: 33, title: 'v1.0', state: 'active' }])
        : null),
      (url, options) => {
        if (matches(/\/merge_requests\/12$/)(url) && options.method === 'PUT') {
          return jsonResponse({
            iid: 12,
            title: 'Updated title',
            web_url: 'https://gitlab.com/group/sub/-/merge_requests/12',
            state: 'opened',
            draft: false,
            work_in_progress: false,
            author: { id: 42, username: 'alice', name: 'Alice Example', avatar_url: 'https://gitlab.com/alice.png' },
            source_branch: 'feat/add',
            target_branch: 'main',
          });
        }
        return null;
      },
    ]);

    const app = createApp();
    const response = await request(app)
      .put('/api/gitlab/mrs/update')
      .send({
        directory: '/tmp/work',
        number: 12,
        title: 'Updated title',
        state: 'open',
        labels: ['ready'],
        assigneeIds: [43],
        milestone: 'v1.0',
      });

    expect(response.status).toBe(200);
    expect(response.body).toMatchObject({
      connected: true,
      mr: { number: 12, title: 'Updated title', state: 'opened' },
    });
    const [, options] = fetchMock.mock.calls[1];
    expect(options.method).toBe('PUT');
    expect(JSON.parse(options.body)).toEqual({
      title: 'Updated title',
      state_event: 'reopen',
      labels: ['ready'],
      assignee_ids: [43],
      milestone_id: 33,
    });
  });

  test('mrs/update returns 400 when the milestone title does not match', async () => {
    scriptedFetch([
      (url) => (matches(/\/milestones\?/)(url)
        ? jsonResponse([{ id: 33, title: 'v1.0' }])
        : null),
    ]);

    const app = createApp();
    const response = await request(app)
      .put('/api/gitlab/mrs/update')
      .send({ directory: '/tmp/work', number: 12, milestone: 'nope' });
    expect(response.status).toBe(400);
    expect(response.body).toEqual({ error: 'Milestone not found' });
  });

  // NOTE: keep this test last in the file. The rate-limit cooldown is
  // module-level and has no reset export, so tests after it would short-circuit.
  test('data routes surface a 503 when GitLab rate limits', async () => {
    scriptedFetch([(url) => (matches(/\/issues\?/)(url) ? jsonResponse({}, { status: 429, headers: { 'retry-after': '30' } }) : null)]);

    const app = createApp();
    const response = await request(app).get('/api/gitlab/issues/list?directory=%2Ftmp%2Fwork');
    expect(response.status).toBe(503);
    expect(response.body).toEqual({ error: 'GitLab rate limited' });
  });
});
