import fs from 'fs';
import os from 'os';
import path from 'path';
import { afterAll, afterEach, describe, expect, test, vi } from 'vitest';

// Isolate auth storage so getGitLabClientOrNull never reads a real account.
const TEMP_DATA_DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'openchamber-gitlab-client-'));
process.env.OPENCHAMBER_DATA_DIR = TEMP_DATA_DIR;

afterAll(() => {
  fs.rmSync(TEMP_DATA_DIR, { recursive: true, force: true });
});

const {
  createGitLabClient,
  getGitLabClientOrNull,
  isGitLabRateLimited,
  noteGitLabRateLimit,
} = await import('./client.js');

const jsonResponse = (data, { status = 200, headers = {} } = {}) =>
  new Response(JSON.stringify(data), { status, headers: { 'content-type': 'application/json', ...headers } });

const originalFetch = globalThis.fetch;

afterEach(() => {
  globalThis.fetch = originalFetch;
});

describe('createGitLabClient request basics', () => {
  test('calls {baseUrl}/api/v4{path} and sends PRIVATE-TOKEN', async () => {
    const fetchMock = vi.fn(async () => jsonResponse({ id: 42, username: 'alice' }));
    globalThis.fetch = fetchMock;

    const client = createGitLabClient({ token: 'glpat-token', baseUrl: 'https://gitlab.com' });
    const result = await client.user();

    expect(fetchMock).toHaveBeenCalledTimes(1);
    const [url, options] = fetchMock.mock.calls[0];
    expect(String(url)).toBe('https://gitlab.com/api/v4/user');
    expect(options.headers['PRIVATE-TOKEN']).toBe('glpat-token');
    expect(result).toMatchObject({ status: 200, data: { id: 42, username: 'alice' } });
    expect(result.error).toBeUndefined();
  });

  test('joins a custom base URL without duplicating /api/v4', async () => {
    const fetchMock = vi.fn(async () => jsonResponse([]));
    globalThis.fetch = fetchMock;

    const client = createGitLabClient({ token: 't', baseUrl: 'https://gitlab.example.com/gitlab/' });
    await client.issues('group/sub', { state: 'opened' });

    const [url] = fetchMock.mock.calls[0];
    expect(String(url)).toBe('https://gitlab.example.com/gitlab/api/v4/projects/group%2Fsub/issues?state=opened');
  });

  test('encodes project path namespaces exactly once', async () => {
    const fetchMock = vi.fn(async () => jsonResponse([]));
    globalThis.fetch = fetchMock;

    const client = createGitLabClient({ token: 't', baseUrl: 'https://gitlab.com' });
    await client.mergeRequest('a/b/c', 5);

    const [url] = fetchMock.mock.calls[0];
    expect(String(url)).toBe('https://gitlab.com/api/v4/projects/a%2Fb%2Fc/merge_requests/5');
    expect(String(url)).not.toContain('%252F');
  });

  test('serializes query params and omits empty ones', async () => {
    const fetchMock = vi.fn(async () => jsonResponse([]));
    globalThis.fetch = fetchMock;

    const client = createGitLabClient({ token: 't', baseUrl: 'https://gitlab.com' });
    await client.mergeRequests('g/p', { state: 'opened', per_page: 50, page: 2, search: '', sort: null });

    const [url] = fetchMock.mock.calls[0];
    const query = String(url).split('?')[1];
    expect(query).toContain('state=opened');
    expect(query).toContain('per_page=50');
    expect(query).toContain('page=2');
    expect(query).not.toContain('search');
    expect(query).not.toContain('sort');
  });

  test('POST requests send a JSON body', async () => {
    const fetchMock = vi.fn(async () => jsonResponse({ ok: true }, { status: 201 }));
    globalThis.fetch = fetchMock;

    const client = createGitLabClient({ token: 't', baseUrl: 'https://gitlab.com' });
    await client.request('/some/action', { method: 'POST', body: { hello: 'world' } });

    const [, options] = fetchMock.mock.calls[0];
    expect(options.method).toBe('POST');
    expect(options.headers['content-type']).toBe('application/json');
    expect(options.body).toBe(JSON.stringify({ hello: 'world' }));
  });

  test('surfaces error statuses without throwing', async () => {
    const fetchMock = vi.fn(async () => jsonResponse({ message: 'nope' }, { status: 401 }));
    globalThis.fetch = fetchMock;

    const client = createGitLabClient({ token: 't', baseUrl: 'https://gitlab.com' });
    const result = await client.user();
    expect(result.status).toBe(401);
    expect(result.data).toEqual({ message: 'nope' });
  });

  test('attaches a caller signal when provided, else a timeout signal', async () => {
    const fetchMock = vi.fn(async () => jsonResponse([]));
    globalThis.fetch = fetchMock;

    const client = createGitLabClient({ token: 't', baseUrl: 'https://gitlab.com' });
    const controller = new AbortController();
    await client.branches('g/p', { per_page: 100 });
    await client.request('/user', { signal: controller.signal });

    expect(fetchMock).toHaveBeenCalledTimes(2);
    expect(fetchMock.mock.calls[0][1].signal).toEqual(expect.any(AbortSignal));
    expect(fetchMock.mock.calls[1][1].signal).toBe(controller.signal);
  });
});

describe('pagination', () => {
  test('parses x-page/x-next-page headers into the page object', async () => {
    const fetchMock = vi.fn(async () => jsonResponse([], {
      headers: { 'x-page': '2', 'x-next-page': '3', 'x-total-pages': '5' },
    }));
    globalThis.fetch = fetchMock;

    const client = createGitLabClient({ token: 't', baseUrl: 'https://gitlab.com' });
    const result = await client.issues('g/p', { page: 2 });
    expect(result.page).toEqual({ page: 2, next: 3, total: 5, hasMore: true });
  });

  test('falls back to the Link rel=next header when x-next-page is absent', async () => {
    const fetchMock = vi.fn(async () => jsonResponse([], {
      headers: { link: '<https://gitlab.com/api/v4/projects/g%2Fp/issues?page=3>; rel="next", <...>; rel="last"' },
    }));
    globalThis.fetch = fetchMock;

    const client = createGitLabClient({ token: 't', baseUrl: 'https://gitlab.com' });
    const result = await client.issues('g/p', { page: 2 });
    expect(result.page.hasMore).toBe(true);
    expect(result.page.nextUrl).toBe('https://gitlab.com/api/v4/projects/g%2Fp/issues?page=3');
  });

  test('reports hasMore=false on the last page', async () => {
    const fetchMock = vi.fn(async () => jsonResponse([], {
      headers: { 'x-page': '5', 'x-next-page': '', 'x-total-pages': '5' },
    }));
    globalThis.fetch = fetchMock;

    const client = createGitLabClient({ token: 't', baseUrl: 'https://gitlab.com' });
    const result = await client.issues('g/p', { page: 5 });
    expect(result.page.hasMore).toBe(false);
  });
});

describe('redirect handling', () => {
  test('follows a project-move redirect exactly once, preserving auth headers', async () => {
    const movedUrl = 'https://gitlab.com/api/v4/projects/new%2Fhome/issues';
    const fetchMock = vi.fn(async (url) => {
      if (String(url).includes('/projects/g%2Fp/issues')) {
        return jsonResponse({}, { status: 301, headers: { location: '/api/v4/projects/new%2Fhome/issues' } });
      }
      if (String(url) === movedUrl) {
        return jsonResponse([{ iid: 1 }]);
      }
      return jsonResponse({}, { status: 404 });
    });
    globalThis.fetch = fetchMock;

    const client = createGitLabClient({ token: 'glpat-t', baseUrl: 'https://gitlab.com' });
    const result = await client.issues('g/p');

    expect(fetchMock).toHaveBeenCalledTimes(2);
    expect(result.status).toBe(200);
    expect(result.data).toEqual([{ iid: 1 }]);
    const [, secondOptions] = fetchMock.mock.calls[1];
    expect(secondOptions.headers['PRIVATE-TOKEN']).toBe('glpat-t');
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

    const client = createGitLabClient({ token: 'glpat-t', baseUrl: 'https://gitlab.com' });
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

    const client = createGitLabClient({ token: 'glpat-t', baseUrl: 'https://gitlab.com' });
    await client.request('/thing', { method: 'POST', body: {} });
    await client.request('/thing', { method: 'POST', body: {} });
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });
});

describe('merge request write methods', () => {
  test('createMergeRequest POSTs a JSON body to the merge_requests endpoint', async () => {
    const fetchMock = vi.fn(async () => jsonResponse({ iid: 5, title: 'New MR' }, { status: 201 }));
    globalThis.fetch = fetchMock;

    const client = createGitLabClient({ token: 't', baseUrl: 'https://gitlab.com' });
    const result = await client.createMergeRequest('group/sub', {
      source_branch: 'feat/x',
      target_branch: 'main',
      title: 'New MR',
    });

    const [url, options] = fetchMock.mock.calls[0];
    expect(String(url)).toBe('https://gitlab.com/api/v4/projects/group%2Fsub/merge_requests');
    expect(options.method).toBe('POST');
    expect(options.headers['content-type']).toBe('application/json');
    expect(JSON.parse(options.body)).toEqual({ source_branch: 'feat/x', target_branch: 'main', title: 'New MR' });
    expect(result.status).toBe(201);
    expect(result.data).toEqual({ iid: 5, title: 'New MR' });
  });

  test('updateMergeRequest PUTs a JSON body to the merge request endpoint', async () => {
    const fetchMock = vi.fn(async () => jsonResponse({ iid: 5, title: 'Updated' }));
    globalThis.fetch = fetchMock;

    const client = createGitLabClient({ token: 't', baseUrl: 'https://gitlab.com' });
    await client.updateMergeRequest('group/sub', 5, { title: 'Updated', description: 'Body text' });

    const [url, options] = fetchMock.mock.calls[0];
    expect(String(url)).toBe('https://gitlab.com/api/v4/projects/group%2Fsub/merge_requests/5');
    expect(options.method).toBe('PUT');
    expect(options.headers['content-type']).toBe('application/json');
    expect(JSON.parse(options.body)).toEqual({ title: 'Updated', description: 'Body text' });
  });

  test('mergeMergeRequest PUTs a JSON body to the merge endpoint', async () => {
    const fetchMock = vi.fn(async () => jsonResponse({ iid: 5, state: 'merged' }));
    globalThis.fetch = fetchMock;

    const client = createGitLabClient({ token: 't', baseUrl: 'https://gitlab.com' });
    await client.mergeMergeRequest('group/sub', 5, { squash: true });

    const [url, options] = fetchMock.mock.calls[0];
    expect(String(url)).toBe('https://gitlab.com/api/v4/projects/group%2Fsub/merge_requests/5/merge');
    expect(options.method).toBe('PUT');
    expect(JSON.parse(options.body)).toEqual({ squash: true });
  });

  test('write methods surface error statuses without throwing', async () => {
    const fetchMock = vi.fn(async () => jsonResponse({ message: 'Method Not Allowed' }, { status: 405 }));
    globalThis.fetch = fetchMock;

    const client = createGitLabClient({ token: 't', baseUrl: 'https://gitlab.com' });
    const result = await client.mergeMergeRequest('group/sub', 5, {});
    expect(result.status).toBe(405);
    expect(result.data).toEqual({ message: 'Method Not Allowed' });
  });
});

describe('issue and review write methods', () => {
  test('createIssueNote POSTs a body to the issue notes endpoint', async () => {
    const fetchMock = vi.fn(async () => jsonResponse({ id: 5, body: 'hi' }, { status: 201 }));
    globalThis.fetch = fetchMock;

    const client = createGitLabClient({ token: 't', baseUrl: 'https://gitlab.com' });
    const result = await client.createIssueNote('group/sub', 7, 'Nice catch');

    const [url, options] = fetchMock.mock.calls[0];
    expect(String(url)).toBe('https://gitlab.com/api/v4/projects/group%2Fsub/issues/7/notes');
    expect(options.method).toBe('POST');
    expect(JSON.parse(options.body)).toEqual({ body: 'Nice catch' });
    expect(result.status).toBe(201);
  });

  test('createMrNote POSTs a body to the MR notes endpoint', async () => {
    const fetchMock = vi.fn(async () => jsonResponse({ id: 8, body: 'LGTM' }, { status: 201 }));
    globalThis.fetch = fetchMock;

    const client = createGitLabClient({ token: 't', baseUrl: 'https://gitlab.com' });
    await client.createMrNote('group/sub', 12, 'LGTM');

    const [url, options] = fetchMock.mock.calls[0];
    expect(String(url)).toBe('https://gitlab.com/api/v4/projects/group%2Fsub/merge_requests/12/notes');
    expect(options.method).toBe('POST');
    expect(JSON.parse(options.body)).toEqual({ body: 'LGTM' });
  });

  test('updateIssue PUTs params to the issue endpoint', async () => {
    const fetchMock = vi.fn(async () => jsonResponse({ iid: 7, title: 'Updated' }));
    globalThis.fetch = fetchMock;

    const client = createGitLabClient({ token: 't', baseUrl: 'https://gitlab.com' });
    await client.updateIssue('group/sub', 7, { state_event: 'close', labels: ['bug'], milestone_id: 33 });

    const [url, options] = fetchMock.mock.calls[0];
    expect(String(url)).toBe('https://gitlab.com/api/v4/projects/group%2Fsub/issues/7');
    expect(options.method).toBe('PUT');
    expect(JSON.parse(options.body)).toEqual({ state_event: 'close', labels: ['bug'], milestone_id: 33 });
  });

  test('approveMr POSTs to the approve endpoint', async () => {
    const fetchMock = vi.fn(async () => jsonResponse({ id: 1, state: 'approved' }));
    globalThis.fetch = fetchMock;

    const client = createGitLabClient({ token: 't', baseUrl: 'https://gitlab.com' });
    await client.approveMr('group/sub', 12);

    const [url, options] = fetchMock.mock.calls[0];
    expect(String(url)).toBe('https://gitlab.com/api/v4/projects/group%2Fsub/merge_requests/12/approve');
    expect(options.method).toBe('POST');
  });

  test('milestones GETs the project milestones list', async () => {
    const fetchMock = vi.fn(async () => jsonResponse([{ id: 33, title: 'v1.0' }]));
    globalThis.fetch = fetchMock;

    const client = createGitLabClient({ token: 't', baseUrl: 'https://gitlab.com' });
    await client.milestones('group/sub', { state: 'all', per_page: 100 });

    const [url] = fetchMock.mock.calls[0];
    expect(String(url)).toBe('https://gitlab.com/api/v4/projects/group%2Fsub/milestones?state=all&per_page=100');
  });
});

describe('rate limiting', () => {
  // NOTE: these tests run last in this file. The rate-limit cooldown is
  // module-level and has no reset export, so earlier tests must not set one.
  test('429 surfaces error and records a cooldown', async () => {
    const fetchMock = vi.fn(async () => jsonResponse({}, { status: 429, headers: { 'retry-after': '5' } }));
    globalThis.fetch = fetchMock;

    const client = createGitLabClient({ token: 'glpat-t', baseUrl: 'https://gitlab.com' });
    const result = await client.user();
    expect(result.status).toBe(429);
    expect(result.error).toBe('GitLab rate limited');
    expect(isGitLabRateLimited()).toBe(true);
  });

  test('short-circuits while the cooldown is active without calling fetch', async () => {
    noteGitLabRateLimit({ headers: new Headers({ 'retry-after': '120' }) });
    const fetchMock = vi.fn(async () => jsonResponse([]));
    globalThis.fetch = fetchMock;

    const client = createGitLabClient({ token: 'glpat-t', baseUrl: 'https://gitlab.com' });
    const gated = await client.issues('g/p');
    expect(gated.status).toBe(429);
    expect(gated.error).toBe('GitLab rate limited');
    expect(fetchMock).not.toHaveBeenCalled();
  });

  test('parses Retry-After seconds into the cooldown', () => {
    noteGitLabRateLimit({ headers: new Headers({ 'retry-after': '120' }) });
    expect(isGitLabRateLimited()).toBe(true);
  });

  test('getGitLabClientOrNull returns null without stored auth', () => {
    expect(getGitLabClientOrNull()).toBeNull();
  });
});
