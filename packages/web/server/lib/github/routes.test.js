import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from 'vitest';
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import express from 'express';
import request from 'supertest';
import { registerGitHubRoutes } from './routes.js';

// The summaries host-routing test below puts a real (fake) `gh` binary on PATH
// so a trusted enterprise host can take a host-pinned token and gh's calls can
// be asserted; the file otherwise runs with gh CLI disabled.

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

describe('GET /api/github/pulls/list free-text search', () => {
  let app;

  beforeAll(async () => {
    process.env.OPENCHAMBER_DATA_DIR = testDir;
    fs.mkdirSync(repository);
    execFileSync('git', ['init', '-q', repository]);
    execFileSync('git', ['-C', repository, 'remote', 'add', 'origin', 'https://github.com/example/project.git']);
    const { setGitHubAuth, setGhCliDisabled } = await import('./auth.js');
    setGhCliDisabled(true);
    setGitHubAuth({ accessToken: 'fake-test-token', accountId: 'test' });
    app = express();
    registerGitHubRoutes(app);
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

  const search = () => request(app).get('/api/github/pulls/list').query({ directory: repository, query: 'fix' });

  const serveGitHub = ({ numbers = [1, 2], failPulls = [], failSearch = false, networkFailure = false } = {}) => {
    const fetch = vi.fn(async (url) => {
      const endpoint = new URL(url);
      if (endpoint.pathname === '/repos/example/project') return response({ full_name: 'example/project' });
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

describe('GET /api/github/references', () => {
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
    setGitHubAuth({ accessToken: 'fake-test-token', accountId: 'test' });
    app = express();
    registerGitHubRoutes(app);
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
      if (endpoint.pathname === '/repos/example/project') return response({ full_name: 'example/project' });
      if (endpoint.pathname === '/graphql') return graphql(JSON.parse(init.body));
      throw new Error(`Unexpected GitHub request: ${endpoint.pathname}`);
    });
    vi.stubGlobal('fetch', fetch);
    return fetch;
  };

  it('requires a directory and a kind', async () => {
    await request(app).get('/api/github/references').query({ directory: project }).expect(400);
  });

  it('answers a page with one search document', async () => {
    const fetch = serveGitHub((body) => {
      expect(body.variables.q).toBe('repo:example/project is:issue is:open sort:updated-desc author:@me crash');
      return response({ data: { search: { issueCount: 31, pageInfo: { hasNextPage: true, endCursor: 'c1' }, nodes: [issueNode(4), issueNode(2)] } } });
    });

    const res = await request(app).get('/api/github/references')
      .query({ directory: project, kind: 'issue', filter: 'created', query: 'crash' })
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

    const res = await request(app).get('/api/github/references')
      .query({ directory: project, kind: 'pull', query: '#4' })
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
      additions: 1,
      deletions: 2,
      changedFiles: 1,
      comments: { totalCount: 0, nodes: [] },
      reviews: { nodes: [] },
      commits: { nodes: [] },
    } } } }));

    const detail = await request(app).get('/api/github/references/detail')
      .query({ directory: project, owner: 'example', repo: 'project', number: '4' })
      .expect(200);
    expect(detail.body).toEqual({
      connected: true,
      detail: expect.objectContaining({ number: 4, comments: [], pull: expect.objectContaining({ reviewDecision: 'approved', additions: 1 }) }),
    });

    const graphqlCalls = () => fetch.mock.calls.filter(([url]) => String(url).endsWith('/graphql')).length;
    const before = graphqlCalls();
    await request(app).get('/api/github/references/detail')
      .query({ directory: project, owner: 'someone', repo: 'else', number: '4' })
      .expect(400);
    expect(graphqlCalls()).toBe(before);
  });

  it('fails instead of answering an empty page', async () => {
    serveGitHub(() => response({ message: 'Server Error' }, 502));
    vi.spyOn(console, 'error').mockImplementation(() => {});

    const res = await request(app).get('/api/github/references')
      .query({ directory: project, kind: 'issue' })
      .expect(500);

    expect(res.body).not.toHaveProperty('items');
  });
});

describe('POST /api/github/pr/summaries', () => {
  let app;
  const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'openchamber-github-summaries-'));

  beforeAll(async () => {
    process.env.OPENCHAMBER_DATA_DIR = dataDir;
    const { setGitHubAuth, setGhCliDisabled } = await import('./auth.js');
    setGhCliDisabled(true);
    setGitHubAuth({ accessToken: 'fake-test-token', accountId: 'test' });
    app = express();
    app.use(express.json());
    registerGitHubRoutes(app);
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

  const summaries = (refs) => request(app).post('/api/github/pr/summaries').send({ refs });

  const serveGraphql = (body) => {
    const fetch = vi.fn(async () => response(body));
    vi.stubGlobal('fetch', fetch);
    return fetch;
  };

  it('rejects malformed refs before asking GitHub', async () => {
    const fetch = serveGraphql({ data: {} });

    const res = await summaries([{ owner: 'example', repo: 'project', number: 'seven' }]);

    expect(res.status).toBe(400);
    expect(fetch).not.toHaveBeenCalled();
  });

  it('answers with the live state of each resolved PR', async () => {
    serveGraphql({
      data: {
        a0: { pullRequest: { number: 7, title: 'Fix', state: 'MERGED', isDraft: false, mergeable: 'UNKNOWN', mergeStateStatus: 'UNKNOWN', headRefOid: 'abc', commits: { nodes: [] } } },
        a1: null,
        a2: { issue: { number: 3, title: 'Bug', state: 'CLOSED', stateReason: 'COMPLETED' } },
      },
      errors: [{ type: 'NOT_FOUND', path: ['a1'], message: 'Could not resolve to a Repository' }],
    });

    const res = await request(app).post('/api/github/pr/summaries').send({
      refs: [{ owner: 'example', repo: 'project', number: 7 }, { owner: 'example', repo: 'gone', number: 8 }],
      issueRefs: [{ owner: 'example', repo: 'project', number: 3 }],
    });

    expect(res.status).toBe(200);
    expect(res.body.connected).toBe(true);
    expect(res.body.summaries).toEqual([
      expect.objectContaining({ owner: 'example', repo: 'project', number: 7, state: 'merged', checks: null }),
    ]);
    expect(res.body.issueSummaries).toEqual([
      { owner: 'example', repo: 'project', number: 3, title: 'Bug', state: 'completed' },
    ]);
  });

  it('routes summaries per ref host, skipping hosts with no trustworthy credentials', async () => {
    // A trusted enterprise host via a temp gh config (hosts.yml stored login);
    // an enterprise token in the environment that must NOT reach the untrusted
    // gitlab.com host. gh CLI is re-enabled for this request so the enterprise
    // group can take the (mocked) host-pinned gh token; the stored OAuth token
    // still covers github.com.
    const { setGhCliDisabled } = await import('./auth.js');
    const ghConfigDir = fs.mkdtempSync(path.join(os.tmpdir(), 'oc-gh-hosts-'));
    fs.writeFileSync(path.join(ghConfigDir, 'hosts.yml'), [
      'github.acme.com:',
      '  users:',
      '    admin:',
      '      oauth_token: gho_acme',
    ].join('\n'));
    const previousConfigDir = process.env.GH_CONFIG_DIR;
    const previousToken = process.env.GH_ENTERPRISE_TOKEN;
    process.env.GH_CONFIG_DIR = ghConfigDir;
    process.env.GH_ENTERPRISE_TOKEN = 'env-enterprise-token';
    setGhCliDisabled(false);

    // A real (fake) `gh` binary on PATH, so a trusted enterprise host can take
    // a host-pinned token and we can assert which hosts gh was asked about —
    // without module mocking. Each call appends its pinned GH_HOST to a file.
    const ghBin = fs.mkdtempSync(path.join(os.tmpdir(), 'oc-gh-bin-'));
    const ghInvoked = path.join(ghBin, 'invoked-hosts.txt');
    fs.writeFileSync(path.join(ghBin, 'gh'), [
      '#!/bin/sh',
      `printf '%s\\n' "$GH_HOST" >> '${ghInvoked}'`,
      'printf \'gh-token-%s\\n\' "$GH_HOST"',
      '',
    ].join('\n'));
    fs.chmodSync(path.join(ghBin, 'gh'), 0o755);
    const previousPath = process.env.PATH;
    process.env.PATH = `${ghBin}${path.delimiter}${previousPath}`;

    try {
      const fetch = vi.fn(async (url) => {
        const endpoint = new URL(String(url));
        if (endpoint.hostname === 'api.github.com') {
          return response({
            data: { a0: { pullRequest: { number: 7, title: 'Fix', state: 'OPEN', isDraft: false, mergeable: 'MERGEABLE', mergeStateStatus: 'CLEAN', headRefOid: 'a', commits: { nodes: [] } } } },
          });
        }
        if (endpoint.hostname === 'github.acme.com') {
          return response({
            data: { a0: { pullRequest: { number: 9, title: 'Enterprise', state: 'OPEN', isDraft: false, mergeable: 'MERGEABLE', mergeStateStatus: 'CLEAN', headRefOid: 'b', commits: { nodes: [] } } } },
          });
        }
        throw new Error(`Unexpected host ${endpoint.hostname}`);
      });
      vi.stubGlobal('fetch', fetch);

      const res = await summaries([
        { owner: 'example', repo: 'project', number: 7 },
        { owner: 'acme', repo: 'enterprise', number: 9, host: 'github.acme.com' },
        { owner: 'example', repo: 'project', number: 5, host: 'gitlab.com' },
      ]);

      expect(res.status).toBe(200);
      expect(res.body.connected).toBe(true);
      // Both trusted groups answered; the untrusted gitlab.com group is absent.
      expect(res.body.summaries.map((s) => s.number)).toEqual([7, 9]);
      // Each trusted group used its own host, and no request ever went to the
      // untrusted host (nor was gh asked for its token).
      const hosts = fetch.mock.calls.map(([url]) => new URL(String(url)).hostname);
      expect(hosts).toEqual(expect.arrayContaining(['api.github.com', 'github.acme.com']));
      expect(hosts).not.toContain('gitlab.com');
      const invoked = fs.existsSync(ghInvoked)
        ? fs.readFileSync(ghInvoked, 'utf8').split('\n').filter(Boolean)
        : [];
      expect(invoked).toContain('github.acme.com');
      expect(invoked).not.toContain('gitlab.com');
    } finally {
      process.env.PATH = previousPath;
      fs.rmSync(ghBin, { recursive: true, force: true });
      setGhCliDisabled(true);
      if (previousToken === undefined) delete process.env.GH_ENTERPRISE_TOKEN;
      else process.env.GH_ENTERPRISE_TOKEN = previousToken;
      if (previousConfigDir === undefined) delete process.env.GH_CONFIG_DIR;
      else process.env.GH_CONFIG_DIR = previousConfigDir;
      fs.rmSync(ghConfigDir, { recursive: true, force: true });
    }
  });

  it('does not clear the stored github.com login on an enterprise 401', async () => {
    const { setGhCliDisabled } = await import('./auth.js');
    const ghConfigDir = fs.mkdtempSync(path.join(os.tmpdir(), 'oc-gh-hosts-'));
    fs.writeFileSync(path.join(ghConfigDir, 'hosts.yml'), 'github.acme.com:\n  users:\n    admin:\n      oauth_token: gho_acme\n');
    // A real (fake) `gh` binary so the trusted enterprise host can take a
    // host-pinned token without a module mock (same pattern as the host-routing
    // test above).
    const ghBin = fs.mkdtempSync(path.join(os.tmpdir(), 'oc-gh-bin-'));
    const ghInvoked = path.join(ghBin, 'invoked-hosts.txt');
    fs.writeFileSync(path.join(ghBin, 'gh'), [
      '#!/bin/sh',
      `printf '%s\\n' "$GH_HOST" >> '${ghInvoked}'`,
      'printf \'gh-token-%s\\n\' "$GH_HOST"',
      '',
    ].join('\n'));
    fs.chmodSync(path.join(ghBin, 'gh'), 0o755);
    const previousPath = process.env.PATH;
    const previousConfigDir = process.env.GH_CONFIG_DIR;
    process.env.GH_CONFIG_DIR = ghConfigDir;
    process.env.PATH = `${ghBin}${path.delimiter}${previousPath}`;
    setGhCliDisabled(false);

    try {
      vi.stubGlobal('fetch', vi.fn(async () => Response.json({ message: 'Bad credentials' }, { status: 401 })));
      const res = await summaries([{ owner: 'acme', repo: 'enterprise', number: 9, host: 'github.acme.com' }]);

      expect(res.status).toBe(200);
      expect(res.body.connected).toBe(false);
      // A GHE 401 is that host's stale gh token, not the github.com account:
      // the stored login must survive. auth.js pins its storage path at first
      // import, which this file does under the first describe's testDir.
      const authFile = path.join(testDir, 'github-auth.json');
      expect(fs.existsSync(authFile)).toBe(true);
      expect(fs.readFileSync(authFile, 'utf8')).toContain('fake-test-token');
    } finally {
      setGhCliDisabled(true);
      if (previousConfigDir === undefined) delete process.env.GH_CONFIG_DIR;
      else process.env.GH_CONFIG_DIR = previousConfigDir;
      process.env.PATH = previousPath;
      fs.rmSync(ghConfigDir, { recursive: true, force: true });
      fs.rmSync(ghBin, { recursive: true, force: true });
    }
  });

  it('clears the stored github.com login on a github.com 401 and reseeds', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => Response.json({ message: 'Bad credentials' }, { status: 401 })));
    const res = await summaries([{ owner: 'example', repo: 'project', number: 7 }]);

    expect(res.status).toBe(200);
    expect(res.body.connected).toBe(false);
    // A github.com 401 is the stored login turning bad; only github.com clears
    // it (guarded by hostFromError), matching the pre-existing behavior. The
    // auth file lives under testDir (auth.js pins its path at first import).
    expect(fs.existsSync(path.join(testDir, 'github-auth.json'))).toBe(false);
    // Re-seed so later tests still have a stored login.
    const { setGitHubAuth } = await import('./auth.js');
    setGitHubAuth({ accessToken: 'fake-test-token', accountId: 'test' });
  });

  // Last in the file: the rate-limit cooldown it records is process-global.
  it('reports a GraphQL rate limit as a transient failure', async () => {
    serveGraphql({ data: null, errors: [{ type: 'RATE_LIMITED', message: 'API rate limit exceeded' }] });

    const res = await summaries([{ owner: 'example', repo: 'project', number: 7 }]);

    expect(res.status).toBe(503);
  });
});
