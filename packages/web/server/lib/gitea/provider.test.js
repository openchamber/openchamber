import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import express from 'express';
import request from 'supertest';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { createMutationExecutor, digestMutationInput } from '../source-control/mutation-executor.js';
import { createSourceControlAuthStore } from '../source-control/auth-storage.js';
import { createProviderDescriptors } from '../source-control/provider-descriptors.js';
import { createSourceControlProviders } from '../source-control/provider-registry.js';
import { registerProviderRoutes } from '../source-control/provider-routes.js';
import { registerSourceControlRoutes } from '../source-control/routes.js';
import { giteaDescriptor } from './descriptor.js';
import { fakeGitea, fixtures, forkNetworkRoutes, HEAD, ORIGIN, resolveForkRemote } from './fixtures/fake-fetch.js';

const directories = [];
afterEach(async () => {
  await Promise.all(directories.splice(0).map((directory) => fs.rm(directory, { recursive: true, force: true })));
});

async function tempDirectory() {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'oc-gitea-'));
  directories.push(directory);
  return directory;
}

// No gt on PATH unless a test stands one in.
const missingGt = async () => { throw Object.assign(new Error('spawn gt ENOENT'), { code: 'ENOENT' }); };

async function setup(routes = forkNetworkRoutes(), { execFile = missingGt, readFile } = {}) {
  const gitea = fakeGitea(routes);
  const authStore = createSourceControlAuthStore({ filePath: path.join(await tempDirectory(), 'source-control-auth.json') });
  const providers = createSourceControlProviders({
    authStore,
    descriptors: createProviderDescriptors([giteaDescriptor]),
    hostServices: { gitea: { fetch: gitea.fetch, resolveRepos: resolveForkRemote, execFile, readFile } },
  });
  const events = { connected: vi.fn(), invalidated: vi.fn(), removed: vi.fn() };
  providers.events.subscribe(events);
  const impl = await providers.implementation('gitea');
  return { ...gitea, providers, impl, events, store: authStore.section('gitea') };
}

describe('Gitea provider authentication', () => {
  it('connects with a verified personal access token and reports the account', async () => {
    const { impl, events, calls } = await setup();

    await expect(impl.auth.connectToken({ instance: ORIGIN, token: 'pat-1' })).resolves.toMatchObject({ connected: true, user: { id: 1, login: 'alice' } });

    expect(calls.map((call) => call.url.pathname)).toEqual(['/api/v1/user', '/api/v1/version', '/api/forgejo/v1/version']);
    expect(calls[1].headers.authorization).toBeUndefined();
    expect(events.connected).toHaveBeenCalledWith(expect.objectContaining({
      account: expect.objectContaining({ provider: 'gitea', instance: ORIGIN }),
      credential: expect.objectContaining({ providerUserId: `${ORIGIN}#1` }),
    }));
    await expect(impl.auth.status({ instance: ORIGIN })).resolves.toMatchObject({ status: 'connected', user: { login: 'alice', provider: 'gitea' } });
  });

  it('refuses a Gitea older than 1.21 and stores nothing', async () => {
    const { impl, store } = await setup(forkNetworkRoutes({ 'GET /version': { version: '1.20.6' } }));

    await expect(impl.auth.connectToken({ instance: ORIGIN, token: 'pat-1' })).rejects.toMatchObject({
      sourceControlResponse: { status: 400, body: { code: 'UNSUPPORTED_PROVIDER_VERSION' } },
    });
    expect(await store.listInstances()).toEqual([]);
  });

  it.each([
    ['JSON null', () => Response.json(null)],
    ['HTTP 204', () => new Response(null, { status: 204 })],
  ])('refuses %s from `/version` and stores nothing even with a valid token', async (_label, response) => {
    for (const status of [null, 401, 403]) {
      const { impl, store, events } = await setup(forkNetworkRoutes({
        'GET /version': (call) => (status && !call.headers.authorization
          ? new Response('{}', { status })
          : response()),
      }));

      await expect(impl.auth.connectToken({ instance: ORIGIN, token: 'pat-1' })).rejects.toBeDefined();
      expect(await store.listInstances()).toEqual([]);
      expect(events.connected).not.toHaveBeenCalled();
    }
  });

  it('sends a Forgejo server to the Forgejo card', async () => {
    const forgejo = forkNetworkRoutes({ 'GET /version': { version: '9.0.3+gitea-1.22.0' } });
    const { impl, store } = await setup(forgejo);
    await expect(impl.auth.capabilities({ instance: ORIGIN })).resolves.toMatchObject({
      authentication: true,
      authenticationMethods: { pat: { available: true }, device: { available: false, reason: 'unsupported' }, cli: { available: false, reason: 'cli-unavailable' } },
    });

    await expect(impl.auth.connectToken({ instance: ORIGIN, token: 'pat-1' })).rejects.toMatchObject({
      sourceControlResponse: { status: 409, body: { code: 'SOURCE_CONTROL_INSTANCE_OTHER_PROVIDER', provider: 'forgejo' } },
    });
    expect(await store.listInstances()).toEqual([]);
  });

  it('sends a Forgejo that drops the suffix from `/version` to the Forgejo card', async () => {
    // Forgejo 16 answers its Gitea-compatible `/version` with its own version
    // alone; the namespace it serves beside it still names both.
    const { impl, store, calls } = await setup(forkNetworkRoutes({
      'GET /version': { version: '16.0.6' },
      'GET /forgejo/version': { version: '16.0.6+gitea-1.22.0' },
    }));

    await expect(impl.auth.connectToken({ instance: ORIGIN, token: 'pat-1' })).rejects.toMatchObject({
      sourceControlResponse: { status: 409, body: { code: 'SOURCE_CONTROL_INSTANCE_OTHER_PROVIDER', provider: 'forgejo' } },
    });
    expect(calls.map((call) => call.url.pathname)).toContain('/api/forgejo/v1/version');
    expect(await store.listInstances()).toEqual([]);
  });

  describe('an instance that refuses anonymous reads', () => {
    // `[service] REQUIRE_SIGNIN_VIEW = true`: the API answers 403 to any request without a token.
    const locked = (version) => (call) => (call.headers.authorization === 'token pat-1'
      ? { version }
      : new Response(JSON.stringify({ message: 'Only signed in user is allowed to call APIs.' }), { status: 403 }));

    it('offers the token form, then reads the version with the token at connect', async () => {
      const { impl, calls } = await setup(forkNetworkRoutes({ 'GET /version': locked(fixtures.version.version) }));
      await expect(impl.auth.capabilities({ instance: ORIGIN })).resolves.toMatchObject({
        authentication: true,
        authenticationMethods: { pat: { available: true } },
      });
      calls.length = 0;

      await expect(impl.auth.connectToken({ instance: ORIGIN, token: 'pat-1' })).resolves.toMatchObject({ connected: true, user: { login: 'alice' } });
      expect(calls.map((call) => [call.url.pathname, call.headers.authorization])).toEqual([
        ['/api/v1/user', 'token pat-1'],
        ['/api/v1/version', undefined],
        ['/api/v1/version', 'token pat-1'],
        ['/api/forgejo/v1/version', undefined],
      ]);
    });

    it('still sends a locked Forgejo to the Forgejo card', async () => {
      const { impl, store } = await setup(forkNetworkRoutes({ 'GET /version': locked('15.0.10+gitea-1.22.0') }));
      await expect(impl.auth.connectToken({ instance: ORIGIN, token: 'pat-1' })).rejects.toMatchObject({
        sourceControlResponse: { status: 409, body: { code: 'SOURCE_CONTROL_INSTANCE_OTHER_PROVIDER', provider: 'forgejo' } },
      });
      expect(await store.listInstances()).toEqual([]);
    });
  });

  it('writes an account off when Gitea refuses its token', async () => {
    let refuse = false;
    const { impl, events, store } = await setup(forkNetworkRoutes({
      'GET /user': () => (refuse ? new Response(JSON.stringify({ message: 'invalid token' }), { status: 401 }) : fixtures.user),
    }));
    await impl.auth.connectToken({ instance: ORIGIN, token: 'pat-1' });
    refuse = true;

    await expect(impl.auth.status({ instance: ORIGIN })).resolves.toMatchObject({ status: 'disconnected', connected: false });

    expect(events.invalidated).toHaveBeenCalledWith(expect.objectContaining({ provider: 'gitea', instance: ORIGIN }));
    expect((await store.listAccounts(ORIGIN))[0]).toMatchObject({ status: 'invalid' });
  });

  it('hands Git transport the token with the account login as its username', async () => {
    const { impl, providers } = await setup();
    await impl.auth.connectToken({ instance: ORIGIN, token: 'pat-1' });
    const accountId = await impl.auth.readCurrentAccountId({ instance: ORIGIN });

    const credential = await providers.readTransportCredential({ provider: 'gitea', instance: ORIGIN, credentialId: accountId, credentialRevision: 1 });

    expect(credential).toMatchObject({ source: 'pat', secret: 'pat-1', user: { login: 'alice' }, providerUserId: `${ORIGIN}#1` });
    expect(giteaDescriptor.transport.httpsUsername).toEqual({ kind: 'login' });
  });

  it('keeps the token out of the session the shell holds', async () => {
    const { impl } = await setup();
    await impl.auth.connectToken({ instance: ORIGIN, token: 'pat-1' });

    const session = await impl.auth.resolveAccount({ instance: ORIGIN });

    expect(Object.isFrozen(session)).toBe(true);
    expect(JSON.stringify(session)).not.toContain('pat-1');
    expect(session).toMatchObject({ instance: ORIGIN, providerUserId: `${ORIGIN}#1`, secretKind: 'pat' });
  });

  it("reads a fork clone's labels and reviewer candidates from the upstream its list shows", async () => {
    const { impl } = await setup(forkNetworkRoutes({
      'GET /repos/alice/app/labels': [{ name: 'upstream', color: 'ff0000' }],
      'GET /repos/bob/app/labels': [{ name: 'fork', color: '00ff00' }],
      'GET /repos/alice/app/collaborators': [{ ...fixtures.user, id: 2, login: 'ann' }],
      'GET /repos/bob/app/collaborators': [{ ...fixtures.user, id: 3, login: 'bob' }],
    }));
    await impl.auth.connectToken({ instance: ORIGIN, token: 'pat-1' });
    const session = await impl.auth.resolveAccount({ instance: ORIGIN });
    const read = { session, directory: '/repo', project: { owner: 'bob', name: 'app' }, remote: 'origin' };

    await expect(impl.resources.listLabels(read)).resolves.toEqual([{ name: 'upstream', color: 'ff0000' }]);
    const candidates = await impl.resources.listReviewerCandidates(read);
    expect(candidates.map((candidate) => [candidate.id, candidate.login])).toEqual([['2', 'ann']]);
  });

  it('stores the instance\'s separate SSH address and recognises remotes there', async () => {
    const { impl, store } = await setup();

    await expect(impl.auth.setSshUrl({ instance: ORIGIN, sshUrl: 'ssh://git@giteassh.example.com:2222' }))
      .resolves.toEqual({ sshUrl: 'ssh://giteassh.example.com:2222' });
    expect(await store.readInstance(ORIGIN)).toMatchObject({ sshUrl: 'ssh://giteassh.example.com:2222' });
    await expect(impl.auth.readSshUrl({ instance: ORIGIN })).resolves.toBe('ssh://giteassh.example.com:2222');
    await expect(impl.auth.listSshHosts()).resolves.toEqual([{ instance: ORIGIN, sshUrl: 'ssh://giteassh.example.com:2222' }]);
    expect(impl.auth.ownsHost({
      host: 'giteassh.example.com', sshPort: 2222, knownInstances: [ORIGIN],
      knownSshHosts: [{ instance: ORIGIN, sshUrl: 'ssh://giteassh.example.com:2222' }],
    })).toBe(ORIGIN);
    expect(impl.auth.ownsHost({
      host: 'giteassh.example.com', sshPort: 2200, knownInstances: [ORIGIN],
      knownSshHosts: [{ instance: ORIGIN, sshUrl: 'ssh://giteassh.example.com:2222' }],
    })).toBeNull();

    await expect(impl.auth.setSshUrl({ instance: ORIGIN, sshUrl: 'https://giteassh.example.com' }))
      .rejects.toMatchObject({ sourceControlResponse: { status: 400 } });
  });

  it('never uses an HTTP port or an unknown transport to claim a separate SSH host', async () => {
    const { impl } = await setup();
    for (const sshPort of [22, 443, 2222]) {
      const knownSshHosts = [{ instance: ORIGIN, sshUrl: `ssh://giteassh.example.com:${sshPort}` }];
      const input = { host: 'giteassh.example.com', knownInstances: [ORIGIN], knownSshHosts };
      expect(impl.auth.ownsHost({ ...input, sshPort })).toBe(ORIGIN);
      expect(impl.auth.ownsHost({ ...input, port: sshPort })).toBeNull();
      expect(impl.auth.ownsHost(input)).toBeNull();
    }
  });

  it('owns only hosts of instances it knows', async () => {
    const { impl } = await setup();
    expect(impl.auth.ownsHost({ host: 'gitea.example.com', knownInstances: [ORIGIN] })).toBe(ORIGIN);
    expect(impl.auth.ownsHost({ host: 'gitea.example.com', knownInstances: [] })).toBeNull();
    // Two instances on one host: an HTTPS remote's port picks one, an SSH remote takes the first.
    const twoPorts = [ORIGIN, `${ORIGIN}:3443`];
    expect(impl.auth.ownsHost({ host: 'gitea.example.com', port: 3443, knownInstances: twoPorts })).toBe(`${ORIGIN}:3443`);
    expect(impl.auth.ownsHost({ host: 'gitea.example.com', port: 443, knownInstances: twoPorts })).toBe(ORIGIN);
    expect(impl.auth.ownsHost({ host: 'gitea.example.com', port: 3000, knownInstances: twoPorts })).toBeNull();
    expect(impl.auth.ownsHost({ host: 'gitea.example.com', knownInstances: twoPorts })).toBe(ORIGIN);
  });
});

describe('Gitea mutation input', () => {
  it('refuses a request for changes without a body before anything is sent, as Gitea would', async () => {
    const { impl, calls } = await setup();
    const prepare = (input) => impl.mutations.prepare({
      route: '/pr/review', input, context: { target: { number: 1, headSha: HEAD } }, actor: 'actor', credential: 'credential',
    });

    expect(() => prepare({ verdict: 'request-changes' })).toThrow(expect.objectContaining({ code: 'INVALID_SOURCE_CONTROL_MUTATION_CONTEXT', status: 400 }));
    expect(() => prepare({ verdict: 'request-changes', body: '  ' })).toThrow(expect.objectContaining({ status: 400 }));
    expect(prepare({ verdict: 'request-changes', body: 'Please fix' }).input).toMatchObject({ verdict: 'request-changes', body: 'Please fix' });
    expect(prepare({ verdict: 'approve' }).input).toMatchObject({ verdict: 'approve', body: undefined });
    expect(fixtures.errors.reviewRequestChangesWithoutBody.status).toBe(422);
    expect(calls).toHaveLength(0);
  });

  it('offers the subscription routes the standard table lists, and no discussion one', async () => {
    const { impl } = await setup();
    expect(impl.mutations.routes).toEqual(expect.arrayContaining(['/issues/subscription', '/pr/subscription']));
    expect(impl.mutations.routes).not.toContain('/discussions/subscription');
  });

  it('prepares a base change as the standard table does, refusing an empty branch', async () => {
    const { impl } = await setup();
    const actor = { provider: 'gitea', instance: ORIGIN, accountId: `${ORIGIN}#1` };
    const credential = { accountId: `${ORIGIN}#1`, credentialRevision: 1 };
    const target = {
      repositoryId: 'r', bindingRevision: 1, primaryRemote: 'origin',
      project: { id: '1', owner: 'alice', name: 'app' }, number: 1, base: 'main',
    };
    const prepare = (input) => impl.mutations.prepare({ route: '/pr/base', input, context: { target }, actor, credential });

    expect(impl.mutations.routes).toContain('/pr/base');
    const prepared = prepare({ base: ' release/2.0 ' });
    expect(prepared.kind).toBe('change-request-base');
    expect(prepared.input).toMatchObject({ base: 'release/2.0' });
    expect(prepared.digest(target)).toBe(digestMutationInput({
      kind: 'change-request-base', actor, credential, target, base: 'release/2.0',
    }));
    for (const base of ['', '   ', 'x'.repeat(257)]) {
      expect(() => prepare({ base })).toThrow(expect.objectContaining({ code: 'INVALID_SOURCE_CONTROL_MUTATION_CONTEXT', status: 400 }));
    }
  });
});

describe('Gitea through the gt login', () => {
  const CLI_ID = `${ORIGIN}#cli:1`;

  /** A stand-in gt: `state.token` is its login for ORIGIN, `state.failure` how it fails instead. */
  function fakeGt(state = { token: 'gt-token' }) {
    const execFile = vi.fn(async (_file, args) => {
      if (args[0] === 'config') return { stdout: 'config\t/gt/config.yml\nhosts\t/gt/hosts.yml\n', stderr: '' };
      if (state.failure) throw state.failure;
      if (!state.token) throw Object.assign(new Error('Command failed: gt'), { code: 4, stdout: '', stderr: `Error: no account for ${args[3]}\n` });
      return { stdout: `${state.token}\n`, stderr: '' };
    });
    const readFile = vi.fn(async () => `version: "1"\nhosts:\n  ${ORIGIN}:\n    user: alice\n    users:\n      alice: { auth_method: token }\n`);
    return { state, execFile, readFile };
  }

  // GET /user answers alice for the gt token, the user `users[token]` names otherwise, 401 for anything else.
  const userRoutes = (users = {}) => forkNetworkRoutes({
    'GET /user': (call) => {
      const token = String(call.headers.authorization ?? '').replace(/^token /, '');
      const user = token === 'gt-token' ? fixtures.user : users[token];
      return user ?? new Response('{}', { status: 401 });
    },
  });

  it('lists the gt instance and offers its login without connecting it', async () => {
    const gt = fakeGt();
    const { impl, store } = await setup(userRoutes(), gt);

    await expect(impl.auth.listInstances()).resolves.toEqual([ORIGIN]);
    await expect(impl.auth.capabilities({ instance: ORIGIN })).resolves.toMatchObject({ authenticationMethods: { cli: { available: true } } });
    const status = await impl.auth.status({ instance: ORIGIN });
    expect(status).toMatchObject({
      status: 'disconnected', connected: false,
      cli: { available: true, disabled: false, active: false, user: { login: 'alice', provider: 'gitea', instance: ORIGIN } },
      accounts: [{ id: CLI_ID, source: 'cli', current: false, providerUserId: `${ORIGIN}#1` }],
    });
    await expect(impl.auth.readCurrentAccountId({ instance: ORIGIN })).resolves.toBeNull();
    expect(await store.listInstances()).toEqual([]);
  });

  it('acts as the gt login after the user switches to it, without storing its token', async () => {
    const gt = fakeGt();
    const { impl, store, calls } = await setup(userRoutes(), gt);

    await expect(impl.auth.activate({ instance: ORIGIN, accountId: CLI_ID })).resolves.toMatchObject({
      status: 'connected', connected: true, user: { login: 'alice' }, cli: { active: true },
      accounts: [{ id: CLI_ID, current: true }],
    });
    await expect(impl.auth.readCurrentAccountId({ instance: ORIGIN })).resolves.toBe(CLI_ID);
    for (const accountId of [CLI_ID, undefined]) {
      const session = await impl.auth.resolveAccount({ instance: ORIGIN, accountId });
      expect(session).toEqual({
        instance: ORIGIN, accountId: CLI_ID, credentialRevision: 1, providerUserId: `${ORIGIN}#1`, secretKind: 'cli', persisted: false,
      });
      calls.length = 0;
      await impl.resources.projectUpstream({ session, directory: '/repo', remote: 'origin' });
      expect(calls[0].headers.authorization).toBe('token gt-token');
    }
    expect(await store.listAccounts(ORIGIN)).toEqual([]);
    expect(JSON.stringify(await store.readInstance(ORIGIN))).not.toContain('gt-token');
  });

  it('refuses the gt account once gt is logged in as someone else', async () => {
    const gt = fakeGt();
    const { impl, events } = await setup(userRoutes({ 'bob-token': { ...fixtures.user, id: 2, login: 'bob' } }), gt);
    await impl.auth.activate({ instance: ORIGIN, accountId: CLI_ID });
    gt.state.token = 'bob-token';

    await expect(impl.auth.resolveAccount({ instance: ORIGIN, accountId: CLI_ID })).rejects.toMatchObject({ status: 401, sourceControlAccountUnavailable: true });
    expect(events.invalidated).toHaveBeenCalledWith({ provider: 'gitea', instance: ORIGIN, accountId: CLI_ID });
    await expect(impl.auth.activate({ instance: ORIGIN, accountId: CLI_ID })).rejects.toMatchObject({ sourceControlResponse: { status: 404 } });
  });

  it('keeps the switch while gt cannot answer and undoes it only when the login is gone', async () => {
    const gt = fakeGt();
    const { impl, store } = await setup(userRoutes(), gt);
    await impl.auth.activate({ instance: ORIGIN, accountId: CLI_ID });

    // A locked keyring and a timeout settle nothing.
    for (const failure of [
      Object.assign(new Error('Command failed: gt'), { code: 4, stdout: '', stderr: 'Error: keyring is locked\n' }),
      Object.assign(new Error('timed out'), { killed: true, code: null }),
    ]) {
      gt.state.failure = failure;
      await expect(impl.auth.status({ instance: ORIGIN })).resolves.toMatchObject({ connected: false, cli: { available: false, active: true } });
      expect((await store.readInstance(ORIGIN)).cliActive).toBe(true);
    }
    gt.state.failure = null;
    await expect(impl.auth.status({ instance: ORIGIN })).resolves.toMatchObject({ connected: true, cli: { active: true } });

    gt.state.token = null;
    await expect(impl.auth.status({ instance: ORIGIN })).resolves.toMatchObject({ connected: false, cli: { available: false, active: false } });
    expect((await store.readInstance(ORIGIN)).cliActive).toBe(false);
  });

  it('undoes the switch when Gitea refuses the gt token', async () => {
    const gt = fakeGt();
    const { impl, store } = await setup(userRoutes(), gt);
    await impl.auth.activate({ instance: ORIGIN, accountId: CLI_ID });
    gt.state.token = 'revoked';

    await expect(impl.auth.status({ instance: ORIGIN })).resolves.toMatchObject({ connected: false, cli: { active: false } });
    expect((await store.readInstance(ORIGIN)).cliActive).toBe(false);
  });

  it('keeps a stored account first until the user switches, and back', async () => {
    const gt = fakeGt();
    const { impl } = await setup(userRoutes({ 'pat-1': fixtures.user }), gt);
    await impl.auth.connectToken({ instance: ORIGIN, token: 'pat-1' });
    const stored = await impl.auth.readCurrentAccountId({ instance: ORIGIN });

    await expect(impl.auth.status({ instance: ORIGIN })).resolves.toMatchObject({ connected: true, cli: { available: true, active: false } });
    await impl.auth.activate({ instance: ORIGIN, accountId: CLI_ID });
    await expect(impl.auth.readCurrentAccountId({ instance: ORIGIN })).resolves.toBe(CLI_ID);
    await expect(impl.auth.accounts({ instance: ORIGIN })).resolves.toEqual([expect.objectContaining({ id: stored, current: false })]);

    await impl.auth.activate({ instance: ORIGIN, accountId: stored });
    await expect(impl.auth.readCurrentAccountId({ instance: ORIGIN })).resolves.toBe(stored);
  });

  it('reports a refused read without touching the store', async () => {
    const gt = fakeGt();
    const { impl, events, store } = await setup(userRoutes(), gt);
    await impl.auth.activate({ instance: ORIGIN, accountId: CLI_ID });

    await expect(impl.auth.invalidateAccount({ instance: ORIGIN, accountId: CLI_ID, persisted: false })).resolves.toBe(false);
    expect(events.invalidated).toHaveBeenCalledWith({ provider: 'gitea', instance: ORIGIN, accountId: CLI_ID });
    expect((await store.readInstance(ORIGIN)).cliActive).toBe(true);
  });

  it('turns gt off and on through the route shell', async () => {
    const gt = fakeGt();
    const context = await setup(userRoutes(), gt);
    const app = express();
    app.use(express.json());
    registerProviderRoutes(app, { providers: context.providers, validateReadContext: async (read) => ({ ...read, primaryRemote: 'origin' }) });
    await context.impl.auth.activate({ instance: ORIGIN, accountId: CLI_ID });

    const off = await request(app).post('/api/source-control/gitea/auth/cli').query({ instance: ORIGIN }).send({ disabled: true });
    expect(off.status).toBe(200);
    expect(off.body).toEqual({ available: false, disabled: true });
    const status = await request(app).get('/api/source-control/gitea/auth/status').query({ instance: ORIGIN });
    expect(status.body).toMatchObject({ connected: false, accounts: [], cli: { available: false, disabled: true, active: false } });
    await expect(context.impl.auth.resolveAccount({ instance: ORIGIN, accountId: CLI_ID })).rejects.toMatchObject({ status: 401 });

    const on = await request(app).post('/api/source-control/gitea/auth/cli').query({ instance: ORIGIN }).send({ disabled: false });
    expect(on.body).toEqual({ available: true, disabled: false });
  });

  it('removes the gt account by undoing the switch only', async () => {
    const gt = fakeGt();
    const { impl, events, store } = await setup(userRoutes(), gt);
    await impl.auth.activate({ instance: ORIGIN, accountId: CLI_ID });

    await expect(impl.auth.remove({ instance: ORIGIN, accountId: CLI_ID })).resolves.toEqual({ removed: true });
    expect(events.removed).toHaveBeenCalledWith({ provider: 'gitea', instance: ORIGIN, accountId: CLI_ID });
    expect((await store.readInstance(ORIGIN)).cliActive).toBe(false);
  });
});

describe('Gitea behind the route shell', () => {
  async function appWith(routes) {
    const context = await setup(routes);
    const app = express();
    app.use(express.json());
    registerProviderRoutes(app, {
      providers: context.providers,
      validateReadContext: async (read) => ({ ...read, primaryRemote: 'origin' }),
    });
    return { ...context, app };
  }

  it('invalidates the bound account when a read is refused with 401', async () => {
    let refuse = false;
    const { app, impl, events } = await appWith(forkNetworkRoutes({
      'GET /repos/bob/app': () => (refuse ? new Response('{}', { status: 401 }) : fixtures.forkRepo),
    }));
    await impl.auth.connectToken({ instance: ORIGIN, token: 'pat-1' });
    const accountId = await impl.auth.readCurrentAccountId({ instance: ORIGIN });
    refuse = true;

    const response = await request(app).get('/api/source-control/gitea/pulls/list')
      .query({ instance: ORIGIN, directory: '/repo', accountId, repositoryId: 'r', bindingRevision: '1', primaryRemote: 'origin' });

    expect(response.status).toBe(401);
    expect(events.invalidated).toHaveBeenCalledWith({ provider: 'gitea', instance: ORIGIN, accountId });
  });

  it('brings a pull request branch up to date through the canonical executor', async () => {
    const context = await setup(forkNetworkRoutes({ 'POST /repos/alice/app/pulls/1/update': new Response(null, { status: 200 }) }));
    const app = express();
    app.use(express.json());
    const records = new Map();
    const store = {
      withExecutionLock: async (_key, operation) => operation(),
      claim: async (record) => {
        const existing = records.get(record.key);
        if (existing) {
          return existing.inputDigest === record.inputDigest
            ? { status: 'existing', record: existing }
            : { status: 'conflict', record: existing };
        }
        const running = { ...record, state: 'running' };
        records.set(record.key, running);
        return { status: 'claimed', record: running };
      },
      complete: async (key, _digest, completion) => {
        const completed = { ...records.get(key), state: completion.state };
        if (completion.result !== undefined) completed.result = completion.result;
        records.set(key, completed);
        return completed;
      },
      read: async (key) => records.get(key) ?? null,
    };
    registerProviderRoutes(app, {
      providers: context.providers,
      validateReadContext: async (read) => ({ ...read, primaryRemote: 'origin' }),
      validateMutationContext: async (body) => ({
        instance: body.instance, accountId: body.accountId, repositoryId: body.repositoryId,
        bindingRevision: body.bindingRevision, primaryRemote: body.primaryRemote,
        idempotencyKey: body.idempotencyKey, target: body.target,
      }),
      mutationExecutor: createMutationExecutor({ store }),
    });
    await context.impl.auth.connectToken({ instance: ORIGIN, token: 'pat-1' });
    const accountId = await context.impl.auth.readCurrentAccountId({ instance: ORIGIN });
    const body = {
      provider: 'gitea', instance: ORIGIN, directory: '/repo', repositoryId: 'repo-1',
      accountId, bindingRevision: 2, primaryRemote: 'origin', idempotencyKey: 'update-branch-one',
      target: { project: { owner: 'alice', name: 'app' }, number: 1, head: 'feature', base: 'main', headSha: HEAD },
      expectedHeadSha: HEAD,
    };

    const updated = await request(app).post('/api/source-control/gitea/pr/update-branch').send(body).expect(200);

    expect(updated.body).toMatchObject({ status: 'succeeded', result: {} });
    expect(context.calls.find((call) => call.method === 'POST').url.searchParams.get('style')).toBe('merge');
    expect([...records.values()][0]).toMatchObject({ kind: 'change-request-update-branch', state: 'succeeded' });

    await request(app).post('/api/source-control/gitea/pr/update-branch')
      .send({ ...body, idempotencyKey: 'update-branch-bad', expectedHeadSha: 'not-a-sha' }).expect(400);
  });
  it('answers 501 for review threads, uploads and the reference picker', async () => {
    const { app } = await appWith();
    for (const [method, url] of [
      ['post', '/api/source-control/gitea/pr/thread/reply'],
      ['post', '/api/source-control/gitea/pr/thread/resolve'],
      ['get', '/api/source-control/gitea/uploads/0123456789abcdef0123456789abcdef/a.png'],
      ['get', '/api/source-control/gitea/references'],
      ['post', '/api/source-control/gitea/auth/start'],
      // No host here keeps discussions, so the capability gate answers first.
      ['post', '/api/source-control/gitea/discussions/subscription'],
    ]) {
      const response = await request(app)[method](url);
      expect(response.status, url).toBe(501);
    }
  });
});

describe('Gitea in the registry (smoke)', () => {
  it('is listed third and answers disconnected without an account', async () => {
    const app = express();
    app.use(express.json());
    registerSourceControlRoutes(app, { configRoot: await tempDirectory(), gitea: { execFile: missingGt } });

    const providers = await request(app).get('/api/source-control/providers');
    expect(providers.status).toBe(200);
    expect(providers.body.providers.map((provider) => [provider.id, provider.order])).toEqual([['github', 0], ['gitlab', 1], ['gitea', 2], ['gerrit', 3], ['forgejo', 4]]);

    const status = await request(app).get('/api/source-control/gitea/auth/status').query({ instance: 'https://gitea.example.com' });
    expect(status.status).toBe(200);
    expect(status.body).toEqual({
      provider: 'gitea', instance: 'https://gitea.example.com', status: 'disconnected', connected: false, accounts: [],
      cli: { available: false, disabled: false, active: false },
    });

    const instances = await request(app).get('/api/source-control/instances');
    expect(instances.body.instances.filter((entry) => entry.provider === 'gitea')).toEqual([]);

    const saved = await request(app).post('/api/source-control/gitea/auth/ssh-url')
      .query({ instance: 'https://gitea.example.com' })
      .send({ sshUrl: 'ssh://git@giteassh.example.com:2222' });
    expect(saved.status).toBe(200);
    expect(saved.body).toEqual({ sshUrl: 'ssh://giteassh.example.com:2222' });
    const withSsh = await request(app).get('/api/source-control/instances');
    expect(withSsh.body.instances).toContainEqual({
      provider: 'gitea', instance: 'https://gitea.example.com', instanceSshUrl: 'ssh://giteassh.example.com:2222',
    });
    const refused = await request(app).post('/api/source-control/gitea/auth/ssh-url')
      .query({ instance: 'https://gitea.example.com' })
      .send({ sshUrl: 'https://giteassh.example.com' });
    expect(refused.status).toBe(400);
  });
});

describe('Gitea contributor source', () => {
  // Git transport reaches a loopback HTTP instance, so its fork is a source too.
  it('takes the fork clone URL of a loopback HTTP instance', async () => {
    const local = 'http://127.0.0.1:3000';
    const { impl } = await setup(JSON.parse(JSON.stringify(forkNetworkRoutes()).replaceAll(ORIGIN, local)));
    await impl.auth.connectToken({ instance: local, token: 'pat-1' });
    const session = await impl.auth.resolveAccount({ instance: local });

    await expect(impl.resources.resolveChangeRequestSource({
      session, context: { directory: '/repo', primaryRemote: 'origin', instance: local },
      project: { id: '1', owner: 'alice', name: 'app' }, number: 1, expectedHeadSha: HEAD, requestedRemoteName: 'pr-bob',
    })).resolves.toMatchObject({ classification: 'contributor-fork', endpoint: `${local}/bob/app.git`, headRef: 'refs/heads/feature' });
  });
});
