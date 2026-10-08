import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from 'vitest';
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
    labels: { nodes: [] },
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
      reviewRequests: { nodes: [] },
      additions: 1,
      deletions: 2,
      changedFiles: 1,
      comments: { totalCount: 0, nodes: [] },
      reviews: { nodes: [] },
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
          commits: { nodes: [{ commit: { statusCheckRollup: { contexts: { nodes: [
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

