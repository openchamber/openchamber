import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import express from 'express';
import request from 'supertest';
import { registerGitHubRoutes } from './routes.js';

const testDir = fs.mkdtempSync(path.join(os.tmpdir(), 'openchamber-github-pulls-'));
const previousDataDir = process.env.OPENCHAMBER_DATA_DIR;
const repository = path.join(testDir, 'project');
const issue = (number) => ({ number, repository_url: 'https://api.github.com/repos/example/project' });
const pull = (number) => ({
  number,
  title: `PR ${number}`,
  html_url: `https://github.com/example/project/pull/${number}`,
  state: 'open',
  base: { ref: 'main' },
  head: { ref: `branch-${number}`, sha: `sha-${number}` },
});

const response = (data, status = 200) => Response.json(data, { status });

// Canonical routes read with the account the repository's binding names; the
// binding service is stubbed to accept the context the client sends.
let accountId = '';
const readContext = (directory) => ({
  provider: 'github',
  instance: 'github.com',
  accountId,
  repositoryId: 'repo-1',
  bindingRevision: '1',
  primaryRemote: 'origin',
  directory,
});
const routeOptions = () => ({
  validateReadContext: vi.fn(async (context) => ({ ...context, bindingRevision: Number(context.bindingRevision) })),
});

describe('POST /api/source-control/github/references/across', () => {
  const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'openchamber-github-across-'));
  let accounts;
  let app;
  let validate;
  let resolve;
  let network;
  let calls;
  let unauthorized;
  const context = (directory, accountIndex = 0) => ({ ...readContext(directory), accountId: accounts[accountIndex], bindingRevision: 1 });
  const search = (contexts, options = {}) => request(app).post('/api/source-control/github/references/across').send({ contexts, kind: 'issue', ...options });

  beforeAll(() => { process.env.OPENCHAMBER_DATA_DIR = dataDir; });
  beforeEach(async () => {
    const { setGitHubAuth, setGhCliDisabled } = await import('./auth.js');
    setGhCliDisabled(true);
    accounts = await Promise.all([7, 8].map(async (id) => (await setGitHubAuth({ accessToken: `test-account-${id}`, user: { id, login: `user${id}` } })).accountId));
    calls = [];
    unauthorized = false;
    validate = vi.fn(async (input) => {
      if (input.directory === '/invalid') throw Object.assign(new Error('Stale binding'), { code: 'SOURCE_CONTROL_BINDING_STALE', status: 409 });
      return input;
    });
    resolve = vi.fn(async (directory) => ({ repo: directory === '/none' ? null : {
      owner: 'acme', repo: directory === '/alias' ? 'A' : directory.slice(1), url: `https://github.com/acme/${directory.slice(1)}`,
    } }));
    network = vi.fn(async (_octokit, directory, _remote, options) => {
      expect(options).toEqual({ strictErrors: true });
      return [{ owner: 'acme', repo: directory === '/alias' ? 'A' : directory.slice(1), source: 'origin' }];
    });
    app = express();
    app.use(express.json());
    registerGitHubRoutes(app, { validateReadContext: validate, resolveGitHubRepoFromDirectory: resolve, resolveRepoNetwork: network });
    vi.stubGlobal('fetch', vi.fn(async (_url, init) => {
      const body = JSON.parse(init.body);
      const authorization = new Headers(init.headers).get('authorization');
      calls.push({ authorization, variables: body.variables });
      if (unauthorized && authorization === 'token test-account-8') return response({ message: 'Bad credentials' }, 401);
      const names = [...body.variables.q.matchAll(/repo:acme\/([^ ]+)/g)].map((match) => match[1]);
      return response({ data: { search: { issueCount: names.length, pageInfo: { hasNextPage: false, endCursor: null }, nodes: names.map((name, index) => ({
        __typename: 'Issue', number: index + 1, title: name, url: `https://github.com/acme/${name}/issues/1`,
        createdAt: null, updatedAt: '2026-10-01', body: '', author: null, labels: { totalCount: 0, nodes: [] }, comments: { totalCount: 0 },
        repository: { name, owner: { login: 'acme' } }, state: 'OPEN', stateReason: null,
      })) } } });
    }));
  });
  afterEach(() => { vi.unstubAllGlobals(); vi.restoreAllMocks(); });
  afterAll(() => {
    if (previousDataDir === undefined) delete process.env.OPENCHAMBER_DATA_DIR;
    else process.env.OPENCHAMBER_DATA_DIR = previousDataDir;
    fs.rmSync(dataDir, { recursive: true, force: true });
  });

  it('validates every context and retains valid folders alongside invalid and missing repos', async () => {
    const contexts = [context('/a'), context('/invalid'), context('/none')];
    const result = await search(contexts).expect(200);
    expect(validate.mock.calls.map(([input]) => input)).toEqual(contexts);
    expect(resolve.mock.calls.map(([directory]) => directory)).toEqual(['/a', '/none']);
    expect(result.body.items).toEqual([expect.objectContaining({ directory: '/a', title: 'a' })]);
    expect(result.body.repositories).toEqual([
      { directory: '/a', status: 'included', repo: { owner: 'acme', repo: 'a', url: 'https://github.com/acme/a' } },
      { directory: '/invalid', status: 'invalid-context' }, { directory: '/none', status: 'no-repo' },
    ]);
  });

  it('searches separate accounts with their own octokit and never sends the other account repos', async () => {
    const result = await search([context('/a'), context('/b', 1), context('/c')]).expect(200);
    expect(calls).toHaveLength(2);
    const a = calls.find((call) => call.authorization === 'token test-account-7');
    const b = calls.find((call) => call.authorization === 'token test-account-8');
    expect(a.variables.q).toContain('repo:acme/a repo:acme/c');
    expect(a.variables.q).not.toContain('repo:acme/b');
    expect(b.variables.q).toContain('repo:acme/b');
    expect(b.variables.q).not.toContain('repo:acme/a');
    expect(result.body.items.map((item) => item.directory).sort()).toEqual(['/a', '/b', '/c']);
    expect(result.body.repositories.map((repo) => repo.directory)).toEqual(['/a', '/b', '/c']);
  });

  it('deduplicates folders and case-insensitive repos while keeping the first item directory', async () => {
    const result = await search([context('/a'), context('/alias'), context('/a')]).expect(200);
    expect(validate).toHaveBeenCalledTimes(2);
    expect(calls).toHaveLength(1);
    expect(calls[0].variables.q.match(/repo:/g)).toHaveLength(1);
    expect(result.body.items).toEqual([expect.objectContaining({ directory: '/a' })]);
    expect(result.body.repositories.map((repo) => repo.directory)).toEqual(['/a', '/alias', '/a']);
  });

  it('invalidates only the unauthorized account and retains the other group', async () => {
    unauthorized = true;
    const result = await search([context('/a'), context('/b', 1), context('/c', 1)]).expect(200);
    expect(result.body.items.map((item) => item.directory)).toEqual(['/a']);
    expect(result.body.repositories.map((repo) => repo.status)).toEqual(['included', 'disconnected', 'disconnected']);
    const { getGitHubAuthAccounts } = await import('./auth.js');
    const saved = await getGitHubAuthAccounts();
    expect(saved.find((account) => account.accountId === accounts[1] || account.credentialId === accounts[1])?.status).toBe('invalid');
  });

  it('reports a folder that fails or lost its account on its own and keeps the rest', async () => {
    resolve.mockImplementation(async (directory) => {
      if (directory === '/broken') throw new Error('git failed');
      if (directory === '/gone') throw Object.assign(new Error('Account unavailable'), { sourceControlAccountUnavailable: true });
      return { repo: { owner: 'acme', repo: directory.slice(1), url: `https://github.com/acme/${directory.slice(1)}` } };
    });
    vi.spyOn(console, 'error').mockImplementation(() => undefined);
    const result = await search([context('/a'), context('/broken'), context('/gone')]).expect(200);
    expect(result.body.items.map((item) => item.directory)).toEqual(['/a']);
    expect(result.body.repositories.map((repo) => repo.status)).toEqual(['included', 'error', 'disconnected']);
  });

  it('rejects oversized and malformed requests before context or credential access', async () => {
    await search(Array.from({ length: 101 }, (_value, index) => context(`/folder${index}`))).expect(400);
    await search([{ ...context('/a'), provider: 'gitlab' }]).expect(400);
    await search([{ ...context('/a'), bindingRevision: '1' }]).expect(400);
    expect(validate).not.toHaveBeenCalled();
    expect(calls).toHaveLength(0);
  });

  it('accepts the first page as the web client sends it, with a null cursor and binding revision 0', async () => {
    const result = await search([{ ...context('/a'), bindingRevision: 0 }], { state: 'open', people: 'any', query: '', cursor: null }).expect(200);
    expect(result.body.items).toEqual([expect.objectContaining({ directory: '/a' })]);
    expect(calls).toHaveLength(1);
  });

  it('rejects malformed composite cursors without searching either account', async () => {
    await search([context('/a'), context('/b', 1)], { cursor: 'invalid!' }).expect(400);
    expect(calls).toHaveLength(0);
  });
});

describe('GET /api/source-control/github/pulls/list free-text search', () => {
  let app;

  beforeAll(async () => {
    process.env.OPENCHAMBER_DATA_DIR = testDir;
    fs.mkdirSync(repository);
    execFileSync('git', ['init', '-q', repository]);
    execFileSync('git', ['-C', repository, 'remote', 'add', 'origin', 'https://github.com/example/project.git']);
    const { setGitHubAuth, setGhCliDisabled } = await import('./auth.js');
    setGhCliDisabled(true);
    ({ accountId } = await setGitHubAuth({ accessToken: 'fake-test-token', user: { id: 7, login: 'tester' } }));
    app = express();
    registerGitHubRoutes(app, routeOptions());
  });

  afterEach(() => {
    vi.unstubAllGlobals();
    vi.restoreAllMocks();
  });

  afterAll(() => {
    if (previousDataDir === undefined) delete process.env.OPENCHAMBER_DATA_DIR;
    else process.env.OPENCHAMBER_DATA_DIR = previousDataDir;
    fs.rmSync(testDir, { recursive: true, force: true });
  });

  const search = () => request(app).get('/api/source-control/github/pulls/list')
    .query({ ...readContext(repository), query: 'fix' });

  const serveGitHub = ({ numbers = [1, 2], failPulls = [], failSearch = false, networkFailure = false } = {}) => {
    const fetch = vi.fn(async (url) => {
      const endpoint = new URL(url);
      if (endpoint.pathname === '/repos/example/project') return response({ full_name: 'example/project', fork: false });
      if (endpoint.pathname === '/search/issues') {
        if (failSearch) return response({ message: 'GitHub search unavailable' }, 503);
        return response({ total_count: numbers.length, items: numbers.map(issue) });
      }
      const pullNumber = Number(endpoint.pathname.match(/^\/repos\/example\/project\/pulls\/(\d+)$/)?.[1]);
      if (pullNumber) {
        if (networkFailure && failPulls.includes(pullNumber)) throw new Error('Network unavailable');
        if (failPulls.includes(pullNumber)) return response({ message: 'GitHub enrichment unavailable' }, 503);
        return response(pull(pullNumber));
      }
      throw new Error(`Unexpected GitHub request: ${endpoint.pathname}`);
    });
    vi.stubGlobal('fetch', fetch);
    return fetch;
  };

  it('returns all complete PR summaries in search order', async () => {
    serveGitHub();
    const result = await search().expect(200);
    expect(result.body.prs.map((pr) => ({ number: pr.number, base: pr.base, head: pr.head }))).toEqual([
      { number: 1, base: 'main', head: 'branch-1' },
      { number: 2, base: 'main', head: 'branch-2' },
    ]);
    expect(result.body.hasMore).toBe(false);
  });

  it('rejects the page rather than dropping one failed enrichment', async () => {
    const fetch = serveGitHub({ failPulls: [2] });
    vi.spyOn(console, 'error').mockImplementation(() => {});
    const result = await search().expect(500);
    expect(result.body).toEqual({ error: 'GitHub enrichment unavailable' });
    expect(result.body).not.toHaveProperty('prs');
    expect(fetch.mock.calls.some(([url]) => String(url).endsWith('/pulls/1'))).toBe(true);
  });

  it('rejects when every enrichment fails instead of returning an empty success', async () => {
    serveGitHub({ failPulls: [1, 2] });
    vi.spyOn(console, 'error').mockImplementation(() => {});
    const result = await search().expect(500);
    expect(result.body).toEqual({ error: 'GitHub enrichment unavailable' });
  });

  it('propagates a failed network request without returning a partial page', async () => {
    serveGitHub({ failPulls: [2], networkFailure: true });
    vi.spyOn(console, 'error').mockImplementation(() => {});
    expect((await search().expect(500)).body).toEqual({ error: 'Network unavailable' });
  });

  it('still returns a genuinely empty search and propagates search-level errors', async () => {
    serveGitHub({ numbers: [] });
    expect((await search().expect(200)).body.prs).toEqual([]);
    serveGitHub({ failSearch: true });
    vi.spyOn(console, 'error').mockImplementation(() => {});
    expect((await search().expect(500)).body.error).toBe('GitHub search unavailable');
  });
});

describe('GET /api/source-control/github/pulls/context diff cap (#1457)', () => {
  const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'openchamber-github-context-diff-'));
  const directory = path.join(dataDir, 'project');
  let app;
  let diffRequests;

  const DIFF_MAX_BYTES = 50 * 1024 * 1024;
  const diffOfBytes = (totalBytes) => {
    const header = 'diff --git a/big b/big\n';
    return header + 'x'.repeat(totalBytes - header.length);
  };

  const serveGitHub = (diffBody) => {
    const fetch = vi.fn(async (urlString, init) => {
      const url = new URL(urlString);
      const accept = new Headers(init?.headers).get('accept') ?? '';
      const pullMatch = url.pathname.match(/^\/repos\/team\/project\/pulls\/(\d+)$/);
      if (pullMatch) {
        if (accept.includes('vnd.github.v3.diff')) {
          diffRequests += 1;
          return new Response(diffBody, { status: 200, headers: { 'content-type': 'text/plain; charset=utf-8' } });
        }
        return response({
          number: Number(pullMatch[1]),
          title: 'Change',
          html_url: `https://github.com/team/project/pull/${pullMatch[1]}`,
          state: 'open',
          head: { ref: 'feature', sha: 'abc123', repo: null },
          base: { ref: 'main' },
          user: { id: 7, login: 'tester' },
          changed_files: 1,
          merged: false,
        });
      }
      if (url.pathname.endsWith('/check-runs')) return response({ total_count: 0, check_runs: [] });
      if (url.pathname.endsWith('/status')) return response({ statuses: [] });
      return response([]);
    });
    vi.stubGlobal('fetch', fetch);
    return fetch;
  };

  const contextRequest = (number) => request(app).get('/api/source-control/github/pulls/context')
    .query({ ...readContext(directory), number, diff: '1' });

  beforeAll(async () => {
    process.env.OPENCHAMBER_DATA_DIR = dataDir;
    fs.mkdirSync(directory, { recursive: true });
    const { setGitHubAuth, setGhCliDisabled } = await import('./auth.js');
    setGhCliDisabled(true);
    ({ accountId } = await setGitHubAuth({ accessToken: 'fake-test-token', user: { id: 7, login: 'tester' } }));
    app = express();
    app.use(express.json());
    registerGitHubRoutes(app, {
      validateReadContext: vi.fn(async (context) => ({ ...context, bindingRevision: Number(context.bindingRevision) })),
      resolveGitHubRepoFromDirectory: vi.fn(async () => ({ repo: { owner: 'team', repo: 'project' } })),
      resolveRepoNetwork: vi.fn(async () => null),
    });
  });

  beforeEach(() => { diffRequests = 0; });
  afterEach(() => { vi.unstubAllGlobals(); vi.restoreAllMocks(); });
  afterAll(() => {
    if (previousDataDir === undefined) delete process.env.OPENCHAMBER_DATA_DIR;
    else process.env.OPENCHAMBER_DATA_DIR = previousDataDir;
    fs.rmSync(dataDir, { recursive: true, force: true });
  });

  it('refuses an over-cap diff with 413 and neither serves nor caches it whole', async () => {
    serveGitHub(diffOfBytes(DIFF_MAX_BYTES + 1));
    const first = await contextRequest(5).expect(413);
    expect(first.body).toEqual({ error: 'Pull request diff is too large to serve' });
    expect(first.body).not.toHaveProperty('diff');
    expect(first.text).not.toContain('xxxxxxxxxx');
    // A repeat request re-fetches and re-refuses: the over-cap diff was
    // never retained in the response cache.
    const second = await contextRequest(5).expect(413);
    expect(second.body).toEqual({ error: 'Pull request diff is too large to serve' });
    expect(diffRequests).toBe(2);
  }, 60_000);

  it('stops reading the diff at the cap instead of consuming the whole body (#1664)', async () => {
    const CHUNK_BYTES = 1024 * 1024;
    const TOTAL_CHUNKS = 400;
    let pulled = 0;
    const header = new TextEncoder().encode('diff --git a/big b/big\n');
    const body = new ReadableStream({
      pull(controller) {
        if (pulled >= TOTAL_CHUNKS) { controller.close(); return; }
        pulled += 1;
        controller.enqueue(pulled === 1 ? header : new Uint8Array(CHUNK_BYTES).fill(120));
      },
    });
    serveGitHub(body);
    const result = await contextRequest(8).expect(413);
    expect(result.body).toEqual({ error: 'Pull request diff is too large to serve' });
    expect(result.body).not.toHaveProperty('diff');
    // The cap is 50 chunks; the read aborts right after crossing it, not after 400.
    expect(pulled).toBeLessThan(DIFF_MAX_BYTES / CHUNK_BYTES + 5);
  }, 60_000);

  it('serves a diff at exactly the cap byte-identically', async () => {
    const atCap = diffOfBytes(DIFF_MAX_BYTES);
    serveGitHub(atCap);
    const result = await contextRequest(6).expect(200);
    expect(result.body.diff).toBe(atCap);
    expect(Buffer.byteLength(result.body.diff, 'utf8')).toBe(DIFF_MAX_BYTES);
  }, 60_000);

  it('serves an under-cap diff byte-identically', async () => {
    const small = 'diff --git a/a b/a\n+hello\n';
    serveGitHub(small);
    const result = await contextRequest(7).expect(200);
    expect(result.body.diff).toBe(small);
  });
});

describe('GET /api/source-control/github/references', () => {
  let app;
  const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'openchamber-github-references-'));
  const project = path.join(dataDir, 'project');

  beforeAll(async () => {
    process.env.OPENCHAMBER_DATA_DIR = dataDir;
    fs.mkdirSync(project);
    execFileSync('git', ['init', '-q', project]);
    execFileSync('git', ['-C', project, 'remote', 'add', 'origin', 'https://github.com/example/project.git']);
    const { setGitHubAuth, setGhCliDisabled } = await import('./auth.js');
    setGhCliDisabled(true);
    ({ accountId } = await setGitHubAuth({ accessToken: 'fake-test-token', user: { id: 7, login: 'tester' } }));
    app = express();
    registerGitHubRoutes(app, routeOptions());
  });

  afterEach(() => {
    vi.unstubAllGlobals();
    vi.restoreAllMocks();
  });

  afterAll(() => {
    if (previousDataDir === undefined) delete process.env.OPENCHAMBER_DATA_DIR;
    else process.env.OPENCHAMBER_DATA_DIR = previousDataDir;
    fs.rmSync(dataDir, { recursive: true, force: true });
  });

  const issueNode = (number) => ({
    __typename: 'Issue',
    number,
    title: `Issue ${number}`,
    url: `https://github.com/example/project/issues/${number}`,
    createdAt: null,
    updatedAt: null,
    body: '',
    author: null,
    labels: { totalCount: 0, nodes: [] },
    comments: { totalCount: 0 },
    repository: { name: 'project', owner: { login: 'example' } },
    state: 'OPEN',
    stateReason: null,
  });

  // The repo lookup is REST; everything the picker lists is one GraphQL call.
  const serveGitHub = (graphql) => {
    const fetch = vi.fn(async (url, init) => {
      const endpoint = new URL(url);
      if (endpoint.pathname === '/repos/example/project') return response({ full_name: 'example/project', fork: false });
      if (endpoint.pathname === '/graphql') return graphql(JSON.parse(init.body));
      throw new Error(`Unexpected GitHub request: ${endpoint.pathname}`);
    });
    vi.stubGlobal('fetch', fetch);
    return fetch;
  };

  it('requires a directory and a kind', async () => {
    await request(app).get('/api/source-control/github/references').query(readContext(project)).expect(400);
  });

  it('answers a page with one search document', async () => {
    const fetch = serveGitHub((body) => {
      expect(body.variables.q).toBe('repo:example/project is:issue is:open sort:updated-desc author:@me crash');
      return response({ data: { search: { issueCount: 31, pageInfo: { hasNextPage: true, endCursor: 'c1' }, nodes: [issueNode(4), issueNode(2)] } } });
    });

    const res = await request(app).get('/api/source-control/github/references')
      .query({ ...readContext(project), kind: 'issue', state: 'open', people: 'created', query: 'crash' })
      .expect(200);

    expect(res.body).toMatchObject({ connected: true, cursor: 'c1', hasMore: true, total: 31 });
    expect(res.body.items.map((item) => item.number)).toEqual([4, 2]);
    expect(fetch.mock.calls.filter(([url]) => String(url).endsWith('/graphql'))).toHaveLength(1);
  });

  it('reads a pasted number directly', async () => {
    serveGitHub((body) => {
      expect(body.query).toContain('issueOrPullRequest');
      expect(body.variables.number).toBe(4);
      return response({ data: { a0: { issueOrPullRequest: issueNode(4) } } });
    });

    const res = await request(app).get('/api/source-control/github/references')
      .query({ ...readContext(project), kind: 'pull', query: '#4' })
      .expect(200);

    expect(res.body.items).toEqual([expect.objectContaining({ kind: 'issue', number: 4 })]);
    expect(res.body.hasMore).toBe(false);
  });

  it('reads one item detail, only from the project repo network', async () => {
    const fetch = serveGitHub(() => response({ data: { repository: { issueOrPullRequest: {
      __typename: 'PullRequest',
      number: 4,
      state: 'OPEN',
      reviewDecision: 'APPROVED',
      headCommit: { nodes: [] },
      labels: { totalCount: 0, nodes: [] },
      reviewRequests: { totalCount: 0, nodes: [] },
      additions: 1,
      deletions: 2,
      changedFiles: 1,
      comments: { totalCount: 0, nodes: [] },
      reviews: { totalCount: 0, nodes: [] },
      reviewThreads: { totalCount: 0, nodes: [] },
      commits: { totalCount: 0, nodes: [] },
    } } } }));

    const detail = await request(app).get('/api/source-control/github/references/detail')
      .query({ ...readContext(project), owner: 'example', repo: 'project', number: '4' })
      .expect(200);
    expect(detail.body).toEqual({
      connected: true,
      detail: expect.objectContaining({ number: 4, comments: [], pull: expect.objectContaining({ reviewDecision: 'approved', additions: 1 }) }),
    });

    const graphqlCalls = () => fetch.mock.calls.filter(([url]) => String(url).endsWith('/graphql')).length;
    const before = graphqlCalls();
    await request(app).get('/api/source-control/github/references/detail')
      .query({ ...readContext(project), owner: 'someone', repo: 'else', number: '4' })
      .expect(400);
    expect(graphqlCalls()).toBe(before);
  });

  it("reads a repository's labels and assignable people for the board's pickers, only from the project repo network", async () => {
    const fetch = vi.fn(async (url) => {
      const endpoint = new URL(url);
      if (endpoint.pathname === '/repos/example/project') return response({ full_name: 'example/project', fork: false });
      if (endpoint.pathname === '/repos/example/project/labels') return response([{ name: 'bug', color: 'd73a4a' }, { name: 'docs', color: '' }]);
      if (endpoint.pathname === '/repos/example/project/assignees') return response([{ login: 'octo', avatar_url: 'https://avatars/octo' }, { login: 'hubot' }]);
      throw new Error(`Unexpected GitHub request: ${endpoint.pathname}`);
    });
    vi.stubGlobal('fetch', fetch);

    const labels = await request(app).get('/api/source-control/github/references/labels')
      .query({ ...readContext(project), owner: 'example', repo: 'project' }).expect(200);
    const reviewers = await request(app).get('/api/source-control/github/references/reviewers')
      .query({ ...readContext(project), owner: 'example', repo: 'project' }).expect(200);

    expect(labels.body).toEqual({ connected: true, items: [{ name: 'bug', color: 'd73a4a' }, { name: 'docs' }] });
    expect(reviewers.body).toEqual({ connected: true, items: [
      { id: 'octo', login: 'octo', avatarUrl: 'https://avatars/octo' },
      { id: 'hubot', login: 'hubot' },
    ] });
    const calls = fetch.mock.calls.length;
    await request(app).get('/api/source-control/github/references/labels')
      .query({ ...readContext(project), owner: 'someone', repo: 'else' }).expect(400);
    expect(fetch.mock.calls.slice(calls).some(([url]) => String(url).includes('/labels'))).toBe(false);
  });

  it('pages the board picker lists past the first 100', async () => {
    const labelPages = [100, 100, 50].map((count, page) =>
      Array.from({ length: count }, (_, index) => ({ name: `label-${page + 1}-${index}`, color: 'd73a4a' })));
    const reviewerPages = [100, 30].map((count, page) =>
      Array.from({ length: count }, (_, index) => ({ login: `user-${page + 1}-${index}` })));
    const fetch = vi.fn(async (url) => {
      const endpoint = new URL(url);
      if (endpoint.pathname === '/repos/example/project') return response({ full_name: 'example/project', fork: false });
      const page = Number(endpoint.searchParams.get('page'));
      if (endpoint.pathname === '/repos/example/project/labels') return response(labelPages[page - 1] ?? []);
      if (endpoint.pathname === '/repos/example/project/assignees') return response(reviewerPages[page - 1] ?? []);
      throw new Error(`Unexpected GitHub request: ${endpoint.pathname}`);
    });
    vi.stubGlobal('fetch', fetch);

    const labels = await request(app).get('/api/source-control/github/references/labels')
      .query({ ...readContext(project), owner: 'example', repo: 'project' }).expect(200);
    const reviewers = await request(app).get('/api/source-control/github/references/reviewers')
      .query({ ...readContext(project), owner: 'example', repo: 'project' }).expect(200);

    expect(labels.body.items).toHaveLength(250);
    expect(labels.body.items[249]).toEqual({ name: 'label-3-49', color: 'd73a4a' });
    expect(reviewers.body.items).toHaveLength(130);
    expect(reviewers.body.items[129]).toEqual({ id: 'user-2-29', login: 'user-2-29' });
    const pickerCalls = (suffix) => fetch.mock.calls.filter(([called]) => new URL(called).pathname.endsWith(suffix)).length;
    expect(pickerCalls('/labels')).toBe(3);
    expect(pickerCalls('/assignees')).toBe(2);
  });

  it('returns the complete board picker list at exactly the pagination cap', async () => {
    const fetch = vi.fn(async (url) => {
      const endpoint = new URL(url);
      if (endpoint.pathname === '/repos/example/project') return response({ full_name: 'example/project', fork: false });
      if (endpoint.pathname !== '/repos/example/project/labels') throw new Error(`Unexpected GitHub request: ${endpoint.pathname}`);
      if (Number(endpoint.searchParams.get('page')) > 20) return response([]);
      return response(Array.from({ length: 100 }, (_, index) => ({ name: `label-${index}` })));
    });
    vi.stubGlobal('fetch', fetch);

    const labels = await request(app).get('/api/source-control/github/references/labels')
      .query({ ...readContext(project), owner: 'example', repo: 'project' }).expect(200);

    expect(labels.body.items).toHaveLength(2000);
    expect(fetch.mock.calls.filter(([called]) => new URL(called).pathname.endsWith('/labels'))).toHaveLength(21);
  });

  it('fails explicitly when a board picker list passes the pagination cap', async () => {
    const fetch = vi.fn(async (url) => {
      const endpoint = new URL(url);
      if (endpoint.pathname === '/repos/example/project') return response({ full_name: 'example/project', fork: false });
      if (endpoint.pathname === '/repos/example/project/labels') {
        return response(Array.from({ length: 100 }, (_, index) => ({ name: `label-${index}` })));
      }
      if (endpoint.pathname === '/repos/example/project/assignees') {
        return response(Array.from({ length: 100 }, (_, index) => ({ login: `user-${index}` })));
      }
      throw new Error(`Unexpected GitHub request: ${endpoint.pathname}`);
    });
    vi.stubGlobal('fetch', fetch);

    const labels = await request(app).get('/api/source-control/github/references/labels')
      .query({ ...readContext(project), owner: 'example', repo: 'project' }).expect(500);
    const reviewers = await request(app).get('/api/source-control/github/references/reviewers')
      .query({ ...readContext(project), owner: 'example', repo: 'project' }).expect(500);

    expect(labels.body.error).toBe('GitHub label list reached the 2000-label safety limit and may be incomplete');
    expect(reviewers.body.error).toBe('GitHub reviewer list reached the 2000-reviewer safety limit and may be incomplete');
    const pickerCalls = (suffix) => fetch.mock.calls.filter(([called]) => new URL(called).pathname.endsWith(suffix)).length;
    expect(pickerCalls('/labels')).toBe(21);
    expect(pickerCalls('/assignees')).toBe(21);
  });

  it('reads the statuses of listed PRs with the sidebar summaries, only from the project repo network', async () => {
    const fetch = serveGitHub((body) => {
      expect(body.variables).toMatchObject({ o0: 'example', n0: 'project', p0: 4, o1: 'example', n1: 'project', p1: 9 });
      return response({ data: {
        a0: { pullRequest: {
          number: 4,
          title: 'PR 4',
          state: 'OPEN',
          isDraft: false,
          mergeable: 'CONFLICTING',
          mergeStateStatus: 'DIRTY',
          headRefOid: 'sha-4',
          commits: { nodes: [{ commit: { statusCheckRollup: { contexts: { totalCount: 1, nodes: [
            { __typename: 'CheckRun', databaseId: 1, name: 'test', status: 'COMPLETED', conclusion: 'FAILURE', startedAt: null, checkSuite: { app: { databaseId: 1 } } },
          ] } } } }] },
        } },
        // GitHub could not resolve #9: left out, never reported as clean.
        a1: { pullRequest: null },
      } });
    });

    const res = await request(app).get('/api/source-control/github/references/status')
      .query({ ...readContext(project), pulls: 'example/project#4,example/project#9' })
      .expect(200);
    expect(res.body).toEqual({
      connected: true,
      statuses: [{
        owner: 'example',
        repo: 'project',
        number: 4,
        checks: expect.objectContaining({ state: 'failure', failure: 1, total: 1 }),
        mergeable: false,
        mergeableState: 'dirty',
      }],
    });

    const graphqlCalls = () => fetch.mock.calls.filter(([url]) => String(url).endsWith('/graphql')).length;
    const before = graphqlCalls();
    await request(app).get('/api/source-control/github/references/status')
      .query({ ...readContext(project), pulls: 'example/project#4,someone/else#4' })
      .expect(400);
    await request(app).get('/api/source-control/github/references/status')
      .query({ ...readContext(project), pulls: 'example/project#x' })
      .expect(400);
    expect(graphqlCalls()).toBe(before);
  });

  it('fails instead of answering an empty page', async () => {
    serveGitHub(() => response({ message: 'Server Error' }, 502));
    vi.spyOn(console, 'error').mockImplementation(() => {});

    const res = await request(app).get('/api/source-control/github/references')
      .query({ ...readContext(project), kind: 'issue' })
      .expect(500);

    expect(res.body).not.toHaveProperty('items');
  });
});


describe('pull request head for a worktree made by number', () => {
  let github;
  const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'openchamber-github-pr-head-'));
  const project = path.join(dataDir, 'project');
  const headSha = 'ABCDEF0123456789abcdef0123456789abcdef01';
  const forkPull = (overrides = {}) => ({
    ...pull(42),
    user: { login: 'alice', id: 9 },
    head: {
      ref: 'feature/fix',
      sha: headSha,
      repo: {
        name: 'project',
        owner: { login: 'alice' },
        html_url: 'https://github.com/alice/project',
        clone_url: 'https://github.com/alice/project.git',
      },
    },
    ...overrides,
  });

  beforeAll(async () => {
    process.env.OPENCHAMBER_DATA_DIR = dataDir;
    fs.mkdirSync(project);
    execFileSync('git', ['init', '-q', project]);
    execFileSync('git', ['-C', project, 'remote', 'add', 'origin', 'https://github.com/example/project.git']);
    const { setGitHubAuth, setGhCliDisabled } = await import('./auth.js');
    setGhCliDisabled(true);
    ({ accountId } = await setGitHubAuth({ accessToken: 'fake-test-token', user: { id: 7, login: 'tester' } }));
    github = registerGitHubRoutes(express(), routeOptions());
  });

  afterEach(() => {
    vi.unstubAllGlobals();
    vi.restoreAllMocks();
  });

  afterAll(() => {
    if (previousDataDir === undefined) delete process.env.OPENCHAMBER_DATA_DIR;
    else process.env.OPENCHAMBER_DATA_DIR = previousDataDir;
    fs.rmSync(dataDir, { recursive: true, force: true });
  });

  const serveGitHub = (pullResponse) => {
    const fetch = vi.fn(async (url) => {
      const endpoint = new URL(url);
      if (endpoint.pathname === '/repos/example/project') return response({ full_name: 'example/project', fork: false });
      if (endpoint.pathname === '/repos/example/project/pulls/42') return pullResponse();
      throw new Error(`Unexpected GitHub request: ${endpoint.pathname}`);
    });
    vi.stubGlobal('fetch', fetch);
    return fetch;
  };

  it('answers the current account when no gh login is in use', async () => {
    await expect(github.readCurrentAccountId()).resolves.toBe(accountId);
  });

  // A stand-in `gh` on PATH answers `gh auth token`, as the real CLI does.
  it.skipIf(process.platform === 'win32')('treats only a rejected gh token as no account', async () => {
    const binDirectory = path.join(dataDir, 'bin');
    fs.mkdirSync(binDirectory, { recursive: true });
    fs.writeFileSync(path.join(binDirectory, 'gh'), '#!/bin/sh\necho fake-gh-token\n', { mode: 0o755 });
    const previousPath = process.env.PATH;
    process.env.PATH = `${binDirectory}${path.delimiter}${previousPath}`;
    const { setGhCliActive, setGhCliDisabled } = await import('./auth.js');
    setGhCliDisabled(false);
    setGhCliActive(true);
    try {
      vi.stubGlobal('fetch', vi.fn(async () => response({ message: 'Server Error' }, 500)));
      await expect(github.readCurrentAccountId()).rejects.toMatchObject({ status: 500 });
      vi.stubGlobal('fetch', vi.fn(async () => response({ message: 'Bad credentials' }, 401)));
      await expect(github.readCurrentAccountId()).resolves.toBeNull();
    } finally {
      setGhCliActive(false);
      setGhCliDisabled(true);
      process.env.PATH = previousPath;
    }
  });

  it('reads the project, head and head owner from the primary remote', async () => {
    serveGitHub(() => response(forkPull()));
    await expect(github.readChangeRequestHead({ context: readContext(project), number: 42 })).resolves.toEqual({
      project: { id: 'example/project', owner: 'example', name: 'project' },
      headSha: headSha.toLowerCase(),
      headBranch: 'feature/fix',
      headOwner: 'alice',
    });
  });

  it('refuses a pull request whose fork was deleted', async () => {
    serveGitHub(() => response(forkPull({ head: { ref: 'feature/fix', sha: headSha, repo: null } })));
    await expect(github.readChangeRequestHead({ context: readContext(project), number: 42 }))
      .rejects.toMatchObject({ status: 409, message: 'Pull request #42 has no branch to check out: its fork was deleted' });
  });

  it('refuses a number that is not a pull request there', async () => {
    serveGitHub(() => response({ message: 'Not Found' }, 404));
    await expect(github.readChangeRequestHead({ context: readContext(project), number: 42 }))
      .rejects.toMatchObject({ status: 404, message: 'Pull request #42 was not found in example/project' });
  });
});

describe('GET /api/source-control/github/references bindingRevision parsing', () => {
  it('hands the binding authority a strict non-negative integer or null', async () => {
    const seen = [];
    const app = express();
    registerGitHubRoutes(app, {
      validateReadContext: vi.fn(async (context) => {
        seen.push(context.bindingRevision);
        throw Object.assign(new Error('Stale binding'), { code: 'SOURCE_CONTROL_BINDING_STALE', status: 409 });
      }),
    });
    const read = (bindingRevision) => request(app).get('/api/source-control/github/references')
      .query({ directory: '/repo', kind: 'issue', repositoryId: 'repo-1', bindingRevision })
      .expect(409);

    // Each of these reinterprets to a plain revision under Number(...), so a
    // loose parse would pass the authority check when that revision is current.
    for (const spelling of ['1e3', '0x10', '2.0', ' 2 ', '+2', '', '01', '-1', '9007199254740993']) {
      await read(spelling);
    }
    expect(seen).toEqual([null, null, null, null, null, null, null, null, null]);

    seen.length = 0;
    for (const spelling of ['0', '2', '1000']) {
      await read(spelling);
    }
    expect(seen).toEqual([0, 2, 1000]);
  });
});
