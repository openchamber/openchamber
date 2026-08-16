import fs from 'fs';
import os from 'os';
import path from 'path';
import { afterAll, afterEach, describe, expect, test, vi } from 'vitest';

// Isolate auth storage so getGiteaClientOrNull never reads a real account.
const TEMP_DATA_DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'openchamber-gitea-client-'));
process.env.OPENCHAMBER_DATA_DIR = TEMP_DATA_DIR;

afterAll(() => {
  fs.rmSync(TEMP_DATA_DIR, { recursive: true, force: true });
});

const {
  createGiteaClient,
  getGiteaClientOrNull,
  isGiteaRateLimited,
  noteGiteaRateLimit,
} = await import('./client.js');

const jsonResponse = (data, { status = 200, headers = {} } = {}) =>
  new Response(JSON.stringify(data), { status, headers: { 'content-type': 'application/json', ...headers } });

const originalFetch = globalThis.fetch;

afterEach(() => {
  globalThis.fetch = originalFetch;
});

describe('createGiteaClient request basics', () => {
  test('calls {baseUrl}/api/v1{path} and sends the token Authorization header', async () => {
    const fetchMock = vi.fn(async () => jsonResponse({ id: 42, login: 'alice' }));
    globalThis.fetch = fetchMock;

    const client = createGiteaClient({ token: 'gitea-token', baseUrl: 'https://gitea.example.com' });
    const result = await client.user();

    expect(fetchMock).toHaveBeenCalledTimes(1);
    const [url, options] = fetchMock.mock.calls[0];
    expect(String(url)).toBe('https://gitea.example.com/api/v1/user');
    expect(options.headers.Authorization).toBe('token gitea-token');
    expect(result).toMatchObject({ status: 200, data: { id: 42, login: 'alice' } });
    expect(result.error).toBeUndefined();
  });

  test('joins a custom base URL with a path without duplicating /api/v1', async () => {
    const fetchMock = vi.fn(async () => jsonResponse([]));
    globalThis.fetch = fetchMock;

    const client = createGiteaClient({ token: 't', baseUrl: 'https://gitea.example.com/gitea/' });
    await client.issues('owner', 'repo', { state: 'open' });

    const [url] = fetchMock.mock.calls[0];
    expect(String(url)).toBe('https://gitea.example.com/gitea/api/v1/repos/owner/repo/issues?state=open');
  });

  test('serializes query params and omits empty ones', async () => {
    const fetchMock = vi.fn(async () => jsonResponse([]));
    globalThis.fetch = fetchMock;

    const client = createGiteaClient({ token: 't', baseUrl: 'https://gitea.example.com' });
    await client.pullRequests('owner', 'repo', { state: 'open', limit: 50, page: 2, q: '', sort: null });

    const [url] = fetchMock.mock.calls[0];
    const query = String(url).split('?')[1];
    expect(query).toContain('state=open');
    expect(query).toContain('limit=50');
    expect(query).toContain('page=2');
    expect(query).not.toContain('q');
    expect(query).not.toContain('sort');
  });

  test('POST requests send a JSON body', async () => {
    const fetchMock = vi.fn(async () => jsonResponse({ ok: true }, { status: 201 }));
    globalThis.fetch = fetchMock;

    const client = createGiteaClient({ token: 't', baseUrl: 'https://gitea.example.com' });
    await client.request('/some/action', { method: 'POST', body: { hello: 'world' } });

    const [, options] = fetchMock.mock.calls[0];
    expect(options.method).toBe('POST');
    expect(options.headers['content-type']).toBe('application/json');
    expect(options.body).toBe(JSON.stringify({ hello: 'world' }));
  });

  test('surfaces error statuses without throwing', async () => {
    const fetchMock = vi.fn(async () => jsonResponse({ message: 'nope' }, { status: 401 }));
    globalThis.fetch = fetchMock;

    const client = createGiteaClient({ token: 't', baseUrl: 'https://gitea.example.com' });
    const result = await client.user();
    expect(result.status).toBe(401);
    expect(result.data).toEqual({ message: 'nope' });
  });

  test('attaches a caller signal when provided, else a timeout signal', async () => {
    const fetchMock = vi.fn(async () => jsonResponse([]));
    globalThis.fetch = fetchMock;

    const client = createGiteaClient({ token: 't', baseUrl: 'https://gitea.example.com' });
    const controller = new AbortController();
    await client.branches('owner', 'repo', { limit: 50 });
    await client.request('/user', { signal: controller.signal });

    expect(fetchMock).toHaveBeenCalledTimes(2);
    expect(fetchMock.mock.calls[0][1].signal).toEqual(expect.any(AbortSignal));
    expect(fetchMock.mock.calls[1][1].signal).toBe(controller.signal);
  });

  test('raw requests return the body as text', async () => {
    const fetchMock = vi.fn(async () => new Response('diff --git a/src/a.ts b/src/a.ts\n', { status: 200 }));
    globalThis.fetch = fetchMock;

    const client = createGiteaClient({ token: 't', baseUrl: 'https://gitea.example.com' });
    const result = await client.pullRequestDiff('owner', 'repo', 5);

    const [url, options] = fetchMock.mock.calls[0];
    expect(String(url)).toBe('https://gitea.example.com/api/v1/repos/owner/repo/pulls/5.diff');
    expect(options.headers.accept).toBe('text/plain');
    expect(result.status).toBe(200);
    expect(result.data).toBe('diff --git a/src/a.ts b/src/a.ts\n');
  });
});

describe('pagination', () => {
  test('parses the Link rel=next header into the page object', async () => {
    const fetchMock = vi.fn(async () => jsonResponse([], {
      headers: {
        link: '<https://gitea.example.com/api/v1/repos/o/r/issues?page=3>; rel="next", <...>; rel="last"',
        'x-total-count': '57',
      },
    }));
    globalThis.fetch = fetchMock;

    const client = createGiteaClient({ token: 't', baseUrl: 'https://gitea.example.com' });
    const result = await client.issues('o', 'r', { page: 2 });
    expect(result.page.hasMore).toBe(true);
    expect(result.page.nextUrl).toBe('https://gitea.example.com/api/v1/repos/o/r/issues?page=3');
    expect(result.page.total).toBe(57);
  });

  test('reports hasMore=false on the last page', async () => {
    const fetchMock = vi.fn(async () => jsonResponse([], { headers: {} }));
    globalThis.fetch = fetchMock;

    const client = createGiteaClient({ token: 't', baseUrl: 'https://gitea.example.com' });
    const result = await client.issues('o', 'r', { page: 1 });
    expect(result.page.hasMore).toBe(false);
  });
});

describe('redirect handling', () => {
  test('follows a redirect exactly once, preserving the Authorization header', async () => {
    const movedUrl = 'https://gitea.example.com/api/v1/repos/newowner/home/issues';
    const fetchMock = vi.fn(async (url) => {
      if (String(url).includes('/repos/owner/repo/issues')) {
        return jsonResponse({}, { status: 301, headers: { location: '/api/v1/repos/newowner/home/issues' } });
      }
      if (String(url) === movedUrl) {
        return jsonResponse([{ number: 1 }]);
      }
      return jsonResponse({}, { status: 404 });
    });
    globalThis.fetch = fetchMock;

    const client = createGiteaClient({ token: 'gitea-t', baseUrl: 'https://gitea.example.com' });
    const result = await client.issues('owner', 'repo');

    expect(fetchMock).toHaveBeenCalledTimes(2);
    expect(result.status).toBe(200);
    expect(result.data).toEqual([{ number: 1 }]);
    const [, secondOptions] = fetchMock.mock.calls[1];
    expect(secondOptions.headers.Authorization).toBe('token gitea-t');
  });
});

describe('etag conditional cache', () => {
  test('sends if-none-match and replays a 304 as a 200 with cached body', async () => {
    const fetchMock = vi.fn(async (_url, options) => {
      if (options.headers['if-none-match'] === '"v1"') {
        return new Response(null, { status: 304 });
      }
      return jsonResponse({ ok: true }, { headers: { etag: '"v1"' } });
    });
    globalThis.fetch = fetchMock;

    const client = createGiteaClient({ token: 'gitea-t', baseUrl: 'https://gitea.example.com' });
    const first = await client.user();
    expect(first.status).toBe(200);
    expect(first.data).toEqual({ ok: true });

    const second = await client.user();
    expect(fetchMock).toHaveBeenCalledTimes(2);
    expect(fetchMock.mock.calls[1][1].headers['if-none-match']).toBe('"v1"');
    expect(second.status).toBe(200);
    expect(second.data).toEqual({ ok: true });
  });

  test('does not cache POST responses', async () => {
    const fetchMock = vi.fn(async () => jsonResponse({ ok: true }));
    globalThis.fetch = fetchMock;

    const client = createGiteaClient({ token: 'gitea-t', baseUrl: 'https://gitea.example.com' });
    await client.request('/thing', { method: 'POST', body: {} });
    await client.request('/thing', { method: 'POST', body: {} });
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });
});

describe('pull request write methods', () => {
  test('createPullRequest POSTs title/head/base to the pulls endpoint', async () => {
    const fetchMock = vi.fn(async () => jsonResponse({ number: 5, title: 'New PR' }, { status: 201 }));
    globalThis.fetch = fetchMock;

    const client = createGiteaClient({ token: 't', baseUrl: 'https://gitea.example.com' });
    const result = await client.createPullRequest('owner', 'repo', {
      title: 'New PR',
      head: 'feat/x',
      base: 'main',
    });

    const [url, options] = fetchMock.mock.calls[0];
    expect(String(url)).toBe('https://gitea.example.com/api/v1/repos/owner/repo/pulls');
    expect(options.method).toBe('POST');
    expect(options.headers['content-type']).toBe('application/json');
    expect(JSON.parse(options.body)).toEqual({ title: 'New PR', head: 'feat/x', base: 'main' });
    expect(result.status).toBe(201);
    expect(result.data).toEqual({ number: 5, title: 'New PR' });
  });

  test('updatePullRequest PATCHes a JSON body to the pull request endpoint', async () => {
    const fetchMock = vi.fn(async () => jsonResponse({ number: 5, title: 'Updated' }));
    globalThis.fetch = fetchMock;

    const client = createGiteaClient({ token: 't', baseUrl: 'https://gitea.example.com' });
    await client.updatePullRequest('owner', 'repo', 5, { title: 'Updated', body: 'Body text' });

    const [url, options] = fetchMock.mock.calls[0];
    expect(String(url)).toBe('https://gitea.example.com/api/v1/repos/owner/repo/pulls/5');
    expect(options.method).toBe('PATCH');
    expect(options.headers['content-type']).toBe('application/json');
    expect(JSON.parse(options.body)).toEqual({ title: 'Updated', body: 'Body text' });
  });

  test('mergePullRequest POSTs the merge style in Do to the merge endpoint', async () => {
    const fetchMock = vi.fn(async () => jsonResponse({ merged: true }));
    globalThis.fetch = fetchMock;

    const client = createGiteaClient({ token: 't', baseUrl: 'https://gitea.example.com' });
    await client.mergePullRequest('owner', 'repo', 5, { Do: 'squash' });

    const [url, options] = fetchMock.mock.calls[0];
    expect(String(url)).toBe('https://gitea.example.com/api/v1/repos/owner/repo/pulls/5/merge');
    expect(options.method).toBe('POST');
    expect(JSON.parse(options.body)).toEqual({ Do: 'squash' });
  });

  test('write methods surface error statuses without throwing', async () => {
    const fetchMock = vi.fn(async () => jsonResponse({ message: 'Conflict' }, { status: 409 }));
    globalThis.fetch = fetchMock;

    const client = createGiteaClient({ token: 't', baseUrl: 'https://gitea.example.com' });
    const result = await client.mergePullRequest('owner', 'repo', 5, { Do: 'merge' });
    expect(result.status).toBe(409);
    expect(result.data).toEqual({ message: 'Conflict' });
  });
});

describe('issue, review, and repo write methods', () => {
  test('createIssueComment POSTs a body to the issue comments endpoint', async () => {
    const fetchMock = vi.fn(async () => jsonResponse({ id: 5, body: 'hi' }, { status: 201 }));
    globalThis.fetch = fetchMock;

    const client = createGiteaClient({ token: 't', baseUrl: 'https://gitea.example.com' });
    const result = await client.createIssueComment('owner', 'repo', 7, 'Nice catch');

    const [url, options] = fetchMock.mock.calls[0];
    expect(String(url)).toBe('https://gitea.example.com/api/v1/repos/owner/repo/issues/7/comments');
    expect(options.method).toBe('POST');
    expect(JSON.parse(options.body)).toEqual({ body: 'Nice catch' });
    expect(result.status).toBe(201);
  });

  test('updateIssue PATCHes params to the issue endpoint', async () => {
    const fetchMock = vi.fn(async () => jsonResponse({ number: 7, title: 'Updated' }));
    globalThis.fetch = fetchMock;

    const client = createGiteaClient({ token: 't', baseUrl: 'https://gitea.example.com' });
    await client.updateIssue('owner', 'repo', 7, { state: 'closed', labels: ['bug'], milestone: 33 });

    const [url, options] = fetchMock.mock.calls[0];
    expect(String(url)).toBe('https://gitea.example.com/api/v1/repos/owner/repo/issues/7');
    expect(options.method).toBe('PATCH');
    expect(JSON.parse(options.body)).toEqual({ state: 'closed', labels: ['bug'], milestone: 33 });
  });

  test('createPullReview POSTs event/body to the reviews endpoint', async () => {
    const fetchMock = vi.fn(async () => jsonResponse({ id: 101, state: 'APPROVED' }, { status: 201 }));
    globalThis.fetch = fetchMock;

    const client = createGiteaClient({ token: 't', baseUrl: 'https://gitea.example.com' });
    await client.createPullReview('owner', 'repo', 12, { event: 'APPROVED', body: 'LGTM' });

    const [url, options] = fetchMock.mock.calls[0];
    expect(String(url)).toBe('https://gitea.example.com/api/v1/repos/owner/repo/pulls/12/reviews');
    expect(options.method).toBe('POST');
    expect(JSON.parse(options.body)).toEqual({ event: 'APPROVED', body: 'LGTM' });
  });

  test('milestones GETs the repo milestones list', async () => {
    const fetchMock = vi.fn(async () => jsonResponse([{ id: 33, title: 'v1.0' }]));
    globalThis.fetch = fetchMock;

    const client = createGiteaClient({ token: 't', baseUrl: 'https://gitea.example.com' });
    await client.milestones('owner', 'repo', { state: 'all', limit: 50 });

    const [url] = fetchMock.mock.calls[0];
    expect(String(url)).toBe('https://gitea.example.com/api/v1/repos/owner/repo/milestones?state=all&limit=50');
  });

  test('repoLabels GETs the repo labels list', async () => {
    const fetchMock = vi.fn(async () => jsonResponse([{ id: 1, name: 'bug', color: 'd73a4a' }]));
    globalThis.fetch = fetchMock;

    const client = createGiteaClient({ token: 't', baseUrl: 'https://gitea.example.com' });
    await client.repoLabels('owner', 'repo', { limit: 100 });

    const [url] = fetchMock.mock.calls[0];
    expect(String(url)).toBe('https://gitea.example.com/api/v1/repos/owner/repo/labels?limit=100');
  });
});

describe('rate limiting', () => {
  // NOTE: these tests run last in this file. The rate-limit cooldown is
  // module-level and has no reset export, so earlier tests must not set one.
  test('429 surfaces error and records a cooldown', async () => {
    const fetchMock = vi.fn(async () => jsonResponse({}, { status: 429, headers: { 'retry-after': '5' } }));
    globalThis.fetch = fetchMock;

    const client = createGiteaClient({ token: 'gitea-t', baseUrl: 'https://gitea.example.com' });
    const result = await client.user();
    expect(result.status).toBe(429);
    expect(result.error).toBe('Gitea rate limited');
    expect(isGiteaRateLimited()).toBe(true);
  });

  test('short-circuits while the cooldown is active without calling fetch', async () => {
    noteGiteaRateLimit({ headers: new Headers({ 'retry-after': '120' }) });
    const fetchMock = vi.fn(async () => jsonResponse([]));
    globalThis.fetch = fetchMock;

    const client = createGiteaClient({ token: 'gitea-t', baseUrl: 'https://gitea.example.com' });
    const gated = await client.issues('o', 'r');
    expect(gated.status).toBe(429);
    expect(gated.error).toBe('Gitea rate limited');
    expect(fetchMock).not.toHaveBeenCalled();
  });

  test('parses Retry-After seconds into the cooldown', () => {
    noteGiteaRateLimit({ headers: new Headers({ 'retry-after': '120' }) });
    expect(isGiteaRateLimited()).toBe(true);
  });

  test('honors X-RateLimit-Reset for the cooldown', () => {
    noteGiteaRateLimit({ headers: new Headers({ 'x-ratelimit-reset': String(Math.floor(Date.now() / 1000) + 60) }) });
    expect(isGiteaRateLimited()).toBe(true);
  });

  test('getGiteaClientOrNull returns null without stored auth', () => {
    expect(getGiteaClientOrNull()).toBeNull();
  });
});
