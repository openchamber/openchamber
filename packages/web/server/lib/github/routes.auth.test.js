import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import express from 'express';
import request from 'supertest';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { createBindingService } from '../source-control/binding-service.js';

let directory;
let previousDataDirectory;
let auth;
let registerGitHubRoutes;

beforeEach(async () => {
  directory = await fs.mkdtemp(path.join(os.tmpdir(), 'openchamber-github-routes-'));
  previousDataDirectory = process.env.OPENCHAMBER_DATA_DIR;
  process.env.OPENCHAMBER_DATA_DIR = directory;
  vi.resetModules();
  auth = await import('./auth.js');
  ({ registerGitHubRoutes } = await import('./routes.js'));
});

afterEach(async () => {
  if (previousDataDirectory === undefined) delete process.env.OPENCHAMBER_DATA_DIR;
  else process.env.OPENCHAMBER_DATA_DIR = previousDataDirectory;
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
  await fs.rm(directory, { recursive: true, force: true });
});

const makeApp = (options = {}) => {
  const app = express();
  app.use(express.json());
  registerGitHubRoutes(app, {
    validateReadContext: async (context) => ({ ...context, accountId: context.accountId, primaryRemote: context.primaryRemote || 'origin' }),
    ...options,
  });
  return app;
};

const boundQuery = (accountId, extra = {}) => ({
  directory,
  repositoryId: 'repo_one',
  bindingRevision: 1,
  accountId,
  primaryRemote: 'origin',
  instance: 'github.com',
  ...extra,
});

describe('GitHub account routes', () => {
  it('returns an actionable busy response when auth inventory is locked', async () => {
    await fs.writeFile(path.join(directory, 'github-auth.json.lock'), 'other-writer\n', 'utf8');

    const response = await request(makeApp()).get('/api/source-control/github/auth/accounts').expect(503);

    expect(response.body).toMatchObject({ code: 'SOURCE_CONTROL_LOCK_BUSY' });
    expect(response.body.error).toContain('stale-lock recovery');
  });

  it('reports invalid auth storage without replacing it with an empty inventory', async () => {
    await fs.writeFile(path.join(directory, 'github-auth.json'), '{broken', 'utf8');

    const response = await request(makeApp()).get('/api/source-control/github/auth/accounts').expect(500);

    expect(response.body).toEqual({ error: 'GitHub auth storage is invalid', code: 'INVALID_GITHUB_AUTH' });
    expect(await fs.readFile(path.join(directory, 'github-auth.json'), 'utf8')).toBe('{broken');
  });

  it.each([['SOURCE_CONTROL_LOCK_BUSY', 503], ['SOURCE_CONTROL_LOCK_FAILED', 500]])('preserves actionable %s reads and account-removal failures', async (code, status) => {
    const account = await auth.setGitHubAuth({ accessToken: 'token-one', user: { id: 7, login: 'actor' } });
    const message = 'Stop all writers before stale-lock cleanup';
    const fail = async () => { throw Object.assign(new Error(message), { code, status }); };
    const app = makeApp({ validateReadContext: fail, onAccountRemoved: fail });
    const read = await request(app).get('/api/source-control/github/pr/status')
      .query(boundQuery(account.accountId, { branch: 'feature' })).expect(status);
    expect(read.body).toEqual({ error: message, code });
    const removal = await request(app).delete('/api/source-control/github/auth').query({ accountId: account.accountId }).expect(status);
    expect(removal.body).toEqual({ error: message, code });
    expect(await auth.getGitHubAuthByAccountId(account.accountId)).not.toBeNull();
  });

  it('keeps the provider device code server-side and consumes successful flows once', async () => {
    const fetch = vi.fn(async (url) => {
      if (url === 'https://github.com/login/device/code') {
        return Response.json({
          device_code: 'raw-device-code', user_code: 'ABCD-1234', verification_uri: 'https://github.com/login/device',
          expires_in: 300, interval: 5,
        });
      }
      if (url === 'https://github.com/login/oauth/access_token') {
        return Response.json({ access_token: 'oauth-token', token_type: 'bearer', scope: 'repo' });
      }
      if (url === 'https://api.github.com/user') {
        return Response.json({ id: 7, login: 'user', email: 'user@example.com' });
      }
      throw new Error(`Unexpected URL: ${url}`);
    });
    vi.stubGlobal('fetch', fetch);
    const app = makeApp();

    const started = await request(app).post('/api/source-control/github/auth/start').send({}).expect(200);
    expect(started.body).toMatchObject({ flowId: expect.stringMatching(/^oauth_/), userCode: 'ABCD-1234' });
    expect(JSON.stringify(started.body)).not.toContain('raw-device-code');
    expect(started.headers['cache-control']).toBe('no-store');

    const completed = await request(app).post('/api/source-control/github/auth/complete')
      .send({ flowId: started.body.flowId }).expect(200);
    expect(completed.headers['cache-control']).toBe('no-store');
    await request(app).post('/api/source-control/github/auth/complete')
      .send({ flowId: started.body.flowId }).expect(410);
    expect(await auth.getGitHubAuthAccounts()).toEqual([expect.objectContaining({ providerUserId: 'github.com#7' })]);
  });

  it('lists stable account inventory without tokens', async () => {
    await auth.setGitHubAuth({ accessToken: 'stored-secret', user: { id: 7, login: 'user' } });

    const response = await request(makeApp()).get('/api/source-control/github/auth/accounts').expect(200);

    expect(response.body.accounts).toEqual([expect.objectContaining({
      id: expect.stringMatching(/^occred:v1:github:/), credentialRevision: 1, providerUserId: 'github.com#7', status: 'valid',
    })]);
    expect(JSON.stringify(response.body)).not.toContain('stored-secret');
  });

  it('requires an exact credential accountId for removal and never falls back to current', async () => {
    const first = await auth.setGitHubAuth({ accessToken: 'token-one', user: { id: 7, login: 'first' } });
    const current = await auth.setGitHubAuth({ accessToken: 'token-two', user: { id: 8, login: 'current' } });
    const onAccountRemoved = vi.fn();
    const app = makeApp({ onAccountRemoved });

    await request(app).delete('/api/source-control/github/auth').expect(400, { error: 'accountId is required' });
    await request(app).delete('/api/source-control/github/auth').query({ accountId: ` ${first.accountId} ` })
      .expect(400, { error: 'accountId is required' });
    expect(await auth.getGitHubAuthByAccountId(first.accountId)).not.toBeNull();
    expect(await auth.getGitHubAuthByAccountId(current.accountId)).not.toBeNull();
    expect(onAccountRemoved).not.toHaveBeenCalled();

    await request(app).delete('/api/source-control/github/auth').query({ accountId: first.accountId }).expect(200, {
      success: true, removed: true,
    });
    expect(onAccountRemoved).toHaveBeenCalledWith({ provider: 'github', instance: 'github.com', accountId: first.accountId });
    expect(await auth.getGitHubAuthByAccountId(first.accountId)).toBeNull();
    expect(await auth.getGitHubAuthByAccountId(current.accountId)).not.toBeNull();
  });

  it('retires ambient account user lookup before auth resolution', async () => {
    const getAuth = vi.spyOn(auth, 'getGitHubAuth');
    const app = makeApp();

    await request(app).get('/api/github/me').expect(410, {
      error: 'GitHub account user route is retired',
      code: 'SOURCE_CONTROL_ACCOUNT_CONTEXT_REQUIRED',
    });
    expect(getAuth).not.toHaveBeenCalled();
  });

  it('uses the requested non-current account and does not fall back', async () => {
    const first = await auth.setGitHubAuth({ accessToken: 'token-one', user: { id: 7, login: 'first' } });
    await auth.setGitHubAuth({ accessToken: 'token-two', user: { id: 8, login: 'current' } });
    const fetch = vi.fn(async () => Response.json([{ name: 'main' }]));
    vi.stubGlobal('fetch', fetch);

    const options = {
      resolveGitHubRepoFromDirectory: vi.fn(async () => ({ repo: { owner: 'owner', repo: 'repo' } })),
    };
    const response = await request(makeApp(options)).get('/api/source-control/github/repo/branches')
      .query(boundQuery(first.accountId, { owner: 'owner', repo: 'repo' })).expect(200);

    expect(response.body).toEqual({ branches: ['main'] });
    expect(fetch.mock.calls[0][1].headers.authorization).toBe('token token-one');
    await request(makeApp(options)).get('/api/source-control/github/repo/branches')
      .query(boundQuery('github.com#999', { owner: 'owner', repo: 'repo' })).expect(401);
  });

  it('checks an exact account before serving its cached PR status', async () => {
    const account = await auth.setGitHubAuth({ accessToken: 'token-one', user: { id: 7, login: 'first' } });
    const app = makeApp();
    const query = { directory, branch: 'feature', accountId: account.accountId };

    const initial = await request(app).get('/api/source-control/github/pr/status').query(query).expect(200);
    expect(initial.body.connected).toBe(true);
    await auth.removeGitHubAuthAccount(account.accountId);

    await request(app).get('/api/source-control/github/pr/status').query(query).expect(401);
  });

  it('retires the legacy PR status route before repository or account resolution', async () => {
    await auth.setGitHubAuth({ accessToken: 'token-one', user: { id: 7, login: 'first' } });
    const validateReadContext = vi.fn(async () => {
      throw new Error('legacy route must not validate a binding');
    });

    const response = await request(makeApp({ validateReadContext }))
      .get('/api/github/pr/status')
      .query({ directory, branch: 'feature', remote: 'origin' })
      .expect(410);

    expect(response.body.code).toBe('SOURCE_CONTROL_CONTEXT_REQUIRED');
    expect(validateReadContext).not.toHaveBeenCalled();
  });

  it('isolates warm canonical status caches by repository and binding revision', async () => {
    const account = await auth.setGitHubAuth({ accessToken: 'token-one', user: { id: 7, login: 'first' } });
    const app = makeApp();
    const now = vi.spyOn(Date, 'now');
    const query = {
      directory,
      branch: 'feature',
      repositoryId: 'repo_one',
      bindingRevision: 1,
      accountId: account.accountId,
      primaryRemote: 'origin',
      instance: 'github.com',
    };

    now.mockReturnValue(1_000);
    const first = await request(app).get('/api/source-control/github/pr/status').query(query).expect(200);
    now.mockReturnValue(2_000);
    const replaced = await request(app).get('/api/source-control/github/pr/status')
      .query({ ...query, repositoryId: 'repo_two' }).expect(200);
    now.mockReturnValue(3_000);
    const rebound = await request(app).get('/api/source-control/github/pr/status')
      .query({ ...query, repositoryId: 'repo_two', bindingRevision: 2 }).expect(200);
    now.mockReturnValue(4_000);
    const warm = await request(app).get('/api/source-control/github/pr/status')
      .query({ ...query, repositoryId: 'repo_two', bindingRevision: 2 }).expect(200);

    expect(first.body.fetchedAt).toBe(1_000);
    expect(replaced.body.fetchedAt).toBe(2_000);
    expect(rebound.body.fetchedAt).toBe(3_000);
    expect(warm.body.fetchedAt).toBe(3_000);
  });

  it('does not populate a legacy status cache', async () => {
    await auth.setGitHubAuth({ accessToken: 'token-one', user: { id: 7, login: 'first' } });
    const app = makeApp();
    const now = vi.spyOn(Date, 'now');
    const query = { directory, branch: 'feature', remote: 'origin' };

    now.mockReturnValue(5_000);
    await request(app).get('/api/github/pr/status').query(query).expect(410);
    now.mockReturnValue(6_000);
    await request(app).get('/api/github/pr/status').query(query).expect(410);
  });

  it('validates bound context before using the matching GitHub account', async () => {
    const account = await auth.setGitHubAuth({ accessToken: 'token-one', user: { id: 7, login: 'first' } });
    const validateReadContext = vi.fn(async (context) => ({ ...context, accountId: account.accountId, primaryRemote: 'origin' }));
    const query = {
      directory, branch: 'feature', repositoryId: 'repo_one', bindingRevision: 3,
      accountId: account.accountId, primaryRemote: 'origin', instance: 'github.com',
    };

    const response = await request(makeApp({ validateReadContext })).get('/api/source-control/github/pr/status').query(query).expect(200);

    expect(response.body.connected).toBe(true);
    expect(validateReadContext).toHaveBeenCalledWith(expect.objectContaining({
      directory, repositoryId: 'repo_one', provider: 'github', accountId: account.accountId, bindingRevision: 3,
    }));
  });

  it('validates a canonical status request through the real binding service', async () => {
    const account = await auth.setGitHubAuth({ accessToken: 'token-one', user: { id: 7, login: 'first' } });
    const binding = {
      repositoryId: 'repo_one', revision: 3, state: 'bound', configRevision: 'config_one', remotes: [], auxiliary: [],
      providers: [{ provider: 'github', instance: 'github.com', accountId: account.accountId, primaryRemote: 'origin', readiness: 'ready',
        endpoint: { displayUrl: 'https://github.com/acme/repo.git', fingerprint: 'fetch' } }],
    };
    const store = { read: vi.fn(async () => ({ revision: 3, binding })), compareAndSwap: vi.fn() };
    const bindingService = createBindingService({
      store,
      resolveRepository: async () => ({
        supported: true,
        repositoryId: 'repo_one',
        configRevision: 'config_one',
        bare: false,
        remotes: [{
          name: 'origin',
          fetch: { displayUrl: 'https://github.com/acme/repo.git', fingerprint: 'fetch' },
          push: { displayUrl: 'git@github.com:acme/repo.git', fingerprint: 'push' },
        }],
      }),
    });

    const response = await request(makeApp({ validateReadContext: bindingService.validateReadContext }))
      .get('/api/source-control/github/pr/status')
      .query({
        directory,
        branch: 'feature',
        repositoryId: 'repo_one',
        bindingRevision: 3,
        accountId: account.accountId,
        primaryRemote: 'origin',
        instance: 'github.com',
      })
      .expect(200);

    expect(response.body.connected).toBe(true);
    expect(store.read).toHaveBeenCalledWith('repo_one');
  });

  it('rejects stale bound context before GitHub account lookup', async () => {
    const account = await auth.setGitHubAuth({ accessToken: 'token-one', user: { id: 7, login: 'first' } });
    const current = { repositoryId: 'repo_two', bindingRevision: 3 };
    const failure = Object.assign(new Error('binding changed'), { code: 'SOURCE_CONTROL_BINDING_STALE', status: 409, current });
    const getAccount = vi.spyOn(auth, 'getGitHubAuthByAccountId');

    const response = await request(makeApp({ validateReadContext: vi.fn(async () => { throw failure; }) }))
      .get('/api/source-control/github/pr/status')
      .query({ directory, branch: 'feature', repositoryId: 'repo_one', bindingRevision: 2, accountId: account.accountId })
      .expect(409);

    expect(response.body.current).toEqual(current);
    expect(getAccount).not.toHaveBeenCalled();
  });

  it('validates canonical pull lists before account lookup', async () => {
    const account = await auth.setGitHubAuth({ accessToken: 'token-one', user: { id: 7, login: 'first' } });
    const failure = Object.assign(new Error('binding changed'), { code: 'SOURCE_CONTROL_BINDING_STALE', status: 409 });
    const getAccount = vi.spyOn(auth, 'getGitHubAuthByAccountId');
    const resolveGitHubRepoFromDirectory = vi.fn();

    const response = await request(makeApp({
      validateReadContext: vi.fn(async () => { throw failure; }),
      resolveGitHubRepoFromDirectory,
    })).get('/api/source-control/github/pulls/list').query({
      directory,
      repositoryId: 'repo_one',
      bindingRevision: 2,
      accountId: account.accountId,
      primaryRemote: 'upstream',
      instance: 'github.com',
    }).expect(409);

    expect(response.body.code).toBe('SOURCE_CONTROL_BINDING_STALE');
    expect(getAccount).not.toHaveBeenCalled();
    expect(resolveGitHubRepoFromDirectory).not.toHaveBeenCalled();
  });

  it('uses the exact bound account and primary remote for canonical pull lists', async () => {
    const bound = await auth.setGitHubAuth({ accessToken: 'bound-token', user: { id: 7, login: 'bound' } });
    await auth.setGitHubAuth({ accessToken: 'active-token', user: { id: 8, login: 'active' } });
    const fetch = vi.fn(async () => Response.json([]));
    vi.stubGlobal('fetch', fetch);
    const resolveGitHubRepoFromDirectory = vi.fn(async () => ({ repo: { owner: 'team', repo: 'project' } }));
    const resolveRepoNetwork = vi.fn(async () => null);
    const query = {
      directory,
      repositoryId: 'repo_one',
      bindingRevision: 3,
      accountId: bound.accountId,
      primaryRemote: 'upstream',
      instance: 'github.com',
    };

    await request(makeApp({ resolveGitHubRepoFromDirectory, resolveRepoNetwork }))
      .get('/api/source-control/github/pulls/list').query(query).expect(200);

    expect(resolveRepoNetwork).toHaveBeenCalledWith(expect.anything(), directory, 'upstream', { strictErrors: true });
    expect(resolveGitHubRepoFromDirectory).toHaveBeenCalledWith(directory, 'upstream');
    expect(fetch.mock.calls.at(-1)[1].headers.authorization).toBe('token bound-token');
  });

  it('retires legacy pull lists before account and repository resolution', async () => {
    await auth.setGitHubAuth({ accessToken: 'active-token', user: { id: 8, login: 'active' } });
    const fetch = vi.fn(async () => Response.json([]));
    vi.stubGlobal('fetch', fetch);
    const validateReadContext = vi.fn(async () => { throw new Error('legacy route must not validate'); });
    const resolveGitHubRepoFromDirectory = vi.fn(async () => ({ repo: { owner: 'team', repo: 'project' } }));
    const resolveRepoNetwork = vi.fn(async () => null);

    await request(makeApp({ validateReadContext, resolveGitHubRepoFromDirectory, resolveRepoNetwork }))
      .get('/api/github/pulls/list').query({ directory }).expect(410);

    expect(validateReadContext).not.toHaveBeenCalled();
    expect(resolveRepoNetwork).not.toHaveBeenCalled();
    expect(resolveGitHubRepoFromDirectory).not.toHaveBeenCalled();
    expect(fetch).not.toHaveBeenCalled();
  });

  it('fails canonical pull lists instead of treating provider failure as empty', async () => {
    const account = await auth.setGitHubAuth({ accessToken: 'token-one', user: { id: 7, login: 'first' } });
    vi.stubGlobal('fetch', vi.fn(async () => Response.json({ message: 'unavailable' }, { status: 503 })));
    const routeOptions = {
      resolveGitHubRepoFromDirectory: vi.fn(async () => ({ repo: { owner: 'team', repo: 'project' } })),
      resolveRepoNetwork: vi.fn(async () => null),
    };

    await request(makeApp(routeOptions)).get('/api/source-control/github/pulls/list').query({
      directory,
      repositoryId: 'repo_one',
      bindingRevision: 3,
      accountId: account.accountId,
      primaryRemote: 'origin',
      instance: 'github.com',
    }).expect(500);

    const legacy = await request(makeApp(routeOptions)).get('/api/github/pulls/list').query({ directory }).expect(410);
    expect(legacy.body.code).toBe('SOURCE_CONTROL_CONTEXT_REQUIRED');
  });

  it('returns successful canonical repositories with explicit incomplete scopes', async () => {
    const account = await auth.setGitHubAuth({ accessToken: 'token-one', user: { id: 7, login: 'first' } });
    vi.stubGlobal('fetch', vi.fn(async (url) => {
      if (new URL(url).pathname === '/repos/team/good/pulls') return Response.json([]);
      return Response.json({ message: 'unavailable' }, { status: 503 });
    }));
    const response = await request(makeApp({
      resolveGitHubRepoFromDirectory: vi.fn(async () => ({ repo: { owner: 'team', repo: 'good' } })),
      resolveRepoNetwork: vi.fn(async () => [
        { owner: 'team', repo: 'good', source: 'origin' },
        { owner: 'team', repo: 'unavailable', source: 'upstream' },
      ]),
    })).get('/api/source-control/github/pulls/list').query({
      directory,
      repositoryId: 'repo_one',
      bindingRevision: 3,
      accountId: account.accountId,
      primaryRemote: 'origin',
      instance: 'github.com',
    }).expect(200);

    expect(response.body).toMatchObject({ connected: true, prs: [], failedRepos: [{ owner: 'team', repo: 'unavailable' }] });
  });

  it('fails canonical search when every matching pull request enrichment fails', async () => {
    const account = await auth.setGitHubAuth({ accessToken: 'token-one', user: { id: 7, login: 'first' } });
    vi.stubGlobal('fetch', vi.fn(async (url) => {
      const pathname = new URL(url).pathname;
      if (pathname === '/search/issues') {
        return Response.json({ total_count: 1, items: [{ number: 5, repository_url: 'https://api.github.com/repos/team/project' }] });
      }
      return Response.json({ message: 'unavailable' }, { status: 503 });
    }));

    await request(makeApp({
      resolveGitHubRepoFromDirectory: vi.fn(async () => ({ repo: { owner: 'team', repo: 'project' } })),
      resolveRepoNetwork: vi.fn(async () => null),
    })).get('/api/source-control/github/pulls/list').query({
      directory,
      query: 'feature',
      repositoryId: 'repo_one',
      bindingRevision: 3,
      accountId: account.accountId,
      primaryRemote: 'origin',
      instance: 'github.com',
    }).expect(500);
  });

  it('isolates canonical pull context caches by binding authority', async () => {
    const account = await auth.setGitHubAuth({ accessToken: 'token-one', user: { id: 7, login: 'first' } });
    const pullReads = [];
    const fetch = vi.fn(async (url) => {
      const pathname = new URL(url).pathname;
      if (pathname === '/repos/team/project/pulls/5') {
        pullReads.push(pathname);
        return Response.json({
          number: 5, title: 'Change', html_url: 'https://github.com/team/project/pull/5', state: 'open',
          head: { ref: 'feature', sha: 'abc' }, base: { ref: 'main' }, user: { id: 7, login: 'first' },
        });
      }
      if (pathname.endsWith('/check-runs')) {
        return Response.json({ check_runs: [{ id: 1, name: 'test', status: 'completed', conclusion: 'success' }] });
      }
      return Response.json([]);
    });
    vi.stubGlobal('fetch', fetch);
    const resolveGitHubRepoFromDirectory = vi.fn(async () => ({ repo: { owner: 'team', repo: 'project' } }));
    const app = makeApp({ resolveGitHubRepoFromDirectory, resolveRepoNetwork: vi.fn(async () => null) });
    const query = {
      directory,
      number: 5,
      repositoryId: 'repo_one',
      bindingRevision: 1,
      accountId: account.accountId,
      primaryRemote: 'upstream',
      instance: 'github.com',
    };

    await request(app).get('/api/source-control/github/pulls/context').query(query).expect(200);
    await request(app).get('/api/source-control/github/pulls/context')
      .query({ ...query, repositoryId: 'repo_two', bindingRevision: 2 }).expect(200);
    await request(app).get('/api/source-control/github/pulls/context')
      .query({ ...query, repositoryId: 'repo_two', bindingRevision: 2 }).expect(200);

    expect(pullReads).toHaveLength(2);
    expect(resolveGitHubRepoFromDirectory).toHaveBeenCalledWith(directory, 'upstream');
  });

  it('does not fabricate empty CI from malformed canonical check payloads', async () => {
    const account = await auth.setGitHubAuth({ accessToken: 'token-one', user: { id: 7, login: 'first' } });
    vi.stubGlobal('fetch', vi.fn(async (url) => {
      const pathname = new URL(url).pathname;
      if (pathname === '/repos/team/project/pulls/5') {
        return Response.json({
          number: 5, title: 'Change', html_url: 'https://github.com/team/project/pull/5', state: 'open',
          head: { ref: 'feature', sha: 'abc' }, base: { ref: 'main' }, user: { id: 7, login: 'first' },
        });
      }
      if (pathname.endsWith('/check-runs')) return Response.json({ check_runs: [{}] });
      if (pathname.endsWith('/status/abc')) return Response.json({ statuses: [{}] });
      return Response.json([]);
    }));

    const response = await request(makeApp({
      resolveGitHubRepoFromDirectory: vi.fn(async () => ({ repo: { owner: 'team', repo: 'project' } })),
    })).get('/api/source-control/github/pulls/context')
      .query(boundQuery(account.accountId, { number: 5 })).expect(200);

    expect(response.body.checks).toBeNull();
    expect(response.body).not.toHaveProperty('checkRuns');
  });

  it.each([
    ['pull list top-level', '/api/source-control/github/pulls/list', {}, { malformed: true }],
    ['pull list primary', '/api/source-control/github/pulls/list', {}, [{ owner: 'upstream', repo: 'project', source: 'upstream' }]],
    ['pull context top-level', '/api/source-control/github/pulls/context', { number: 5 }, { malformed: true }],
    ['pull context primary', '/api/source-control/github/pulls/context', { number: 5 }, [{ owner: 'upstream', repo: 'project', source: 'upstream' }]],
  ])('rejects malformed canonical fork metadata for %s', async (_label, route, extra, network) => {
    const account = await auth.setGitHubAuth({ accessToken: 'token-one', user: { id: 7, login: 'first' } });
    const fetch = vi.fn();
    vi.stubGlobal('fetch', fetch);

    await request(makeApp({
      resolveGitHubRepoFromDirectory: vi.fn(async () => ({ repo: { owner: 'team', repo: 'project' } })),
      resolveRepoNetwork: vi.fn(async () => network),
    })).get(route).query(boundQuery(account.accountId, extra)).expect(500);

    expect(fetch).not.toHaveBeenCalled();
  });

  it.each([
    ['top-level pull list', { items: [] }],
    ['pull-list item', [{ number: 5, title: 'Missing URL', state: 'open' }]],
  ])('rejects malformed canonical %s', async (_label, payload) => {
    const account = await auth.setGitHubAuth({ accessToken: 'token-one', user: { id: 7, login: 'first' } });
    vi.stubGlobal('fetch', vi.fn(async () => Response.json(payload)));

    await request(makeApp({
      resolveGitHubRepoFromDirectory: vi.fn(async () => ({ repo: { owner: 'team', repo: 'project' } })),
      resolveRepoNetwork: vi.fn(async () => null),
    })).get('/api/source-control/github/pulls/list').query(boundQuery(account.accountId)).expect(500);
  });

  it.each([
    ['top-level search result', []],
    ['top-level search collection', { total_count: 1, items: {} }],
    ['search item', { total_count: 1, items: [{ repository_url: 'https://api.github.com/repos/team/project' }] }],
    ['search repository metadata', { total_count: 1, items: [{ number: 5, repository_url: 'not-a-repo' }] }],
  ])('rejects malformed canonical pull %s', async (_label, payload) => {
    const account = await auth.setGitHubAuth({ accessToken: 'token-one', user: { id: 7, login: 'first' } });
    vi.stubGlobal('fetch', vi.fn(async () => Response.json(payload)));

    await request(makeApp({
      resolveGitHubRepoFromDirectory: vi.fn(async () => ({ repo: { owner: 'team', repo: 'project' } })),
      resolveRepoNetwork: vi.fn(async () => null),
    })).get('/api/source-control/github/pulls/list')
      .query(boundQuery(account.accountId, { query: 'feature' })).expect(500);
  });

  it('fails a canonical pull list when the trusted primary repo fails but an upstream succeeds', async () => {
    const account = await auth.setGitHubAuth({ accessToken: 'token-one', user: { id: 7, login: 'first' } });
    vi.stubGlobal('fetch', vi.fn(async (url) => new URL(url).pathname === '/repos/team/project/pulls'
      ? Response.json({ message: 'unavailable' }, { status: 503 })
      : Response.json([])));

    await request(makeApp({
      resolveGitHubRepoFromDirectory: vi.fn(async () => ({ repo: { owner: 'team', repo: 'project' } })),
      resolveRepoNetwork: vi.fn(async () => [
        { owner: 'team', repo: 'project', source: 'origin' },
        { owner: 'upstream', repo: 'project', source: 'upstream' },
      ]),
    })).get('/api/source-control/github/pulls/list').query(boundQuery(account.accountId)).expect(500);
  });

  it('fails canonical pull search when primary enrichment fails but upstream enrichment succeeds', async () => {
    const account = await auth.setGitHubAuth({ accessToken: 'token-one', user: { id: 7, login: 'first' } });
    vi.stubGlobal('fetch', vi.fn(async (url) => {
      const pathname = new URL(url).pathname;
      if (pathname === '/search/issues') {
        return Response.json({
          total_count: 2,
          items: [
            { number: 5, repository_url: 'https://api.github.com/repos/team/project' },
            { number: 6, repository_url: 'https://api.github.com/repos/upstream/project' },
          ],
        });
      }
      if (pathname === '/repos/team/project/pulls/5') return Response.json({ message: 'unavailable' }, { status: 503 });
      return Response.json({
        number: 6, title: 'Change', html_url: 'https://github.com/upstream/project/pull/6', state: 'open',
        head: { ref: 'feature' }, base: { ref: 'main' },
      });
    }));

    await request(makeApp({
      resolveGitHubRepoFromDirectory: vi.fn(async () => ({ repo: { owner: 'team', repo: 'project' } })),
      resolveRepoNetwork: vi.fn(async () => [
        { owner: 'team', repo: 'project', source: 'origin' },
        { owner: 'upstream', repo: 'project', source: 'upstream' },
      ]),
    })).get('/api/source-control/github/pulls/list')
      .query(boundQuery(account.accountId, { query: 'feature' })).expect(500);
  });

  it.each([
    ['pull request', '/repos/team/project/pulls/5', { number: 5, state: 'open' }],
    ['top-level issue comments', '/repos/team/project/issues/5/comments', { comments: [] }],
    ['issue comment', '/repos/team/project/issues/5/comments', [{ id: 1, body: 'missing URL' }]],
    ['top-level review comments', '/repos/team/project/pulls/5/comments', { comments: [] }],
    ['review comment', '/repos/team/project/pulls/5/comments', [{ id: 1, html_url: 'https://github.com/comment/1', body: 'missing path' }]],
    ['top-level files', '/repos/team/project/pulls/5/files', { files: [] }],
    ['file', '/repos/team/project/pulls/5/files', [{ filename: 'a.ts', status: 'modified' }]],
  ])('rejects malformed canonical pull-context %s payload', async (_label, malformedPath, malformedPayload) => {
    const account = await auth.setGitHubAuth({ accessToken: 'token-one', user: { id: 7, login: 'first' } });
    const validPR = {
      number: 5, title: 'Change', html_url: 'https://github.com/team/project/pull/5', state: 'open',
      head: { ref: 'feature' }, base: { ref: 'main' },
    };
    vi.stubGlobal('fetch', vi.fn(async (url) => {
      const pathname = new URL(url).pathname;
      if (pathname === malformedPath) return Response.json(malformedPayload);
      if (pathname === '/repos/team/project/pulls/5') return Response.json(validPR);
      if (pathname === '/repos/team/project/issues/5/comments') return Response.json([]);
      if (pathname === '/repos/team/project/pulls/5/comments') return Response.json([]);
      if (pathname === '/repos/team/project/pulls/5/files') return Response.json([]);
      return Response.json({ statuses: [] });
    }));

    await request(makeApp({
      resolveGitHubRepoFromDirectory: vi.fn(async () => ({ repo: { owner: 'team', repo: 'project' } })),
      resolveRepoNetwork: vi.fn(async () => null),
    })).get('/api/source-control/github/pulls/context')
      .query(boundQuery(account.accountId, { number: 5 })).expect(500);
  });

  it('rejects a canonical pull head repository URL outside GitHub', async () => {
    const account = await auth.setGitHubAuth({ accessToken: 'token-one', user: { id: 7, login: 'first' } });
    vi.stubGlobal('fetch', vi.fn(async (url) => {
      const pathname = new URL(url).pathname;
      if (pathname === '/repos/team/project/pulls/5') {
        return Response.json({
          number: 5,
          title: 'Change',
          html_url: 'https://github.com/team/project/pull/5',
          state: 'open',
          head: {
            ref: 'feature',
            sha: 'abc',
            repo: {
              owner: { login: 'contributor' },
              name: 'project',
              html_url: 'https://github.com/contributor/project',
              clone_url: 'https://127.0.0.1/internal.git',
            },
          },
          base: { ref: 'main' },
          user: { id: 7, login: 'first' },
        });
      }
      return Response.json([]);
    }));

    await request(makeApp({
      resolveGitHubRepoFromDirectory: vi.fn(async () => ({ repo: { owner: 'team', repo: 'project' } })),
      resolveRepoNetwork: vi.fn(async () => null),
    })).get('/api/source-control/github/pulls/context')
      .query(boundQuery(account.accountId, { number: 5 })).expect(500);
  });

  it('retires malformed legacy pull collection requests', async () => {
    await auth.setGitHubAuth({ accessToken: 'token-one', user: { id: 7, login: 'first' } });
    vi.stubGlobal('fetch', vi.fn(async () => Response.json({ malformed: true })));
    const app = makeApp({
      resolveGitHubRepoFromDirectory: vi.fn(async () => ({ repo: { owner: 'team', repo: 'project' } })),
      resolveRepoNetwork: vi.fn(async () => null),
    });

    await expect(request(app).get('/api/github/pulls/list').query({ directory }))
      .resolves.toMatchObject({ status: 410, body: { code: 'SOURCE_CONTROL_CONTEXT_REQUIRED' } });
    await expect(request(app).get('/api/github/pulls/context').query({ directory, number: 5 }))
      .resolves.toMatchObject({ status: 410, body: { code: 'SOURCE_CONTROL_CONTEXT_REQUIRED' } });
  });

  it('keeps malformed workflow-job detail non-authoritative', async () => {
    const account = await auth.setGitHubAuth({ accessToken: 'token-one', user: { id: 7, login: 'first' } });
    const detailsUrl = 'https://github.com/team/project/actions/runs/10/job/11';
    vi.stubGlobal('fetch', vi.fn(async (url) => {
      const pathname = new URL(url).pathname;
      if (pathname === '/repos/team/project/pulls/5') {
        return Response.json({
          number: 5, title: 'Change', html_url: 'https://github.com/team/project/pull/5', state: 'open',
          head: { ref: 'feature', sha: 'abc' }, base: { ref: 'main' }, user: { id: 7, login: 'first' },
        });
      }
      if (pathname.endsWith('/check-runs')) {
        return Response.json({ check_runs: [{ id: 12, name: 'test', status: 'completed', conclusion: 'success', details_url: detailsUrl }] });
      }
      if (pathname.endsWith('/actions/runs/10/jobs')) return Response.json({ jobs: [{ name: 'test' }] });
      return Response.json([]);
    }));

    const response = await request(makeApp({
      resolveGitHubRepoFromDirectory: vi.fn(async () => ({ repo: { owner: 'team', repo: 'project' } })),
    })).get('/api/source-control/github/pulls/context')
      .query(boundQuery(account.accountId, { number: 5, checkDetails: '1' })).expect(200);

    expect(response.body.checks).toMatchObject({ state: 'success', total: 1 });
    expect(response.body.checkRuns[0].job).toEqual({ runId: 10, jobId: 11, url: detailsUrl });
  });

  it('constrains canonical pull context selectors to the bound fork network', async () => {
    const account = await auth.setGitHubAuth({ accessToken: 'token-one', user: { id: 7, login: 'first' } });
    const fetch = vi.fn();
    vi.stubGlobal('fetch', fetch);
    const resolveRepoNetwork = vi.fn(async () => [
      { owner: 'team', repo: 'project', source: 'origin' },
      { owner: 'upstream', repo: 'project', source: 'upstream' },
    ]);
    const app = makeApp({
      resolveGitHubRepoFromDirectory: vi.fn(async () => ({ repo: { owner: 'team', repo: 'project' } })),
      resolveRepoNetwork,
    });

    const response = await request(app).get('/api/source-control/github/pulls/context').query({
      directory,
      number: 5,
      owner: 'other',
      repo: 'secret',
      repositoryId: 'repo_one',
      bindingRevision: 1,
      accountId: account.accountId,
      primaryRemote: 'upstream',
      instance: 'github.com',
    }).expect(200);

    expect(response.body).toMatchObject({ connected: true, repo: null, pr: null });
    expect(resolveRepoNetwork).toHaveBeenCalledWith(expect.anything(), directory, 'upstream', { strictErrors: true });
    expect(fetch).not.toHaveBeenCalled();
  });

  it('does not retarget an existing credential after the same provider user authenticates again', async () => {
    const account = await auth.setGitHubAuth({ accessToken: 'token-one', user: { id: 7, login: 'first' } });
    const app = makeApp();
    const query = { directory, branch: 'feature', accountId: account.accountId };
    const initial = await request(app).get('/api/source-control/github/pr/status').query(query).expect(200);

    const replacement = await auth.setGitHubAuth({ accessToken: 'token-two', user: { id: 7, login: 'first' } });
    const nextFetchedAt = initial.body.fetchedAt + 1_000;
    vi.spyOn(Date, 'now').mockReturnValue(nextFetchedAt);
    const retained = await request(app).get('/api/source-control/github/pr/status').query(query).expect(200);
    const replacementRead = await request(app).get('/api/source-control/github/pr/status')
      .query({ ...query, accountId: replacement.accountId }).expect(200);

    expect(replacement.accountId).not.toBe(account.accountId);
    expect(retained.body.fetchedAt).toBe(initial.body.fetchedAt);
    expect(replacementRead.body.fetchedAt).toBe(nextFetchedAt);
  });

  it('derives opaque cache namespaces from both account and credential', async () => {
    const { createOctokit, getOctokitCacheIdentity } = await import('./octokit.js');
    const first = getOctokitCacheIdentity(createOctokit('raw-token-one', 'github.com#7'));
    const otherAccount = getOctokitCacheIdentity(createOctokit('raw-token-one', 'github.com#8'));
    const rotatedCredential = getOctokitCacheIdentity(createOctokit('raw-token-two', 'github.com#7'));

    expect(new Set([first, otherAccount, rotatedCredential]).size).toBe(3);
    expect(`${first}${otherAccount}${rotatedCredential}`).not.toContain('raw-token');
  });

  it('invalidates and reconciles only the account rejected with 401', async () => {
    const first = await auth.setGitHubAuth({ accessToken: 'token-one', user: { id: 7, login: 'first' } });
    const second = await auth.setGitHubAuth({ accessToken: 'token-two', user: { id: 8, login: 'current' } });
    const onAccountInvalidated = vi.fn();
    vi.stubGlobal('fetch', vi.fn(async () => Response.json({ message: 'Bad credentials' }, { status: 401 })));

    await request(makeApp({
      onAccountInvalidated,
      resolveGitHubRepoFromDirectory: vi.fn(async () => ({ repo: { owner: 'owner', repo: 'repo' } })),
    })).get('/api/source-control/github/repo/branches')
      .query(boundQuery(first.accountId, { owner: 'owner', repo: 'repo' })).expect(401);

    expect(onAccountInvalidated).toHaveBeenCalledWith({ provider: 'github', instance: 'github.com', accountId: first.accountId });
    expect(await auth.getGitHubAuthByAccountId(first.accountId)).toBeNull();
    expect(await auth.getGitHubAuthByAccountId(second.accountId)).toMatchObject({ accessToken: 'token-two' });
    expect(await auth.getGitHubAuthAccounts()).toEqual([
      expect.objectContaining({ id: first.accountId, status: 'invalid' }),
      expect.objectContaining({ id: second.accountId, status: 'valid' }),
    ]);
  });

  it('keeps the exact account valid after a network failure', async () => {
    const account = await auth.setGitHubAuth({ accessToken: 'token-one', user: { id: 7, login: 'first' } });
    const onAccountInvalidated = vi.fn();
    vi.stubGlobal('fetch', vi.fn(async () => { throw Object.assign(new Error('offline'), { code: 'ENOTFOUND' }); }));

    await request(makeApp({
      onAccountInvalidated,
      resolveGitHubRepoFromDirectory: vi.fn(async () => ({ repo: { owner: 'owner', repo: 'repo' } })),
    })).get('/api/source-control/github/repo/branches')
      .query(boundQuery(account.accountId, { owner: 'owner', repo: 'repo' })).expect(500);

    expect(onAccountInvalidated).not.toHaveBeenCalled();
    expect(await auth.getGitHubAuthByAccountId(account.accountId)).toMatchObject({ accessToken: 'token-one' });
  });

  it('validates every canonical issue and repository read before auth or repository work', async () => {
    const account = await auth.setGitHubAuth({ accessToken: 'token-one', user: { id: 7, login: 'first' } });
    const failure = Object.assign(new Error('binding changed'), { code: 'SOURCE_CONTROL_BINDING_STALE', status: 409 });
    const validateReadContext = vi.fn(async () => { throw failure; });
    const getAccount = vi.spyOn(auth, 'getGitHubAuthByAccountId');
    const resolveGitHubRepoFromDirectory = vi.fn();
    const resolveRepoNetwork = vi.fn();
    const fetch = vi.fn();
    vi.stubGlobal('fetch', fetch);
    const app = makeApp({ validateReadContext, resolveGitHubRepoFromDirectory, resolveRepoNetwork });
    const query = boundQuery(account.accountId);

    const reads = [
      ['/api/source-control/github/issues/list', query],
      ['/api/source-control/github/issues/get', { ...query, number: 3 }],
      ['/api/source-control/github/issues/comments', { ...query, number: 3 }],
      ['/api/source-control/github/repo/upstream', query],
      ['/api/source-control/github/repo/branches', { ...query, owner: 'team', repo: 'project' }],
    ];
    for (const [route, routeQuery] of reads) {
      const response = await request(app).get(route).query(routeQuery).expect(409);
      expect(response.body.code).toBe('SOURCE_CONTROL_BINDING_STALE');
    }

    expect(validateReadContext).toHaveBeenCalledTimes(reads.length);
    expect(getAccount).not.toHaveBeenCalled();
    expect(resolveGitHubRepoFromDirectory).not.toHaveBeenCalled();
    expect(resolveRepoNetwork).not.toHaveBeenCalled();
    expect(fetch).not.toHaveBeenCalled();
  });

  it('uses the exact bound account and primary remote for issues, upstream, and branches', async () => {
    const bound = await auth.setGitHubAuth({ accessToken: 'bound-token', user: { id: 7, login: 'bound' } });
    await auth.setGitHubAuth({ accessToken: 'active-token', user: { id: 8, login: 'active' } });
    const fetch = vi.fn(async () => Response.json([]));
    vi.stubGlobal('fetch', fetch);
    const resolveGitHubRepoFromDirectory = vi.fn(async () => ({ repo: { owner: 'team', repo: 'project' } }));
    const resolveRepoNetwork = vi.fn(async () => null);
    const app = makeApp({ resolveGitHubRepoFromDirectory, resolveRepoNetwork });
    const query = boundQuery(bound.accountId, { primaryRemote: 'upstream' });

    await request(app).get('/api/source-control/github/issues/list').query(query).expect(200);
    await request(app).get('/api/source-control/github/repo/upstream').query(query).expect(200);
    await request(app).get('/api/source-control/github/repo/branches')
      .query({ ...query, owner: 'team', repo: 'project' }).expect(200);

    expect(resolveGitHubRepoFromDirectory).toHaveBeenCalledWith(directory, 'upstream');
    expect(resolveRepoNetwork).toHaveBeenCalledWith(expect.anything(), directory, 'upstream', { strictErrors: true });
    expect(fetch.mock.calls.some(([, init]) => init.headers.authorization === 'token bound-token')).toBe(true);
    expect(fetch.mock.calls.every(([, init]) => init.headers.authorization !== 'token active-token')).toBe(true);
  });

  it.each([
    ['metadata forbidden', async () => Response.json({ message: 'forbidden' }, { status: 403 })],
    ['default-branch ref rate limited', async (url) => new URL(url).pathname.includes('/git/ref/')
      ? Response.json({ message: 'rate limited' }, { status: 403, headers: { 'x-ratelimit-remaining': '0' } })
      : Response.json({ default_branch: 'main' })],
    ['metadata network failure', async () => { throw Object.assign(new Error('offline'), { code: 'ENOTFOUND' }); }],
  ])('propagates canonical upstream %s', async (_label, fetchImpl) => {
    const account = await auth.setGitHubAuth({ accessToken: 'token-one', user: { id: 7, login: 'first' } });
    vi.stubGlobal('fetch', vi.fn(fetchImpl));
    const app = makeApp({
      resolveGitHubRepoFromDirectory: vi.fn(async () => ({ repo: { owner: 'team', repo: 'project' } })),
      resolveRepoNetwork: vi.fn(async () => [
        { owner: 'team', repo: 'project', source: 'origin' },
        { owner: 'upstream', repo: 'project', source: 'upstream', url: 'https://github.com/upstream/project' },
      ]),
    });

    await request(app).get('/api/source-control/github/repo/upstream')
      .query(boundQuery(account.accountId)).expect(500);
  });

  it('retires legacy upstream metadata fallback behavior', async () => {
    await auth.setGitHubAuth({ accessToken: 'token-one', user: { id: 7, login: 'first' } });
    vi.stubGlobal('fetch', vi.fn(async () => Response.json({ message: 'unavailable' }, { status: 503 })));
    const response = await request(makeApp({
      resolveRepoNetwork: vi.fn(async () => [
        { owner: 'team', repo: 'project', source: 'origin' },
        { owner: 'upstream', repo: 'project', source: 'upstream', url: 'https://github.com/upstream/project' },
      ]),
    })).get('/api/github/repo/upstream').query({ directory }).expect(410);

    expect(response.body.code).toBe('SOURCE_CONTROL_CONTEXT_REQUIRED');
  });

  it('constrains canonical issue and branch selectors to the bound fork network', async () => {
    const account = await auth.setGitHubAuth({ accessToken: 'token-one', user: { id: 7, login: 'first' } });
    const fetch = vi.fn();
    vi.stubGlobal('fetch', fetch);
    const resolveRepoNetwork = vi.fn(async () => [
      { owner: 'team', repo: 'project', source: 'origin' },
      { owner: 'upstream', repo: 'project', source: 'upstream' },
    ]);
    const app = makeApp({
      resolveGitHubRepoFromDirectory: vi.fn(async () => ({ repo: { owner: 'team', repo: 'project' } })),
      resolveRepoNetwork,
    });
    const query = boundQuery(account.accountId, { owner: 'other', repo: 'secret' });

    const issue = await request(app).get('/api/source-control/github/issues/get')
      .query({ ...query, number: 3 }).expect(200);
    const comments = await request(app).get('/api/source-control/github/issues/comments')
      .query({ ...query, number: 3 }).expect(200);
    const branches = await request(app).get('/api/source-control/github/repo/branches')
      .query(query).expect(200);

    expect(issue.body).toMatchObject({ connected: true, repo: null, issue: null });
    expect(comments.body).toMatchObject({ connected: true, repo: null, comments: [] });
    expect(branches.body).toEqual({ branches: [] });
    expect(resolveRepoNetwork).toHaveBeenCalledWith(expect.anything(), directory, 'origin', { strictErrors: true });
    expect(fetch).not.toHaveBeenCalled();
  });

  it('fails canonical selector reads when fork-network resolution fails', async () => {
    const account = await auth.setGitHubAuth({ accessToken: 'token-one', user: { id: 7, login: 'first' } });
    const resolveRepoNetwork = vi.fn(async () => { throw Object.assign(new Error('network unavailable'), { code: 'ENOTFOUND' }); });
    const app = makeApp({
      resolveGitHubRepoFromDirectory: vi.fn(async () => ({ repo: { owner: 'team', repo: 'project' } })),
      resolveRepoNetwork,
    });

    await request(app).get('/api/source-control/github/issues/get')
      .query(boundQuery(account.accountId, { number: 3, owner: 'upstream', repo: 'project' })).expect(500);
    await request(app).get('/api/source-control/github/repo/branches')
      .query(boundQuery(account.accountId, { owner: 'upstream', repo: 'project' })).expect(500);
  });

  it('returns successful canonical issue repositories with failed selectors', async () => {
    const account = await auth.setGitHubAuth({ accessToken: 'token-one', user: { id: 7, login: 'first' } });
    vi.stubGlobal('fetch', vi.fn(async (url) => {
      if (new URL(url).pathname === '/repos/team/good/issues') {
        return Response.json([{ number: 3, title: 'Issue', html_url: 'https://github.com/team/good/issues/3', state: 'open' }]);
      }
      return Response.json({ message: 'unavailable' }, { status: 503 });
    }));
    const response = await request(makeApp({
      resolveGitHubRepoFromDirectory: vi.fn(async () => ({ repo: { owner: 'team', repo: 'good' } })),
      resolveRepoNetwork: vi.fn(async () => [
        { owner: 'team', repo: 'good', source: 'origin' },
        { owner: 'team', repo: 'bad', source: 'upstream' },
      ]),
    })).get('/api/source-control/github/issues/list')
      .query(boundQuery(account.accountId)).expect(200);

    expect(response.body.issues).toHaveLength(1);
    expect(response.body.failedRepos).toEqual([{ owner: 'team', repo: 'bad' }]);
  });

  it('rejects canonical issue lists when every repository fails', async () => {
    const account = await auth.setGitHubAuth({ accessToken: 'token-one', user: { id: 7, login: 'first' } });
    vi.stubGlobal('fetch', vi.fn(async () => Response.json({ message: 'unavailable' }, { status: 503 })));

    await request(makeApp({
      resolveGitHubRepoFromDirectory: vi.fn(async () => ({ repo: { owner: 'team', repo: 'project' } })),
      resolveRepoNetwork: vi.fn(async () => null),
    })).get('/api/source-control/github/issues/list')
      .query(boundQuery(account.accountId)).expect(500);
  });

  it('rejects canonical issue search failures and all-failed enrichment', async () => {
    const account = await auth.setGitHubAuth({ accessToken: 'token-one', user: { id: 7, login: 'first' } });
    const routeOptions = {
      resolveGitHubRepoFromDirectory: vi.fn(async () => ({ repo: { owner: 'team', repo: 'project' } })),
      resolveRepoNetwork: vi.fn(async () => null),
    };
    vi.stubGlobal('fetch', vi.fn(async () => Response.json({ message: 'search unavailable' }, { status: 503 })));
    await request(makeApp(routeOptions)).get('/api/source-control/github/issues/list')
      .query(boundQuery(account.accountId, { query: 'bug' })).expect(500);

    vi.stubGlobal('fetch', vi.fn(async (url) => {
      if (new URL(url).pathname === '/search/issues') {
        return Response.json({ total_count: 1, items: [{ number: 3, repository_url: 'https://api.github.com/repos/team/project' }] });
      }
      return Response.json({ message: 'detail unavailable' }, { status: 503 });
    }));
    await request(makeApp(routeOptions)).get('/api/source-control/github/issues/list')
      .query(boundQuery(account.accountId, { query: 'bug' })).expect(500);
  });

  it.each([
    undefined,
    'not a URL',
    'https://api.github.com/repos/outside/project',
  ])('rejects canonical issue search repository URL %s without querying a fallback repo', async (repositoryUrl) => {
    const account = await auth.setGitHubAuth({ accessToken: 'token-one', user: { id: 7, login: 'first' } });
    const fetch = vi.fn(async (url) => {
      if (new URL(url).pathname === '/search/issues') {
        return Response.json({ total_count: 1, items: [{ number: 3, repository_url: repositoryUrl }] });
      }
      throw new Error(`Unexpected fallback request: ${url}`);
    });
    vi.stubGlobal('fetch', fetch);

    await request(makeApp({
      resolveGitHubRepoFromDirectory: vi.fn(async () => ({ repo: { owner: 'team', repo: 'project' } })),
      resolveRepoNetwork: vi.fn(async () => [{ owner: 'team', repo: 'project', source: 'origin' }]),
    })).get('/api/source-control/github/issues/list')
      .query(boundQuery(account.accountId, { query: 'bug' })).expect(500);

    expect(fetch).toHaveBeenCalledTimes(1);
  });

  it('rejects invalid canonical issue selectors before binding or provider work', async () => {
    const validateReadContext = vi.fn();
    const resolveGitHubRepoFromDirectory = vi.fn();
    const fetch = vi.fn();
    vi.stubGlobal('fetch', fetch);
    const app = makeApp({ validateReadContext, resolveGitHubRepoFromDirectory });
    const invalidSelectors = [
      { number: '3junk' },
      { number: '3.5' },
      { number: '3', owner: 'team' },
      { number: '3', repo: 'project' },
    ];

    for (const suffix of ['get', 'comments']) {
      for (const selector of invalidSelectors) {
        await request(app).get(`/api/source-control/github/issues/${suffix}`)
          .query({ directory, ...selector }).expect(400);
      }
    }
    await request(app).get('/api/source-control/github/repo/branches')
      .query({ directory, owner: 'team' }).expect(400);
    await request(app).get('/api/source-control/github/pulls/context')
      .query({ directory, number: 3, repo: 'project' }).expect(400);

    expect(validateReadContext).not.toHaveBeenCalled();
    expect(resolveGitHubRepoFromDirectory).not.toHaveBeenCalled();
    expect(fetch).not.toHaveBeenCalled();
  });

  it('does not invalidate a bound account on GitHub 403 responses', async () => {
    const account = await auth.setGitHubAuth({ accessToken: 'token-one', user: { id: 7, login: 'first' } });
    const onAccountInvalidated = vi.fn();
    vi.stubGlobal('fetch', vi.fn(async () => Response.json({ message: 'forbidden' }, { status: 403 })));

    await request(makeApp({
      onAccountInvalidated,
      resolveGitHubRepoFromDirectory: vi.fn(async () => ({ repo: { owner: 'team', repo: 'project' } })),
    })).get('/api/source-control/github/repo/branches')
      .query(boundQuery(account.accountId, { owner: 'team', repo: 'project' })).expect(500);

    expect(onAccountInvalidated).not.toHaveBeenCalled();
    expect(await auth.getGitHubAuthByAccountId(account.accountId)).toMatchObject({ accessToken: 'token-one' });
  });

  it.each([
    ['top-level branch list', '/api/source-control/github/repo/branches', { owner: 'team', repo: 'project' }, { branches: [] }],
    ['branch item', '/api/source-control/github/repo/branches', { owner: 'team', repo: 'project' }, [{ name: null }]],
    ['top-level issue list', '/api/source-control/github/issues/list', {}, { items: [] }],
    ['issue-list item', '/api/source-control/github/issues/list', {}, [{ number: 3, state: 'open' }]],
    ['top-level comment list', '/api/source-control/github/issues/comments', { number: 3 }, { comments: [] }],
    ['comment item', '/api/source-control/github/issues/comments', { number: 3 }, [{ id: 4, body: 'Missing URL' }]],
  ])('rejects malformed canonical %s payloads', async (_label, route, extra, payload) => {
    const account = await auth.setGitHubAuth({ accessToken: 'token-one', user: { id: 7, login: 'first' } });
    vi.stubGlobal('fetch', vi.fn(async () => Response.json(payload)));
    const app = makeApp({
      resolveGitHubRepoFromDirectory: vi.fn(async () => ({ repo: { owner: 'team', repo: 'project' } })),
      resolveRepoNetwork: vi.fn(async () => null),
    });

    await request(app).get(route).query(boundQuery(account.accountId, extra)).expect(500);
  });

  it.each([
    null,
    { number: 3, title: 'Missing URL', state: 'open' },
  ])('rejects malformed canonical issue-detail payload %s', async (payload) => {
    const account = await auth.setGitHubAuth({ accessToken: 'token-one', user: { id: 7, login: 'first' } });
    vi.stubGlobal('fetch', vi.fn(async () => Response.json(payload)));

    await request(makeApp({
      resolveGitHubRepoFromDirectory: vi.fn(async () => ({ repo: { owner: 'team', repo: 'project' } })),
    })).get('/api/source-control/github/issues/get')
      .query(boundQuery(account.accountId, { number: 3 })).expect(500);
  });

  it.each([
    { malformed: true },
    [{ owner: 'team', source: 'origin' }],
  ])('rejects malformed canonical fork metadata %s', async (network) => {
    const account = await auth.setGitHubAuth({ accessToken: 'token-one', user: { id: 7, login: 'first' } });

    await request(makeApp({
      resolveGitHubRepoFromDirectory: vi.fn(async () => ({ repo: { owner: 'team', repo: 'project' } })),
      resolveRepoNetwork: vi.fn(async () => network),
    })).get('/api/source-control/github/repo/upstream')
      .query(boundQuery(account.accountId)).expect(500);
  });

  it('retires malformed legacy collection requests', async () => {
    await auth.setGitHubAuth({ accessToken: 'token-one', user: { id: 7, login: 'first' } });
    vi.stubGlobal('fetch', vi.fn(async () => Response.json({ malformed: true })));
    const app = makeApp({
      resolveGitHubRepoFromDirectory: vi.fn(async () => ({ repo: { owner: 'team', repo: 'project' } })),
      resolveRepoNetwork: vi.fn(async () => null),
    });

    await expect(request(app).get('/api/github/repo/branches').query({ directory, owner: 'team', repo: 'project' }))
      .resolves.toMatchObject({ status: 410, body: { code: 'SOURCE_CONTROL_CONTEXT_REQUIRED' } });
    await expect(request(app).get('/api/github/issues/list').query({ directory }))
      .resolves.toMatchObject({ status: 410, body: { code: 'SOURCE_CONTROL_CONTEXT_REQUIRED' } });
    await expect(request(app).get('/api/github/issues/comments').query({ directory, number: 3 }))
      .resolves.toMatchObject({ status: 410, body: { code: 'SOURCE_CONTROL_CONTEXT_REQUIRED' } });
  });

  it('retires legacy issue reads without ambient account or repository work', async () => {
    const nonActive = await auth.setGitHubAuth({ accessToken: 'old-token', user: { id: 7, login: 'old' } });
    await auth.setGitHubAuth({ accessToken: 'active-token', user: { id: 8, login: 'active' } });
    const fetch = vi.fn(async () => Response.json({ message: 'unavailable' }, { status: 503 }));
    vi.stubGlobal('fetch', fetch);
    const validateReadContext = vi.fn();
    const resolveGitHubRepoFromDirectory = vi.fn(async () => ({ repo: { owner: 'team', repo: 'project' } }));
    const resolveRepoNetwork = vi.fn(async () => null);

    const response = await request(makeApp({ validateReadContext, resolveGitHubRepoFromDirectory, resolveRepoNetwork }))
      .get('/api/github/issues/list')
      .query({ directory, accountId: nonActive.accountId })
      .expect(410);

    expect(response.body.code).toBe('SOURCE_CONTROL_CONTEXT_REQUIRED');
    expect(validateReadContext).not.toHaveBeenCalled();
    expect(resolveGitHubRepoFromDirectory).not.toHaveBeenCalled();
    expect(resolveRepoNetwork).not.toHaveBeenCalled();
    expect(fetch).not.toHaveBeenCalled();
  });

  it('reconciles an exact account before removing it', async () => {
    const account = await auth.setGitHubAuth({ accessToken: 'token-one', user: { id: 7, login: 'first' } });
    const onAccountRemoved = vi.fn();

    await request(makeApp({ onAccountRemoved })).delete('/api/source-control/github/auth')
      .query({ accountId: account.accountId }).expect(200);

    expect(onAccountRemoved).toHaveBeenCalledWith({ provider: 'github', instance: 'github.com', accountId: account.accountId });
    expect(await auth.getGitHubAuthAccounts()).toEqual([]);
  });
});
