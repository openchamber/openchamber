import fs from 'node:fs/promises';
import path from 'node:path';
import express from 'express';
import request from 'supertest';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

let directory;
let previousDataDir;
let auth;
let registerSourceControlRoutes;
let createSourceControlProviders;
let createProviderDescriptors;
let githubDescriptor;

beforeEach(async () => {
  directory = await fs.mkdtemp('/tmp/opencode/provider-fix-loop-');
  previousDataDir = process.env.OPENCHAMBER_DATA_DIR;
  process.env.OPENCHAMBER_DATA_DIR = directory;
  vi.resetModules();
  auth = await import('../github/auth.js');
  ({ registerSourceControlRoutes } = await import('./routes.js'));
  ({ createSourceControlProviders } = await import('./provider-registry.js'));
  ({ createProviderDescriptors } = await import('./provider-descriptors.js'));
  ({ githubDescriptor } = await import('../github/descriptor.js'));
});

afterEach(async () => {
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
  if (previousDataDir === undefined) delete process.env.OPENCHAMBER_DATA_DIR;
  else process.env.OPENCHAMBER_DATA_DIR = previousDataDir;
  await fs.rm(directory, { recursive: true, force: true });
});

const repository = { owner: { login: 'acme' }, name: 'app', full_name: 'acme/app',
  html_url: 'https://github.com/acme/app', default_branch: 'main', node_id: 'R_app' };
const pull = (number = 7, head = 'feature', base = 'main') => ({ number, title: `Pull ${number}`, state: 'open',
  html_url: `https://github.com/acme/app/pull/${number}`, draft: false, merged: false,
  head: { ref: head, sha: 'abc123', repo: repository }, base: { ref: base, repo: repository } });

async function setup({ validateReadContext = async (input) => input, state = 'open' } = {}) {
  const account = await auth.setGitHubAuth({ accessToken: 'bound-token', user: { id: 1, login: 'bound' } });
  await auth.setGitHubAuth({ accessToken: 'ambient-token', user: { id: 2, login: 'ambient' } });
  const context = { provider: 'github', instance: 'github.com', accountId: account.accountId, directory: '/repo',
    repositoryId: 'repo-one', bindingRevision: 3, primaryRemote: 'origin' };
  const fetch = vi.fn(async (input, init) => {
    const url = new URL(input);
    if (url.pathname === '/repos/acme/app/pulls/7') return Response.json({ ...pull(), state });
    if (url.pathname === '/repos/acme/app/issues/7/comments' && init.method === 'POST') return Response.json({ id: 11 });
    if (url.pathname === '/repos/acme/app/pulls') return Response.json(url.searchParams.get('state') === 'open'
      ? [pull(), pull(8, 'upper', 'feature')] : []);
    if (url.pathname === '/repos/acme/app/stacks') return Response.json([]);
    if (url.pathname.startsWith('/repos/acme/app/compare/')) return Response.json({ behind_by: 0, commits: [] });
    if (url.pathname === '/graphql') return Response.json({ data: {} });
    throw new Error(`Unexpected request ${url.pathname}`);
  });
  vi.stubGlobal('fetch', fetch);
  const providers = createSourceControlProviders({ descriptors: createProviderDescriptors([githubDescriptor]),
    hostServices: { github: { resolveGitHubRepoFromDirectory: async () => ({ repo: { owner: 'acme', repo: 'app' } }),
      resolveRepoNetwork: async () => null } } });
  const runtime = { create: vi.fn(async () => ({ id: 'loop-one' })),
    prepareWorker: vi.fn(async () => ({ id: 'worker-one' })), list: async () => [] };
  const validate = vi.fn(validateReadContext);
  const app = express();
  app.use(express.json());
  const service = registerSourceControlRoutes(app, { configRoot: directory, providers, prFixLoopRuntime: runtime,
    bindingService: { validateReadContext: validate, validateMutationContext: async (input) => input,
      accountConnected: async () => undefined } });
  return { app, service, runtime, context, fetch, validate };
}

describe('GitHub fix-loop provider registration', () => {
  it('creates a loop with the validated account and provider head when the ambient account differs', async () => {
    // Given the production route composition and distinct active and bound credentials.
    const driver = await setup();
    // When the user activates a loop.
    const response = await request(driver.app).post('/api/source-control/github/pr/fix-loops').query(driver.context)
      .send({ sessionId: 'host-session', owner: 'acme', repo: 'app', number: 7, config: { watch: true } }).expect(200);
    // Then the runtime receives current provider state and only validated read authority.
    expect(response.body).toEqual({ loop: { id: 'loop-one' } });
    expect(driver.runtime.create).toHaveBeenCalledExactlyOnceWith({
      sessionId: 'host-session', directory: '/repo', accountId: driver.context.accountId,
      owner: 'acme', repo: 'app', number: 7, title: 'Pull 7', url: 'https://github.com/acme/app/pull/7', branch: 'feature',
      config: { watch: true }, workerId: undefined, readContext: driver.context,
      snapshot: { state: 'open', branch: 'feature', headSha: 'abc123', headRepo: { id: 'R_app', owner: 'acme', repo: 'app' } },
    });
    expect(driver.fetch.mock.calls.map(([, init]) => init.headers.authorization)).toEqual(['token bound-token']);
  });

  it('prepares an approval worker through the same bound pull admission', async () => {
    // Given a valid open pull request and selected worker model.
    const driver = await setup();
    const model = { providerID: 'test', modelID: 'worker' };
    // When the user prepares an isolated worker.
    await request(driver.app).post('/api/source-control/github/pr/fix-loops/workers').query(driver.context)
      .send({ sessionId: 'host-session', owner: 'acme', repo: 'app', number: 7, model, name: 'Review', placeId: 'local' }).expect(202);
    // Then worker preparation receives no caller-controlled provider destination or credentials.
    expect(driver.runtime.prepareWorker).toHaveBeenCalledExactlyOnceWith({
      sessionId: 'host-session', directory: '/repo', model, name: 'Review', placeId: 'local',
    });
    expect(driver.runtime.create).not.toHaveBeenCalled();
  });

  it('rejects stale binding authority before reading GitHub or starting a worker', async () => {
    // Given a changed repository binding.
    const driver = await setup({ validateReadContext: async () => {
      throw Object.assign(new Error('Binding changed'), { code: 'SOURCE_CONTROL_BINDING_STALE', status: 409 });
    } });
    // When activation uses the old authority.
    await request(driver.app).post('/api/source-control/github/pr/fix-loops').query(driver.context)
      .send({ sessionId: 'host-session', owner: 'acme', repo: 'app', number: 7 }).expect(409);
    // Then neither the provider nor the worker is reached.
    expect(driver.fetch).not.toHaveBeenCalled();
    expect(driver.runtime.create).not.toHaveBeenCalled();
  });

  it.each(['outside', 'closed'])('refuses a loop for an %s pull target', async (condition) => {
    // Given a target outside the network or no longer open.
    const driver = await setup({ state: condition === 'closed' ? 'closed' : 'open' });
    // When the user activates it.
    await request(driver.app).post('/api/source-control/github/pr/fix-loops').query(driver.context)
      .send({ sessionId: 'host-session', owner: condition === 'outside' ? 'other' : 'acme', repo: 'app', number: 7 })
      .expect(condition === 'outside' ? 400 : 409);
    // Then no loop is created and a foreign target causes no provider request.
    expect(driver.runtime.create).not.toHaveBeenCalled();
    if (condition === 'outside') expect(driver.fetch).not.toHaveBeenCalled();
  });

  it('exposes live stack context through the source-control registration result', async () => {
    // Given the composed source-control service consumed by session knowledge.
    const driver = await setup();
    // When a followed anchor is read.
    const stack = await driver.service.readGitHubPullStack({ context: driver.context, owner: 'acme', repo: 'app', number: 7 });
    // Then the complete live chain survives the provider migration.
    expect(stack.members.map((member) => member.number)).toEqual([7, 8]);
    expect(driver.validate).toHaveBeenCalledExactlyOnceWith(driver.context);
  });

  it('publishes host review operations through the registered durable provider service', async () => {
    // Given a published receipt and the production source-control service.
    const driver = await setup();
    const input = { loop: { readContext: driver.context, owner: 'acme', repo: 'app', number: 7 },
      receipt: { commit: 'abc123', destination: { ref: 'refs/heads/feature' } },
      operation: { kind: 'comment', body: 'Fixed', idempotencyKey: 'review:one' } };
    // When a host review job executes and then replays after restart recovery.
    await driver.service.applyFixLoopReviewOperation(input);
    await driver.service.applyFixLoopReviewOperation({ ...input, replayOnly: true });
    // Then the same key posts once with the exact bound credential.
    expect(driver.fetch.mock.calls.filter(([, init]) => init.method === 'POST')).toHaveLength(1);
    expect(driver.fetch.mock.calls.every(([, init]) => init.headers.authorization === 'token bound-token')).toBe(true);
    expect(await fs.readFile(path.join(directory, 'source-control-mutations.json'), 'utf8')).not.toMatch(/bound-token|Fixed/);
  });
});
