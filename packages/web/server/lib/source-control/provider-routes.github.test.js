import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import express from 'express';
import request from 'supertest';
import { registerGitHubRoutes } from './provider-routes.github.test-support.js';

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
    const { setGitHubAuth, setGhCliDisabled } = await import('../github/auth.js');
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
        createdAt: null, updatedAt: '2026-10-01', body: '', author: null, labels: { nodes: [] }, comments: { totalCount: 0 },
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
    // Folders resolve concurrently, so only which ones were resolved is the contract.
    expect(resolve.mock.calls.map(([directory]) => directory).sort()).toEqual(['/a', '/none']);
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
    const { getGitHubAuthAccounts } = await import('../github/auth.js');
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
    const { setGitHubAuth, setGhCliDisabled } = await import('../github/auth.js');
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
    expect(result.body.items.map((pr) => ({ number: pr.number, base: pr.base, head: pr.head }))).toEqual([
      { number: 1, base: 'main', head: 'branch-1' },
      { number: 2, base: 'main', head: 'branch-2' },
    ]);
    expect(result.body.hasMore).toBe(false);
  });

  // A failed bound read answers GitHub's own status.
  it('rejects the page rather than dropping one failed enrichment', async () => {
    const fetch = serveGitHub({ failPulls: [2] });
    vi.spyOn(console, 'error').mockImplementation(() => {});
    const result = await search().expect(503);
    expect(result.body).toEqual({ error: 'GitHub enrichment unavailable' });
    expect(result.body).not.toHaveProperty('items');
    expect(fetch.mock.calls.some(([url]) => String(url).endsWith('/pulls/1'))).toBe(true);
  });

  it('rejects when every enrichment fails instead of returning an empty success', async () => {
    serveGitHub({ failPulls: [1, 2] });
    vi.spyOn(console, 'error').mockImplementation(() => {});
    const result = await search().expect(503);
    expect(result.body).toEqual({ error: 'GitHub enrichment unavailable' });
  });

  it('propagates a failed network request without returning a partial page', async () => {
    serveGitHub({ failPulls: [2], networkFailure: true });
    vi.spyOn(console, 'error').mockImplementation(() => {});
    expect((await search().expect(500)).body).toEqual({ error: 'Network unavailable' });
  });

  it('still returns a genuinely empty search and propagates search-level errors', async () => {
    serveGitHub({ numbers: [] });
    expect((await search().expect(200)).body.items).toEqual([]);
    serveGitHub({ failSearch: true });
    vi.spyOn(console, 'error').mockImplementation(() => {});
    expect((await search().expect(503)).body.error).toBe('GitHub search unavailable');
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
    const { setGitHubAuth, setGhCliDisabled } = await import('../github/auth.js');
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

  it('lists discussions with their own search and reads one with its comment threads', async () => {
    const discussionNode = { ...issueNode(9), __typename: 'Discussion', url: 'https://github.com/example/project/discussions/9',
      closed: false, isAnswered: false, locked: false, upvoteCount: 2, category: { name: 'Q&A', emojiHTML: '<div>🙏</div>', isAnswerable: true } };
    delete discussionNode.state;
    serveGitHub((body) => {
      if (body.query.includes('DiscussionDetail')) {
        return response({ data: { repository: { discussion: {
          number: 9, locked: false, viewerCanUpdate: true, viewerCanClose: true, viewerCanReopen: false, category: { isAnswerable: true },
          comments: { totalCount: 0, nodes: [] },
        } } } });
      }
      expect(body.query).toContain('type: DISCUSSION');
      // The board's unanswered list: open questions without an answer.
      expect(body.variables.q).toBe('repo:example/project is:open is:unanswered sort:updated-desc');
      return response({ data: { search: { discussionCount: 1, pageInfo: { hasNextPage: false, endCursor: null }, nodes: [discussionNode] } } });
    });

    const list = await request(app).get('/api/source-control/github/references')
      .query({ ...readContext(project), kind: 'discussion', state: 'unanswered' })
      .expect(200);
    expect(list.body.items).toEqual([expect.objectContaining({ kind: 'discussion', number: 9, state: 'open', answered: false })]);

    const detail = await request(app).get('/api/source-control/github/references/detail')
      .query({ ...readContext(project), owner: 'example', repo: 'project', number: '9', kind: 'discussion' })
      .expect(200);
    expect(detail.body).toEqual({ connected: true, detail: {
      number: 9, comments: [], commentTotal: 0, pull: null, discussion: { canComment: true, canClose: true, canReopen: false },
    } });
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
      reviewThreads: { nodes: [] },
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
          baseRefName: 'main',
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
      .query({ ...readContext(project), pulls: 'example/project#x' })
      .expect(400);
    expect(graphqlCalls()).toBe(before);

    // A ref's host rides on the wire as `owner/repo#number@host`; the default
    // github.com host reads exactly like a host-less ref.
    const hosted = await request(app).get('/api/source-control/github/references/status')
      .query({ ...readContext(project), pulls: 'example/project#4@github.com,example/project#9@github.com' })
      .expect(200);
    expect(hosted.body.statuses).toEqual(res.body.statuses);

    // A mixed-host request groups by host: the untrusted host's group drops (no
    // credential exists for it) while the github.com group still answers in
    // full — one failed group never erases another.
    const ghe = serveGitHub(() => response({ data: {
      a0: { pullRequest: {
        number: 4,
        title: 'PR 4',
        state: 'OPEN',
        isDraft: false,
        mergeable: 'CONFLICTING',
        mergeStateStatus: 'DIRTY',
        headRefOid: 'sha-4',
        baseRefName: 'main',
        commits: { nodes: [{ commit: { statusCheckRollup: { contexts: { nodes: [
          { __typename: 'CheckRun', databaseId: 1, name: 'test', status: 'COMPLETED', conclusion: 'FAILURE', startedAt: null, checkSuite: { app: { databaseId: 1 } } },
        ] } } } }] },
      } },
    } }));
    const mixed = await request(app).get('/api/source-control/github/references/status')
      .query({ ...readContext(project), pulls: 'example/project#4@github.com,example/project#9@untrusted.example.invalid' })
      .expect(200);
    expect(mixed.body.statuses).toEqual([{
      owner: 'example',
      repo: 'project',
      number: 4,
      checks: expect.objectContaining({ state: 'failure', failure: 1, total: 1 }),
      mergeable: false,
      mergeableState: 'dirty',
    }]);
  });

  it('answers connected: false when the github.com group itself is rejected', async () => {
    serveGitHub(() => response({ message: 'Bad credentials' }, 401));
    vi.spyOn(console, 'error').mockImplementation(() => {});

    const res = await request(app).get('/api/source-control/github/references/status')
      .query({ ...readContext(project), pulls: 'example/project#4@github.com' })
      .expect(200);

    // A github.com 401 is this route's OAuth path: it reaches the outer handler,
    // which invalidates the github.com account and answers connected: false —
    // never an authoritative-looking empty page.
    expect(res.body).toEqual({ connected: false });
    expect(res.body.statuses).toBeUndefined();
  });

  it('gates each host group by its own cooldown, and a cooled enterprise host skips only its own refs', async () => {
    // The github.com group still answers in full; the enterprise host is on
    // cooldown, so its group is skipped without a GitHub call.
    const { noteGitHubRateLimit } = await import('../github/rate-limit.js');
    vi.spyOn(console, 'warn').mockImplementation(() => {});
    serveGitHub(() => response({ data: {
      a0: { pullRequest: {
        number: 4,
        title: 'PR 4',
        state: 'OPEN',
        isDraft: false,
        mergeable: 'CONFLICTING',
        mergeStateStatus: 'DIRTY',
        headRefOid: 'sha-4',
        baseRefName: 'main',
        commits: { nodes: [{ commit: { statusCheckRollup: { contexts: { nodes: [
          { __typename: 'CheckRun', databaseId: 1, name: 'test', status: 'COMPLETED', conclusion: 'FAILURE', startedAt: null, checkSuite: { app: { databaseId: 1 } } },
        ] } } } }] },
      } },
    } }));
    // Note a real cooldown for the enterprise host: its group must be skipped
    // without a GitHub call, while the github.com group still answers.
    // SAFETY: noteGitHubRateLimit(keyed by host) is the same real module the
    // route reads, so the cooldown applies to exactly that one host.
    noteGitHubRateLimit({ status: 429, response: { headers: { 'retry-after': '1' } } }, 'cooled.example.com');
    const mixed = await request(app).get('/api/source-control/github/references/status')
      .query({ ...readContext(project), pulls: 'example/project#4@github.com,example/project#4@cooled.example.com' })
      .expect(200);
    expect(mixed.body).toMatchObject({ connected: true, statuses: [{ owner: 'example', repo: 'project', number: 4 }] });
    expect(mixed.body.statuses[0].mergeable).toBe(false);
  });

  it('fails instead of answering an empty page', async () => {
    serveGitHub(() => response({ message: 'Server Error' }, 502));
    vi.spyOn(console, 'error').mockImplementation(() => {});

    const res = await request(app).get('/api/source-control/github/references')
      .query({ ...readContext(project), kind: 'issue' })
      .expect(502);

    expect(res.body).not.toHaveProperty('items');
  });
});

describe('GitHub Enterprise references on a trusted enterprise checkout', () => {
  let app;
  const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'openchamber-github-refs-ghe-'));
  const project = path.join(dataDir, 'project');
  const ghConfigDir = path.join(dataDir, 'gh-config');
  const binDirectory = path.join(dataDir, 'bin');
  const previousConfigDir = process.env.GH_CONFIG_DIR;
  const previousPath = process.env.PATH;

  beforeAll(async () => {
    process.env.OPENCHAMBER_DATA_DIR = dataDir;
    process.env.GH_CONFIG_DIR = ghConfigDir;
    fs.mkdirSync(project);
    fs.mkdirSync(binDirectory, { recursive: true });
    fs.mkdirSync(ghConfigDir, { recursive: true });
    fs.writeFileSync(path.join(binDirectory, 'gh'), '#!/bin/sh\necho gho_ghe\n', { mode: 0o755 });
    execFileSync('git', ['init', '-q', project]);
    execFileSync('git', ['-C', project, 'remote', 'add', 'origin', 'https://github.example.com/example/project.git']);
    fs.writeFileSync(path.join(ghConfigDir, 'hosts.yml'), 'github.example.com:\n  user: ghe-user\n  oauth_token: gho_ghe\n');
    const { setGitHubAuth, setGhCliDisabled, setGhCliActive } = await import('../github/auth.js');
    ({ accountId } = await setGitHubAuth({ accessToken: 'fake-test-token', user: { id: 7, login: 'tester' } }));
    setGhCliDisabled(false);
    setGhCliActive(true);
    const { setGhCliActiveForHost } = await import('../github/auth.js');
    setGhCliActiveForHost('github.example.com', true);
    process.env.PATH = `${binDirectory}${path.delimiter}${previousPath}`;
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
    if (previousConfigDir === undefined) delete process.env.GH_CONFIG_DIR;
    else process.env.GH_CONFIG_DIR = previousConfigDir;
    process.env.PATH = previousPath;
    fs.rmSync(dataDir, { recursive: true, force: true });
  });

  // The checkout lives on github.example.com, so its network is the checkout host's
  // too: a pull ref on that host is bound to that network like a github.com pull
  // is on a github.com checkout.
  it('rejects a GitHub Enterprise ref outside the bound repo network on the checkout host', async () => {
    const fetch = vi.fn(async (url) => {
      const endpoint = new URL(url);
      if (endpoint.pathname === '/api/v3/repos/example/project') return response({ full_name: 'example/project', fork: false });
      throw new Error(`Unexpected GitHub request: ${endpoint.pathname}`);
    });
    vi.stubGlobal('fetch', fetch);

    const res = await request(app).get('/api/source-control/github/references/status')
      .query({ ...readContext(project), pulls: 'someone/else#5@github.example.com' })
      .expect(400);
    expect(res.body).toEqual({ error: 'Repository is not part of this project' });

    // The rejected ref's group never reaches the summaries.
    expect(fetch.mock.calls.some(([url]) => String(url).includes('/graphql'))).toBe(false);
  });

  it("resolves a detail request naming an enterprise host with that host's Octokit, even when the same repo also exists on github.com", async () => {
    const fetch = vi.fn(async (url) => {
      const endpoint = new URL(url);
      if (endpoint.pathname === '/api/v3/repos/example/project') return response({ full_name: 'example/project', fork: false });
      if (endpoint.pathname === '/api/graphql') {
        return response({ data: { repository: { issueOrPullRequest: {
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
          reviewThreads: { nodes: [] },
          commits: { totalCount: 0, nodes: [] },
        } } } });
      }
      throw new Error(`Unexpected GitHub request: ${endpoint.pathname}`);
    });
    vi.stubGlobal('fetch', fetch);

    const detail = await request(app).get('/api/source-control/github/references/detail')
      .query({ ...readContext(project), owner: 'example', repo: 'project', number: '4', host: 'github.example.com' })
      .expect(200);
    expect(detail.body).toEqual({
      connected: true,
      detail: expect.objectContaining({ number: 4, comments: [], pull: expect.objectContaining({ reviewDecision: 'approved', additions: 1 }) }),
    });
    // Only the named host was used: the request never touched github.com. The
    // detail is read beside its stack, so the host answers two GraphQL calls.
    expect(fetch.mock.calls.every(([url]) => String(url).startsWith('https://github.example.com/'))).toBe(true);
    expect(fetch.mock.calls.filter(([url]) => String(url).endsWith('/api/graphql'))).toHaveLength(2);
  });
});

// /pr/status must derive the request host from the request's own remote, not
// from `origin`: on a checkout with remotes on two hosts, a branch probed on
// the enterprise remote must scope to the enterprise host. The host-scope unit
// tests inject `requestHost` directly; this exercises the route's derivation.
describe('GET /api/source-control/github/pr/status with remotes on two hosts', () => {
  let app;
  const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'openchamber-github-pulls-status-two-hosts-'));
  const project = path.join(dataDir, 'project');
  const ghConfigDir = path.join(dataDir, 'gh-config');
  const binDirectory = path.join(dataDir, 'bin');
  const previousConfigDir = process.env.GH_CONFIG_DIR;
  const previousPath = process.env.PATH;

  beforeAll(async () => {
    process.env.OPENCHAMBER_DATA_DIR = dataDir;
    process.env.GH_CONFIG_DIR = ghConfigDir;
    fs.mkdirSync(project);
    fs.mkdirSync(binDirectory, { recursive: true });
    fs.mkdirSync(ghConfigDir, { recursive: true });
    fs.writeFileSync(path.join(binDirectory, 'gh'), '#!/bin/sh\necho gho_upstream\n', { mode: 0o755 });
    execFileSync('git', ['init', '-q', project]);
    execFileSync('git', ['-C', project, 'remote', 'add', 'origin', 'https://github.com/example/project.git']);
    execFileSync('git', ['-C', project, 'remote', 'add', 'upstream', 'https://github.example.com/example/project.git']);
    fs.writeFileSync(path.join(ghConfigDir, 'hosts.yml'), 'github.example.com:\n  user: ghe-user\n  oauth_token: gho_upstream\n');
    const { setGitHubAuth, setGhCliDisabled, setGhCliActive, setGhCliActiveForHost } = await import('../github/auth.js');
    setGhCliDisabled(false);
    setGhCliActive(true);
    setGhCliActiveForHost('github.example.com', true);
    ({ accountId } = await setGitHubAuth({ accessToken: 'fake-test-token', user: { id: 7, login: 'tester' } }));
    process.env.PATH = `${binDirectory}${path.delimiter}${previousPath}`;
    app = express();
    registerGitHubRoutes(app, routeOptions());
  });

  afterEach(() => {
    vi.unstubAllGlobals();
    vi.restoreAllMocks();
  });

  afterAll(() => {
    if (previousConfigDir === undefined) delete process.env.GH_CONFIG_DIR;
    else process.env.GH_CONFIG_DIR = previousConfigDir;
    process.env.PATH = previousPath;
    fs.rmSync(dataDir, { recursive: true, force: true });
  });

  it('probes the enterprise remote on its own host and never the same-named github.com repo', async () => {
    // The binding names the enterprise instance and its upstream remote; with
    // no exact account the host's gh login reads, so the status probe targets
    // the enterprise repo on its own host — never api.github.com.
    const fetch = vi.fn(async (url) => {
      const endpoint = new URL(url);
      if (endpoint.pathname === '/api/v3/repos/example/project') return response({ full_name: 'example/project', fork: false });
      if (endpoint.pathname.startsWith('/api/v3/repos/example/project/pulls')) return response([]);
      throw new Error(`Unexpected GitHub request: ${endpoint.pathname}`);
    });
    vi.stubGlobal('fetch', fetch);

    const res = await request(app).get('/api/source-control/github/pr/status')
      .query({ ...readContext(project), instance: 'github.example.com', accountId: '', primaryRemote: 'upstream', branch: 'feature' })
      .expect(200);
    // The answer names the enterprise repo, and every API call went to the
    // enterprise host.
    expect(res.body).toMatchObject({
      identity: { provider: 'github', instance: 'github.example.com' },
      project: { instance: 'github.example.com', id: 'example/project', owner: 'example', name: 'project' },
      changeRequest: null,
      resolvedRemoteName: 'upstream',
    });
    expect(fetch).toHaveBeenCalled();
    expect(fetch.mock.calls.every(([url]) => String(url).startsWith('https://github.example.com/'))).toBe(true);
  });

  it('follows the bound context, as the client sends it, to the enterprise host', async () => {
    // The real client names no `remote`: the binding's primaryRemote and its
    // enterprise PAT account decide, and origin's same-named github.com repo
    // must never be asked.
    const { setGitHubAuthForHost, removeGitHubAuthAccountForHost } = await import('../github/auth.js');
    const credential = await setGitHubAuthForHost('github.example.com', {
      accessToken: 'ghe-pat', user: { id: 42, login: 'ghe-user' }, source: 'pat',
    });
    const fetch = vi.fn(async (url) => {
      const endpoint = new URL(url);
      if (endpoint.pathname === '/api/v3/repos/example/project') return response({ full_name: 'example/project', fork: false });
      if (endpoint.pathname.startsWith('/api/v3/repos/example/project/pulls')) return response([]);
      return response({});
    });
    vi.stubGlobal('fetch', fetch);
    try {
      const res = await request(app).get('/api/source-control/github/pr/status')
        .query({
          ...readContext(project),
          instance: 'github.example.com',
          accountId: credential.credentialId,
          primaryRemote: 'upstream',
          branch: 'feature',
          force: 'true',
        })
        .expect(200);
      expect(res.body).toMatchObject({
        identity: { provider: 'github', instance: 'github.example.com' },
        project: { instance: 'github.example.com', id: 'example/project', owner: 'example', name: 'project' },
      });
      expect(fetch).toHaveBeenCalled();
      expect(fetch.mock.calls.every(([url]) => String(url).startsWith('https://github.example.com/'))).toBe(true);
      // It ran as the bound PAT account, not the host's gh login.
      expect(fetch.mock.calls.every(([, init]) => new Headers(init?.headers).get('authorization') === 'token ghe-pat')).toBe(true);
    } finally {
      await removeGitHubAuthAccountForHost('github.example.com', credential.credentialId);
    }
  });

  it('keeps github.com scope for an origin remote on the same checkout', async () => {
    const fetch = vi.fn(async () => response({ data: { repository: { issueOrPullRequest: null } } }));
    vi.stubGlobal('fetch', fetch);

    const res = await request(app).get('/api/source-control/github/pr/status')
      .query({ ...readContext(project), branch: 'feature' })
      .expect(200);
    expect(res.body).toMatchObject({
      identity: { provider: 'github', instance: 'github.com' },
      project: { instance: 'github.com', id: 'example/project' },
    });
    expect(fetch.mock.calls.every(([url]) => String(url).startsWith('https://api.github.com/'))).toBe(true);
  });
});

// The merge-permission login memo is keyed by host AND credential identity: a
// host whose active credential switches to a different user (a new per-instance
// PAT) must resolve its own login through its own Octokit instead of replaying
// the previous credential's memoized login (routes.js `authLoginByHost`).
describe('GET /api/source-control/github/pr/status resolves a host login per credential', () => {
  let app;
  const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'openchamber-github-pr-status-login-'));
  const project = path.join(dataDir, 'project');
  const ghConfigDir = path.join(dataDir, 'gh-config');
  const previousConfigDir = process.env.GH_CONFIG_DIR;

  beforeAll(async () => {
    process.env.OPENCHAMBER_DATA_DIR = dataDir;
    process.env.GH_CONFIG_DIR = ghConfigDir;
    fs.mkdirSync(project);
    fs.mkdirSync(ghConfigDir, { recursive: true });
    fs.writeFileSync(path.join(ghConfigDir, 'hosts.yml'), 'github.example.com:\n  user: ghe-user\n  oauth_token: gho_ghe\n');
    execFileSync('git', ['init', '-q', project]);
    execFileSync('git', ['-C', project, 'remote', 'add', 'origin', 'https://github.example.com/example/project.git']);
    const { setGitHubAuth, setGhCliDisabled } = await import('../github/auth.js');
    setGhCliDisabled(true);
    ({ accountId } = await setGitHubAuth({ accessToken: 'fake-test-token', user: { id: 7, login: 'tester' } }));
    app = express();
    registerGitHubRoutes(app, {
      ...routeOptions(),
      resolveGitHubPrStatus: async () => ({ repo: { owner: 'example', repo: 'project', host: 'github.example.com' }, pr: { number: 42 }, defaultBranch: 'main', resolvedRemoteName: 'origin' }),
    });
  });

  afterEach(() => {
    vi.unstubAllGlobals();
    vi.restoreAllMocks();
  });

  afterAll(() => {
    if (previousConfigDir === undefined) delete process.env.GH_CONFIG_DIR;
    else process.env.GH_CONFIG_DIR = previousConfigDir;
    fs.rmSync(dataDir, { recursive: true, force: true });
  });

  it('resolves a changed per-instance PAT to its own login, not the previous one', async () => {
    const { setGitHubAuthForHost, getGitHubAuthForHost, removeGitHubAuthAccountForHost } = await import('../github/auth.js');
    const stale = await getGitHubAuthForHost('github.example.com');
    if (stale) await removeGitHubAuthAccountForHost('github.example.com', stale.accountId);
    const first = await setGitHubAuthForHost('github.example.com', { accessToken: 'pat-a', user: { id: 1, login: 'user-a' }, source: 'pat' });
    const logins = { 'token pat-a': 'user-a', 'token pat-b': 'user-b' };
    const fetch = vi.fn(async (url, init) => {
      const endpoint = new URL(url);
      const authorization = new Headers(init?.headers).get('authorization');
      if (endpoint.pathname === '/api/v3/repos/example/project/pulls/42') {
        return response({ ...pull(42), state: 'open', head: { ref: 'feature', sha: 'sha-42' } });
      }
      if (endpoint.pathname === '/api/v3/repos/example/project/commits/sha-42/check-runs') {
        return response({ check_runs: [] });
      }
      if (endpoint.pathname === '/api/v3/user') {
        return response({ login: logins[authorization] });
      }
      const permission = /^\/api\/v3\/repos\/example\/project\/collaborators\/([^/]+)\/permission$/.exec(endpoint.pathname);
      if (permission) return response({ permission: 'write' });
      throw new Error(`Unexpected GitHub request: ${endpoint.pathname}`);
    });
    vi.stubGlobal('fetch', fetch);

    // Each read runs as the account its binding names, as the client sends it.
    const query = (credential) => ({
      ...readContext(project), instance: 'github.example.com', accountId: credential.credentialId, branch: 'feature',
    });
    const firstStatus = await request(app).get('/api/source-control/github/pr/status').query(query(first)).expect(200);
    expect(firstStatus.body.canMerge).toBe(true);
    expect(firstStatus.body.project).toMatchObject({ instance: 'github.example.com' });

    // Switch the host's active credential to a second user while the process is
    // still up: the permission lookup must resolve that user, not the first
    // credential's memoized login.
    const second = await setGitHubAuthForHost('github.example.com', { accessToken: 'pat-b', user: { id: 2, login: 'user-b' }, source: 'pat' });

    const secondStatus = await request(app).get('/api/source-control/github/pr/status').query(query(second)).expect(200);
    expect(secondStatus.body.canMerge).toBe(true);
    const permissionLogins = fetch.mock.calls
      .map(([url]) => /^\/api\/v3\/repos\/example\/project\/collaborators\/([^/]+)\/permission$/.exec(new URL(url).pathname)?.[1])
      .filter(Boolean);
    expect(permissionLogins).toEqual(['user-a', 'user-b']);
  });
});

describe('POST /api/source-control/github/auth/cli toggles a GitHub Enterprise instance gh switch', () => {
  let app;
  const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'openchamber-github-auth-cli-'));
  const ghConfigDir = path.join(dataDir, 'gh-config');
  const previousDataDir = process.env.OPENCHAMBER_DATA_DIR;
  const previousConfigDir = process.env.GH_CONFIG_DIR;

  beforeAll(async () => {
    process.env.OPENCHAMBER_DATA_DIR = dataDir;
    process.env.GH_CONFIG_DIR = ghConfigDir;
    fs.mkdirSync(ghConfigDir, { recursive: true });
    fs.writeFileSync(path.join(ghConfigDir, 'hosts.yml'), 'github.example.com:\n  user: ghe-user\n  oauth_token: gho_ghe\n');
    app = express();
    app.use(express.json());
    registerGitHubRoutes(app, routeOptions());
  });

  afterEach(() => {
    vi.unstubAllGlobals();
    vi.restoreAllMocks();
  });

  afterAll(() => {
    if (previousDataDir === undefined) delete process.env.OPENCHAMBER_DATA_DIR;
    else process.env.OPENCHAMBER_DATA_DIR = previousDataDir;
    if (previousConfigDir === undefined) delete process.env.GH_CONFIG_DIR;
    else process.env.GH_CONFIG_DIR = previousConfigDir;
    fs.rmSync(dataDir, { recursive: true, force: true });
  });

  it('turns the trusted instance gh CLI off without touching github.com', async () => {
    await request(app)
      .post('/api/source-control/github/auth/cli')
      .query({ instance: 'github.example.com' })
      .send({ disabled: true })
      .expect(200)
      .expect((res) => expect(res.body).toEqual({ available: false, disabled: true }));

    const { isGhCliDisabledForHost, isGhCliDisabled, setGhCliDisabled } = await import('../github/auth.js');
    expect(await isGhCliDisabledForHost('github.example.com')).toBe(true);
    setGhCliDisabled(false);
    expect(await isGhCliDisabledForHost('github.com')).toBe(false);
  });

  it('refuses an untrusted instance', async () => {
    await request(app)
      .post('/api/source-control/github/auth/cli')
      .query({ instance: 'gitlab.example.org' })
      .send({ disabled: true })
      .expect(400);
  });
});


describe('pull request head for a worktree made by number', () => {  let github;
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
    const { setGitHubAuth, setGhCliDisabled } = await import('../github/auth.js');
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
    const { setGhCliActive, setGhCliDisabled } = await import('../github/auth.js');
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

// A GitHub Enterprise host takes a personal access token directly (the same
// per-instance model GitLab uses). The route verifies the token against the
// instance before it is stored, and the host-trust gate stays the first word:
  // a host the user registered with a PAT is verified and stored; the stored
  // PAT is what makes the host trusted, so no gh login or environment is needed.
describe('POST /api/source-control/github/auth/token (GitHub Enterprise PAT)', () => {
  let app;
  let github;
  const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'openchamber-github-token-'));
  const ghConfigDir = path.join(dataDir, 'gh-config');
  const previousConfigDir = process.env.GH_CONFIG_DIR;

  beforeAll(async () => {
    process.env.OPENCHAMBER_DATA_DIR = dataDir;
    process.env.GH_CONFIG_DIR = ghConfigDir;
    fs.mkdirSync(ghConfigDir, { recursive: true });
    fs.writeFileSync(path.join(ghConfigDir, 'hosts.yml'), 'github.example.com:\n  user: ghe-user\n  oauth_token: gho_ghe\n');
    accountId = '';
    const { setGhCliDisabled } = await import('../github/auth.js');
    // No gh login in play: a PAT is the instance credential this test is about.
    setGhCliDisabled(true);
    app = express();
    app.use(express.json());
    github = registerGitHubRoutes(app, routeOptions());
  });

  afterEach(() => {
    vi.unstubAllGlobals();
    vi.restoreAllMocks();
  });

  afterAll(() => {
    if (previousConfigDir === undefined) delete process.env.GH_CONFIG_DIR;
    else process.env.GH_CONFIG_DIR = previousConfigDir;
    fs.rmSync(dataDir, { recursive: true, force: true });
  });

  it('verifies a PAT against a trusted enterprise host and stores it per instance', async () => {
    // The suite shares this data dir; earlier tests stored PATs for the same
    // host, so start from a file this test owns.
    fs.rmSync(path.join(dataDir, 'source-control-auth.json'), { force: true });
    const fetch = vi.fn(async (url, init) => {
      const authorization = new Headers(init?.headers).get('authorization');
      if (String(url) === 'https://github.example.com/api/v3/user' && authorization === 'token ghe-pat') {
        return response({ id: 42, login: 'ghe-user', email: 'ghe@example.com' });
      }
      throw new Error(`Unexpected request: ${url}`);
    });
    vi.stubGlobal('fetch', fetch);

    const res = await request(app).post('/api/source-control/github/auth/token')
      .query({ instance: 'github.example.com' })
      .send({ token: 'ghe-pat' })
      .expect(200);

    expect(res.body).toMatchObject({
      connected: true,
      user: { provider: 'github', instance: 'github.example.com', id: '42', username: 'ghe-user', email: 'ghe@example.com' },
    });
    const { getGitHubAuthForHost } = await import('../github/auth.js');
    expect(await getGitHubAuthForHost('github.example.com')).toMatchObject({
      accessToken: 'ghe-pat', source: 'pat', user: { id: 42, login: 'ghe-user' },
    });
    expect(fetch).toHaveBeenCalled();
    // The PAT lives in the server token store GitLab uses, keyed by the instance;
    // github.com's own github-auth.json (whose path is bound at module load,
    // outside this suite's data dir) does not get the host's credential.
    const stored = JSON.parse(fs.readFileSync(path.join(dataDir, 'source-control-auth.json'), 'utf8'));
    expect(stored.providers.github.instances['github.example.com'].credentials.map((credential) => credential.accessToken)).toEqual(['ghe-pat']);
  });

  it('rejects a PAT for github.com, whose own token entry is its device flow', async () => {
    const fetch = vi.fn(async () => response({ id: 7, login: 'user' }));
    vi.stubGlobal('fetch', fetch);

    const res = await request(app).post('/api/source-control/github/auth/token')
      .query({ instance: 'github.com' })
      .send({ token: 'personal-token' })
      .expect(400);

    expect(res.body).toEqual({ error: 'Personal access tokens are only accepted for a GitHub Enterprise instance' });
    // The token was never sent: no verification call reached GitHub with it.
    expect(fetch).not.toHaveBeenCalled();
  });

  it('refuses an instance that is no plain host before sending the token anywhere', async () => {
    const fetch = vi.fn(async () => response({ id: 42, login: 'ghe-user' }));
    vi.stubGlobal('fetch', fetch);

    for (const instance of ['attacker@github.example.com', 'github.example.com/path', 'github.example.com:8443']) {
      await request(app).post('/api/source-control/github/auth/token')
        .query({ instance })
        .send({ token: 'ghe-pat' })
        .expect(400);
    }
    expect(fetch).not.toHaveBeenCalled();
  });

  it('answers a rejected PAT with GitHub\'s reason under INVALID_TOKEN', async () => {
    const fetch = vi.fn(async () => response({ message: 'Bad credentials' }, 401));
    vi.stubGlobal('fetch', fetch);

    const res = await request(app).post('/api/source-control/github/auth/token')
      .query({ instance: 'github.example.com' })
      .send({ token: 'bad-pat' })
      .expect(401);

    expect(res.body).toEqual({ error: 'Bad credentials', code: 'INVALID_TOKEN' });
    const { getGitHubAuthForHost } = await import('../github/auth.js');
    expect(await getGitHubAuthForHost('github.example.com')?.accessToken).toBeUndefined();
  });

  it('trusts a host the user registered with a PAT even with no gh login and no environment', async () => {
    const fetch = vi.fn(async (url, init) => {
      const authorization = new Headers(init?.headers).get('authorization');
      if (String(url) === 'https://untrusted.example.com/api/v3/user') {
        return response({ id: 1, login: 'nobody' });
      }
      throw new Error(`Unexpected request: ${url}`);
    });
    vi.stubGlobal('fetch', fetch);

    const res = await request(app).post('/api/source-control/github/auth/token')
      .query({ instance: 'untrusted.example.com' })
      .send({ token: 'leaked-pat' })
      .expect(200);

    expect(res.body.connected).toBe(true);
    // Registering the PAT is the trust: the token reached the host, was
    // verified, and now stands as the host's stored credential.
    expect(fetch).toHaveBeenCalled();
    const { getGitHubAuthForHost, removeGitHubAuthAccountForHost } = await import('../github/auth.js');
    const stored = await getGitHubAuthForHost('untrusted.example.com');
    expect(stored).toMatchObject({ accessToken: 'leaked-pat', source: 'pat' });
    if (stored?.credentialId) await removeGitHubAuthAccountForHost('untrusted.example.com', stored.credentialId);
  });

  it('readCurrentAccountId resolves a host from its stored PAT, not the github.com account', async () => {
    const fetch = vi.fn(async (url, init) => {
      const authorization = new Headers(init?.headers).get('authorization');
      if (String(url) === 'https://github.example.com/api/v3/user' && authorization === 'token ghe-host-pat') {
        return response({ id: 42, login: 'ghe-user', email: 'ghe@example.com' });
      }
      throw new Error(`Unexpected request: ${url}`);
    });
    vi.stubGlobal('fetch', fetch);

    const res = await request(app).post('/api/source-control/github/auth/token')
      .query({ instance: 'github.example.com' })
      .send({ token: 'ghe-host-pat' })
      .expect(200);

    expect(res.body.connected).toBe(true);
    const { getGitHubAuthForHost } = await import('../github/auth.js');
    const stored = await getGitHubAuthForHost('github.example.com');
    // The stored PAT is the host's active account while its gh login is inactive,
    // so the host case must not fall through to the github.com account, which
    // this suite has: the two reads land on different credentials.
    await expect(github.readCurrentAccountId('github.example.com')).resolves.toBe(stored.accountId);
    expect(await github.readCurrentAccountId('github.com')).not.toBe(stored.accountId);
  });

  it('answers removed:false, not 500, when a revoked gh token for a host is disconnected', async () => {
    // The 401 travels the whole branch that used to answer 500: the route takes
    // hosts.yml's oauth_token, verifies it against the host, and the rejection
    // means that account is really gone.
    const fetch = vi.fn(async () => response({ message: 'Bad credentials' }, 401));
    vi.stubGlobal('fetch', fetch);

    const res = await request(app).delete('/api/source-control/github/auth')
      .query({ accountId: 'github.example.com#cli:999' })
      .expect(200);

    expect(res.body).toEqual({ removed: false });
    expect(fetch).toHaveBeenCalledWith('https://github.example.com/api/v3/user', expect.anything());
  });
});

// /pr/status answers a trusted host it holds no credential for distinctly from
// a remote that is not a GitHub host at all: the first is a connect action,
// the second is simply "no GitHub repo here" (PR #3673).
describe('GET /api/source-control/github/pr/status host answers without a credential', () => {
  let app;
  const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'openchamber-github-pr-status-host-answers-'));
  const gheProject = path.join(dataDir, 'ghe-project');
  const otherProject = path.join(dataDir, 'other-project');
  const ghConfigDir = path.join(dataDir, 'gh-config');
  const previousConfigDir = process.env.GH_CONFIG_DIR;

  beforeAll(async () => {
    process.env.OPENCHAMBER_DATA_DIR = dataDir;
    process.env.GH_CONFIG_DIR = ghConfigDir;
    fs.mkdirSync(ghConfigDir, { recursive: true });
    fs.mkdirSync(gheProject);
    fs.mkdirSync(otherProject);
    execFileSync('git', ['init', '-q', gheProject]);
    execFileSync('git', ['-C', gheProject, 'remote', 'add', 'origin', 'https://github.example.com/example/project.git']);
    execFileSync('git', ['init', '-q', otherProject]);
    execFileSync('git', ['-C', otherProject, 'remote', 'add', 'origin', 'https://gitlab.example.org/group/project.git']);
    fs.writeFileSync(path.join(ghConfigDir, 'hosts.yml'), 'github.example.com:\n  user: ghe-user\n  oauth_token: gho_ghe\n');
    accountId = '';
    const { setGhCliDisabled, setGhCliActiveForHost, getGitHubAuthForHost, removeGitHubAuthAccountForHost } = await import('../github/auth.js');
    // Trusted instance, but gh is not usable: the gh login is inactive and no
    // per-host PAT exists, so the route holds no credential for the host. gh is
    // switched off for this host too — an earlier suite may have activated it.
    setGhCliDisabled(true);
    setGhCliActiveForHost('github.example.com', false);
    // The PAT describe above runs against the same in-process store; drop its
    // per-host credential so this suite starts from "trusted host, no credential".
    const leaked = await getGitHubAuthForHost('github.example.com');
    if (leaked) await removeGitHubAuthAccountForHost('github.example.com', leaked.accountId);
    // A suite above stored a per-host PAT while the process stayed up; clear every
    // leftover account so an earlier test's credential cannot change this answer.
    for (let next; (next = await getGitHubAuthForHost('github.example.com'));) {
      await removeGitHubAuthAccountForHost('github.example.com', next.accountId);
    }
    app = express();
    registerGitHubRoutes(app, routeOptions());
  });

  afterEach(() => {
    vi.unstubAllGlobals();
    vi.restoreAllMocks();
  });

  afterAll(() => {
    if (previousConfigDir === undefined) delete process.env.GH_CONFIG_DIR;
    else process.env.GH_CONFIG_DIR = previousConfigDir;
    fs.rmSync(dataDir, { recursive: true, force: true });
  });

  it('answers a trusted GitHub Enterprise host without a credential as an unavailable account', async () => {
    const fetch = vi.fn(async () => {
      throw new Error('no credential should mean no GitHub call');
    });
    vi.stubGlobal('fetch', fetch);

    const res = await request(app).get('/api/source-control/github/pr/status')
      .query({ ...readContext(gheProject), instance: 'github.example.com', accountId: '', branch: 'feature' })
      .expect(401);

    expect(res.body).toEqual({ error: 'GitHub account is unavailable' });
    expect(fetch).not.toHaveBeenCalled();
  });

  it('keeps the non-GitHub-remote answer for a remote on a host the server never authenticates with', async () => {
    const fetch = vi.fn(async () => {
      throw new Error('a non-GitHub remote must not trigger any GitHub call');
    });
    vi.stubGlobal('fetch', fetch);

    const res = await request(app).get('/api/source-control/github/pr/status')
      .query({ ...readContext(otherProject), branch: 'feature' })
      .expect(200);

    // A gitlab.example.org remote is not a GitHub host: no credential is
    // expected there, so the answer is the plain no-repo read.
    expect(res.body).toMatchObject({ identity: { provider: 'github', instance: 'github.com' }, project: null, changeRequest: null });
    expect(fetch).not.toHaveBeenCalled();
  });
});
