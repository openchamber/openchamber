import express from 'express';
import request from 'supertest';
import { describe, expect, it, vi } from 'vitest';
import { registerGitLabRoutes } from './routes.js';
import { createMutationExecutor, digestMutationInput } from '../source-control/mutation-executor.js';

const origin = 'https://gitlab.example.com';
const userResponse = () => Response.json({ id: 9, username: 'gitlab-user', name: 'GitLab User' });

function makeStore(account = null) {
  const storedAccount = account ? {
    status: 'valid', credentialId: account.id, credentialRevision: 1,
    providerUserId: `${origin}#${account.user.id}`, ...account,
  } : null;
  let current = storedAccount ? { activeAccountId: storedAccount.id, accounts: [storedAccount], cliDisabled: false, cliActive: false } : { activeAccountId: null, accounts: [], cliDisabled: false, cliActive: false };
  return {
    readInstance: vi.fn(async () => current),
    setAccount: vi.fn(async (instance, value) => {
      const id = `${instance}#${value.user.id}`;
      const entry = {
        id, credentialId: id, credentialRevision: 1, providerUserId: `${instance}#${value.user.id}`,
        status: 'valid', ...value,
      };
      current = { ...current, activeAccountId: entry.id, accounts: [entry] };
      return entry;
    }),
    activate: vi.fn(async () => true),
    readAccount: vi.fn(async (_instance, accountId) => current.accounts.find((entry) => entry.id === accountId && entry.status === 'valid') ?? null),
    removeActive: vi.fn(async () => true),
    removeAccount: vi.fn(async () => { current = { ...current, activeAccountId: null, accounts: [] }; return true; }),
    markAccountInvalid: vi.fn(async (_instance, accountId) => {
      current = { ...current, accounts: current.accounts.map((entry) => entry.id === accountId ? { ...entry, status: 'invalid', invalidReason: 'unauthorized' } : entry) };
      return true;
    }),
    setCliDisabled: vi.fn(async (_instance, disabled) => { current = { ...current, cliDisabled: disabled }; return disabled; }),
    setCliActive: vi.fn(async (_instance, active) => { current = { ...current, cliActive: active }; return active; }),
  };
}

function appWith(options) {
  const app = express();
  app.use(express.json());
  registerGitLabRoutes(app, {
    authFile: '/unused/source-control-auth.json',
    execFile: async () => ({ stdout: '' }),
    validateReadContext: async (context) => ({ ...context, accountId: context.accountId, primaryRemote: context.primaryRemote || 'origin' }),
    ...options,
  });
  return app;
}

const mutationBody = (overrides = {}) => ({
  provider: 'gitlab',
  instance: origin,
  directory: '/repo',
  repositoryId: 'repo_one',
  accountId: `${origin}#9`,
  bindingRevision: 3,
  primaryRemote: 'origin',
  idempotencyKey: 'mutation-one',
  target: { project: { owner: 'team', name: 'repo' }, head: 'feature', base: 'main' },
  title: 'Feature',
  ...overrides,
});

function makeMutationStore(initial = [], completeImpl) {
  const records = new Map(initial.map((record) => [record.key, record]));
  return {
    records,
    withExecutionLock: async (_key, operation) => operation(),
    claim: vi.fn(async (record) => {
      const existing = records.get(record.key);
      if (existing) return existing.inputDigest === record.inputDigest
        ? { status: 'existing', record: existing }
        : { status: 'conflict', record: existing };
      const running = { ...record, state: 'running' };
      records.set(record.key, running);
      return { status: 'claimed', record: running };
    }),
    complete: vi.fn(async (key, digest, completion) => {
      if (completeImpl) await completeImpl();
      const record = records.get(key);
      const completed = { ...record, state: completion.state };
      if (completion.result !== undefined) completed.result = completion.result;
      records.set(key, completed);
      return completed;
    }),
    read: vi.fn(async (key) => records.get(key) ?? null),
  };
}

function canonicalMutationOptions(overrides = {}) {
  const account = { id: `${origin}#9`, token: 'stored', user: { id: 9 }, source: 'pat', scope: '', status: 'valid' };
  const target = {
    repositoryId: 'repo_one', bindingRevision: 3, primaryRemote: 'origin',
    project: { id: '2', owner: 'team', name: 'repo' }, head: 'feature', base: 'main',
  };
  const calls = {
    resolveCreate: vi.fn(async () => ({ providerTarget: { sourceProjectId: '1', targetProjectId: '2' }, target })),
    create: vi.fn(async () => ({})),
    update: vi.fn(async () => ({})),
    merge: vi.fn(async () => ({ merged: true })),
    ready: vi.fn(async () => ({ ready: true })),
    reconcileCreate: vi.fn(async () => ({ state: 'succeeded', result: {} })),
    reconcileExisting: vi.fn(async () => ({ state: 'outcome-unknown' })),
  };
  const service = {
    resolveCreateMutation: calls.resolveCreate,
    resolveChangeRequestMutation: vi.fn(async (context) => {
      const existingTarget = { ...target, number: context.target.number };
      if (context.target.headSha !== undefined) existingTarget.headSha = context.target.headSha;
      return { providerTarget: { projectId: '2', number: context.target.number }, target: existingTarget };
    }),
    createChangeRequest: calls.create,
    updateChangeRequest: calls.update,
    mergeChangeRequest: calls.merge,
    readyChangeRequest: calls.ready,
    reconcileCreateMutation: calls.reconcileCreate,
    reconcileChangeRequestMutation: calls.reconcileExisting,
  };
  return {
    account,
    target,
    service,
    calls,
    options: {
      store: makeStore(account),
      createClient: vi.fn(() => ({})),
      createResourceService: vi.fn(() => service),
      validateMutationContext: vi.fn(async (body) => ({
        directory: body.directory, repositoryId: body.repositoryId, provider: 'gitlab', instance: origin,
        accountId: body.accountId, bindingRevision: body.bindingRevision, primaryRemote: body.primaryRemote,
        idempotencyKey: body.idempotencyKey, target: body.target,
      })),
      mutationExecutor: createMutationExecutor({ store: makeMutationStore() }),
      ...overrides,
    },
  };
}

describe('GitLab routes', () => {
  it.each([['SOURCE_CONTROL_LOCK_BUSY', 503], ['SOURCE_CONTROL_LOCK_FAILED', 500], ['INVALID_SOURCE_CONTROL_AUTH', 500]])('preserves actionable %s auth inventory failures', async (code, status) => {
    const message = code === 'INVALID_SOURCE_CONTROL_AUTH'
      ? 'Source control auth storage is invalid'
      : 'Stop all writers before stale-lock cleanup';
    const store = makeStore();
    store.readInstance.mockRejectedValue(Object.assign(new Error(message), { code, status }));

    const response = await request(appWith({ store })).get('/api/source-control/gitlab/auth/accounts')
      .query({ instance: origin }).expect(status);

    expect(response.body).toEqual({ error: message, code });
  });

  it('groups credential availability by provider user without merging credential rows', async () => {
    const store = makeStore();
    const first = {
      id: 'credential-one', credentialRevision: 1, providerUserId: `${origin}#9`, token: 'one',
      user: { id: 9, login: 'user' }, source: 'pat', scope: '', status: 'invalid',
    };
    const second = {
      id: 'credential-two', credentialRevision: 1, providerUserId: `${origin}#9`, token: 'two',
      user: { id: 9, login: 'renamed' }, source: 'oauth', scope: 'api', status: 'valid',
    };
    store.readInstance.mockResolvedValue({ activeAccountId: second.id, accounts: [first, second], cliDisabled: true, cliActive: false });

    const response = await request(appWith({ store })).get('/api/source-control/gitlab/auth/accounts')
      .query({ instance: origin }).expect(200);

    expect(response.body.accounts).toEqual([
      expect.objectContaining({ id: first.id, credentialId: first.id, providerUserId: `${origin}#9`, providerUserStatus: 'available', status: 'invalid' }),
      expect.objectContaining({ id: second.id, credentialId: second.id, providerUserId: `${origin}#9`, providerUserStatus: 'available', status: 'valid' }),
    ]);
  });

  it.each([['SOURCE_CONTROL_LOCK_BUSY', 503], ['SOURCE_CONTROL_LOCK_FAILED', 500]])('preserves actionable %s read and mutation failures', async (code, status) => {
    const message = 'Stop all writers before stale-lock cleanup';
    const fail = async () => { throw Object.assign(new Error(message), { code, status }); };
    const setup = canonicalMutationOptions({ validateMutationContext: fail, validateReadContext: fail });
    const app = appWith(setup.options);
    const mutation = await request(app).post('/api/source-control/gitlab/pr/create').send(mutationBody()).expect(status);
    expect(mutation.body).toEqual({ error: message, code });
    const read = await request(app).get('/api/source-control/gitlab/pr/status').query({ instance: origin, directory: '/repo', branch: 'feature' }).expect(status);
    expect(read.body).toEqual({ error: message, code });
    expect(setup.calls.create).not.toHaveBeenCalled();
  });

  it('preserves the account and returns busy when removal reconciliation cannot acquire its lock', async () => {
    const setup = canonicalMutationOptions({ onAccountRemoved: async () => {
      throw Object.assign(new Error('Stop all writers before stale-lock cleanup'), { code: 'SOURCE_CONTROL_LOCK_BUSY', status: 503 });
    } });
    const response = await request(appWith(setup.options)).delete('/api/source-control/gitlab/auth')
      .query({ instance: origin, accountId: setup.account.id }).expect(503);
    expect(response.body.code).toBe('SOURCE_CONTROL_LOCK_BUSY');
    expect(setup.options.store.removeAccount).not.toHaveBeenCalled();
  });

  it('fails canonical mutations closed when validation or execution is unavailable', async () => {
    const body = mutationBody();
    await request(appWith({ store: makeStore(), validateMutationContext: undefined, mutationExecutor: { execute: vi.fn() } }))
      .post('/api/source-control/gitlab/pr/create').send(body).expect(501);
    await request(appWith({ store: makeStore(), validateMutationContext: vi.fn(), mutationExecutor: undefined }))
      .post('/api/source-control/gitlab/pr/create').send(body).expect(501);
  });

  it.each([
    ['missing account', 'INVALID_SOURCE_CONTROL_MUTATION_CONTEXT', 400],
    ['missing binding', 'SOURCE_CONTROL_BINDING_MISSING', 409],
    ['missing revision', 'INVALID_SOURCE_CONTROL_MUTATION_CONTEXT', 400],
    ['stale binding', 'SOURCE_CONTROL_BINDING_STALE', 409],
  ])('rejects %s before credentials or provider work', async (_label, code, status) => {
    const failure = Object.assign(new Error('context rejected'), { code, status });
    const store = makeStore();
    const createClient = vi.fn();
    const response = await request(appWith({
      store,
      createClient,
      validateMutationContext: vi.fn(async () => { throw failure; }),
      mutationExecutor: { read: vi.fn(), execute: vi.fn() },
    })).post('/api/source-control/gitlab/pr/create').send(mutationBody()).expect(status);

    expect(response.body).toEqual({ error: 'context rejected', code });
    expect(store.readInstance).not.toHaveBeenCalled();
    expect(createClient).not.toHaveBeenCalled();
  });

  it('returns the current binding details with stale mutation errors', async () => {
    const current = { repositoryId: 'repo_one', bindingRevision: 4, binding: { status: 'bound' } };
    const failure = Object.assign(new Error('context rejected'), {
      code: 'SOURCE_CONTROL_BINDING_STALE', status: 409, current,
    });
    const response = await request(appWith({
      store: makeStore(),
      validateMutationContext: vi.fn(async () => { throw failure; }),
      mutationExecutor: { read: vi.fn(), execute: vi.fn() },
    })).post('/api/source-control/gitlab/pr/create').send(mutationBody()).expect(409);

    expect(response.body).toEqual({ error: 'context rejected', code: failure.code, current });
  });

  it('uses the validated account even when the active account differs', async () => {
    const active = { id: `${origin}#1`, token: 'active', user: { id: 1 }, source: 'pat', status: 'valid' };
    const bound = {
      id: `${origin}#9`, credentialRevision: 1, providerUserId: `${origin}#9`,
      token: 'bound', user: { id: 9 }, source: 'oauth', status: 'valid',
    };
    const setup = canonicalMutationOptions();
    setup.options.store.readInstance.mockResolvedValue({ activeAccountId: active.id, accounts: [active, bound], cliDisabled: false, cliActive: false });
    setup.options.store.readAccount.mockImplementation(async (_instance, id) => id === bound.id ? bound : null);

    const response = await request(appWith(setup.options)).post('/api/source-control/gitlab/pr/create')
      .send(mutationBody({ accountId: bound.id })).expect(200);

    expect(setup.options.createClient).toHaveBeenCalledWith({ origin, token: 'bound', tokenType: 'oauth' });
    expect(response.body.actor).toEqual({ provider: 'gitlab', instance: origin, providerAccountId: bound.providerUserId });
    expect(response.body.target).toEqual(setup.target);
  });

  it('keeps exact credential ID and revision in replay input while deriving provider actor metadata', async () => {
    const setup = canonicalMutationOptions();
    const execute = vi.fn(async (input) => ({
      record: { ...input.record, state: 'succeeded', result: {} }, replayed: false,
    }));
    setup.options.mutationExecutor = { read: vi.fn(async () => null), execute };

    const response = await request(appWith(setup.options)).post('/api/source-control/gitlab/pr/create').send({
      ...mutationBody(), providerUserId: `${origin}#999`,
    }).expect(200);

    const actor = { provider: 'gitlab', instance: origin, accountId: setup.account.id };
    const credential = { accountId: setup.account.id, credentialRevision: 1 };
    expect(execute).toHaveBeenCalledWith(expect.objectContaining({
      providerAccountId: `${origin}#9`,
      record: expect.objectContaining({
        actor,
        inputDigest: digestMutationInput({
          kind: 'change-request-create', actor, credential, target: setup.target,
          title: 'Feature', body: null, draft: false, remote: 'origin', headRemote: 'origin',
        }),
      }),
    }));
    expect(response.body.actor).toEqual({ provider: 'gitlab', instance: origin, providerAccountId: `${origin}#9` });
  });

  it('keeps sibling credentials separate while attributing them to one provider user', async () => {
    const setup = canonicalMutationOptions();
    const first = {
      ...setup.account, id: 'credential-one', credentialId: 'credential-one', credentialRevision: 1,
      providerUserId: `${origin}#9`,
    };
    const second = {
      ...setup.account, id: 'credential-two', credentialId: 'credential-two', credentialRevision: 2,
      providerUserId: `${origin}#9`,
    };
    setup.options.store.readAccount.mockImplementation(async (_instance, accountId) => (
      [first, second].find((account) => account.id === accountId) ?? null
    ));
    const mutationStore = makeMutationStore();
    setup.options.mutationExecutor = createMutationExecutor({ store: mutationStore });
    const app = appWith(setup.options);

    const firstResponse = await request(app).post('/api/source-control/gitlab/pr/create').send(mutationBody({
      accountId: first.id, idempotencyKey: 'first',
    })).expect(200);
    const secondResponse = await request(app).post('/api/source-control/gitlab/pr/create').send(mutationBody({
      accountId: second.id, idempotencyKey: 'second',
    })).expect(200);

    expect(firstResponse.body.actor).toEqual({ provider: 'gitlab', instance: origin, providerAccountId: `${origin}#9` });
    expect(secondResponse.body.actor).toEqual(firstResponse.body.actor);
    expect(mutationStore.records.get('first').actor.accountId).toBe(first.id);
    expect(mutationStore.records.get('second').actor.accountId).toBe(second.id);
    expect(mutationStore.records.get('first').inputDigest).not.toBe(mutationStore.records.get('second').inputDigest);
  });

  it.each([
    ['update', { title: 'Updated' }, {}, 'update'],
    ['merge', { method: 'squash' }, { merged: true }, 'merge'],
    ['ready', {}, { ready: true }, 'ready'],
  ])('returns a compact canonical receipt for %s', async (route, fields, result, call) => {
    const setup = canonicalMutationOptions();
    const body = mutationBody({
      idempotencyKey: `mutation-${route}`,
      target: { project: { owner: 'team', name: 'repo' }, number: 5, head: 'feature', base: 'main' },
      ...fields,
    });
    const response = await request(appWith(setup.options)).post(`/api/source-control/gitlab/pr/${route}`)
      .send(body).expect(200);

    expect(response.body).toEqual({
      status: 'succeeded',
      actor: { provider: 'gitlab', instance: origin, providerAccountId: `${origin}#9` },
      target: { ...setup.target, number: 5 },
      replayed: false,
      result,
    });
    expect(setup.calls[call]).toHaveBeenCalledOnce();
  });

  it('deduplicates one provider write, replays completion, and conflicts on changed private input', async () => {
    const setup = canonicalMutationOptions();
    let release;
    setup.calls.create.mockImplementation(() => new Promise((resolve) => { release = resolve; }));
    const app = appWith(setup.options);
    const body = mutationBody();
    const first = request(app).post('/api/source-control/gitlab/pr/create').send(body).then((response) => response);
    const duplicate = request(app).post('/api/source-control/gitlab/pr/create').send(body).then((response) => response);
    await vi.waitFor(() => expect(setup.calls.create).toHaveBeenCalledOnce());
    release({});
    const [firstResponse, duplicateResponse] = await Promise.all([first, duplicate]);
    expect([firstResponse.body.replayed, duplicateResponse.body.replayed].sort()).toEqual([false, true]);
    expect(setup.calls.create).toHaveBeenCalledOnce();

    const replay = await request(app).post('/api/source-control/gitlab/pr/create').send(body).expect(200);
    expect(replay.body.replayed).toBe(true);
    await request(app).post('/api/source-control/gitlab/pr/create')
      .send({ ...body, title: 'Different private title' }).expect(409)
      .expect(({ body: responseBody }) => expect(responseBody.code).toBe('SOURCE_CONTROL_MUTATION_CONFLICT'));
    expect(setup.calls.create).toHaveBeenCalledOnce();
  });

  it('replays a durable success without provider preflight', async () => {
    const setup = canonicalMutationOptions();
    const app = appWith(setup.options);
    const body = mutationBody();
    await request(app).post('/api/source-control/gitlab/pr/create').send(body).expect(200);
    setup.calls.resolveCreate.mockRejectedValue(new Error('provider unavailable'));

    const replay = await request(app).post('/api/source-control/gitlab/pr/create').send(body).expect(200);

    expect(replay.body).toMatchObject({ replayed: true, result: {} });
    expect(setup.calls.resolveCreate).toHaveBeenCalledOnce();
    expect(setup.calls.create).toHaveBeenCalledOnce();
  });

  it('still validates binding and exact account existence before terminal replay', async () => {
    const setup = canonicalMutationOptions();
    const app = appWith(setup.options);
    const body = mutationBody();
    await request(app).post('/api/source-control/gitlab/pr/create').send(body).expect(200);
    setup.options.store.readAccount.mockResolvedValue(null);

    await request(app).post('/api/source-control/gitlab/pr/create').send(body).expect(401);

    expect(setup.options.validateMutationContext).toHaveBeenCalledTimes(2);
    expect(setup.calls.resolveCreate).toHaveBeenCalledOnce();
    expect(setup.calls.create).toHaveBeenCalledOnce();
  });

  it('rejects a terminal replay whose trusted target differs from the stored target', async () => {
    const setup = canonicalMutationOptions();
    const app = appWith(setup.options);
    const body = mutationBody();
    await request(app).post('/api/source-control/gitlab/pr/create').send(body).expect(200);

    const response = await request(app).post('/api/source-control/gitlab/pr/create').send({
      ...body,
      target: { ...body.target, head: 'other-feature' },
    }).expect(409);

    expect(response.body.code).toBe('SOURCE_CONTROL_MUTATION_CONFLICT');
    expect(setup.calls.resolveCreate).toHaveBeenCalledOnce();
    expect(setup.calls.create).toHaveBeenCalledOnce();
  });

  it('reconciles a durable create after restart without repeating the write', async () => {
    let failCompletion = true;
    const mutationStore = makeMutationStore([], async () => {
      if (failCompletion) {
        failCompletion = false;
        throw new Error('disk unavailable');
      }
    });
    const setup = canonicalMutationOptions({ mutationExecutor: createMutationExecutor({ store: mutationStore }) });
    const body = mutationBody();
    await request(appWith(setup.options)).post('/api/source-control/gitlab/pr/create').send(body).expect(409);
    expect(setup.calls.create).toHaveBeenCalledOnce();

    setup.options.mutationExecutor = createMutationExecutor({ store: mutationStore });
    const recovered = await request(appWith(setup.options)).post('/api/source-control/gitlab/pr/create').send(body).expect(200);
    expect(recovered.body).toMatchObject({ replayed: true, result: {} });
    expect(setup.calls.reconcileCreate).toHaveBeenCalledOnce();
    expect(setup.calls.create).toHaveBeenCalledOnce();
  });

  it.each([
    ['statusless socket failure', Object.assign(new Error('socket closed'), { code: 'ECONNRESET' })],
    ['statusless network failure', Object.assign(new Error('host not found'), { code: 'ENOTFOUND' })],
    ['statusless timeout', Object.assign(new Error('request timed out'), { code: 'ETIMEDOUT' })],
    ['HTTP 500', Object.assign(new Error('internal error'), { status: 500 })],
    ['HTTP 502', Object.assign(new Error('bad gateway'), { response: { status: 502 } })],
    ['HTTP 504', Object.assign(new Error('gateway timeout'), { cause: { response: { status: 504 } } })],
  ])('keeps %s outcome unknown and never retries the provider write', async (_label, failure) => {
    const setup = canonicalMutationOptions();
    setup.calls.create.mockRejectedValue(failure);
    const app = appWith(setup.options);
    await request(app).post('/api/source-control/gitlab/pr/create').send(mutationBody()).expect(409);
    setup.calls.resolveCreate.mockRejectedValue(new Error('provider unavailable'));
    const replay = await request(app).post('/api/source-control/gitlab/pr/create').send(mutationBody()).expect(409);
    expect(replay.body.code).toBe('SOURCE_CONTROL_MUTATION_OUTCOME_UNKNOWN');
    expect(setup.calls.create).toHaveBeenCalledOnce();
    expect(setup.calls.resolveCreate).toHaveBeenCalledOnce();
  });

  it('marks an unproved restart reconciliation unknown without repeating the write', async () => {
    let failCompletion = true;
    const mutationStore = makeMutationStore([], async () => {
      if (failCompletion) {
        failCompletion = false;
        throw new Error('disk unavailable');
      }
    });
    const setup = canonicalMutationOptions({ mutationExecutor: createMutationExecutor({ store: mutationStore }) });
    setup.calls.reconcileCreate.mockResolvedValue({ state: 'outcome-unknown' });
    const body = mutationBody();
    await request(appWith(setup.options)).post('/api/source-control/gitlab/pr/create').send(body).expect(409);

    setup.options.mutationExecutor = createMutationExecutor({ store: mutationStore });
    const response = await request(appWith(setup.options)).post('/api/source-control/gitlab/pr/create').send(body).expect(409);
    expect(response.body.code).toBe('SOURCE_CONTROL_MUTATION_OUTCOME_UNKNOWN');
    expect(setup.calls.reconcileCreate).toHaveBeenCalledOnce();
    expect(setup.calls.create).toHaveBeenCalledOnce();
  });

  it('persists known provider HTTP rejection as a definite failure', async () => {
    const setup = canonicalMutationOptions();
    setup.calls.create.mockRejectedValue(Object.assign(new Error('provider rejected'), { status: 422 }));
    const app = appWith(setup.options);
    await request(app).post('/api/source-control/gitlab/pr/create').send(mutationBody()).expect(422);
    setup.calls.resolveCreate.mockRejectedValue(new Error('provider unavailable'));
    const replay = await request(app).post('/api/source-control/gitlab/pr/create').send(mutationBody()).expect(422);
    expect(replay.body.code).toBe('SOURCE_CONTROL_MUTATION_FAILED');
    expect(setup.calls.resolveCreate).toHaveBeenCalledOnce();
    expect(setup.calls.create).toHaveBeenCalledOnce();
  });

  it('invalidates only the exact acting account after a mutation 401', async () => {
    const setup = canonicalMutationOptions();
    setup.calls.create.mockRejectedValue(Object.assign(new Error('unauthorized'), { status: 401 }));
    await request(appWith(setup.options)).post('/api/source-control/gitlab/pr/create').send(mutationBody()).expect(401);
    expect(setup.options.store.markAccountInvalid).toHaveBeenCalledWith(origin, setup.account.id, 'unauthorized');
  });
  it('returns 501 for bound reads when binding validation is unavailable', async () => {
    const app = appWith({ store: makeStore(), validateReadContext: undefined });

    await request(app).get('/api/source-control/gitlab/pulls/list')
      .query({ instance: origin, directory: '/repo' }).expect(501);
    await request(app).get('/api/source-control/gitlab/pulls/context')
      .query({ instance: origin, directory: '/repo', number: 1 }).expect(501);
    await request(app).get('/api/source-control/gitlab/issues/list')
      .query({ instance: origin, directory: '/repo' }).expect(501);
    await request(app).get('/api/source-control/gitlab/issues/get')
      .query({ instance: origin, directory: '/repo', number: 1 }).expect(501);
    await request(app).get('/api/source-control/gitlab/issues/comments')
      .query({ instance: origin, directory: '/repo', number: 1 }).expect(501);
    await request(app).get('/api/source-control/gitlab/repo/upstream')
      .query({ instance: origin, directory: '/repo' }).expect(501);
    await request(app).get('/api/source-control/gitlab/repo/branches')
      .query({ instance: origin, directory: '/repo', owner: 'team', repo: 'repo' }).expect(501);
  });

  it('uses matching bound context and rejects it before provider creation when stale', async () => {
    const account = { id: `${origin}#9`, token: 'stored', user: { id: 9, login: 'user' }, source: 'pat', scope: '' };
    const store = makeStore(account);
    const changeRequestStatus = vi.fn(async () => ({
      identity: { provider: 'gitlab', instance: origin }, project: null, branch: 'feature', changeRequest: null,
    }));
    const createResourceService = vi.fn(() => ({ changeRequestStatus }));
    const query = {
      instance: origin, directory: '/repo', branch: 'feature', repositoryId: 'repo_one',
      bindingRevision: 3, accountId: account.id, primaryRemote: 'upstream',
    };
    const app = appWith({ store, createResourceService, validateReadContext: async (context) => ({ ...context, accountId: account.id, primaryRemote: 'upstream' }) });

    await request(app).get('/api/source-control/gitlab/pr/status').query(query).expect(200);
    expect(changeRequestStatus).toHaveBeenCalledWith('/repo', 'feature', 'upstream');

    for (const code of [
      'SOURCE_CONTROL_BINDING_REPOSITORY_MISMATCH',
      'SOURCE_CONTROL_BINDING_STALE',
      'SOURCE_CONTROL_BINDING_CONTEXT_MISMATCH',
      'SOURCE_CONTROL_BINDING_MISSING',
    ]) {
      const rejectedProvider = vi.fn();
      const failure = Object.assign(new Error('binding rejected'), { code, status: 409 });
      await request(appWith({ store, createResourceService: rejectedProvider, validateReadContext: async () => { throw failure; } }))
        .get('/api/source-control/gitlab/pr/status').query(query).expect(409);
      expect(rejectedProvider).not.toHaveBeenCalled();
    }
  });

  it('validates pull reads before provider creation and preserves binding errors', async () => {
    const account = { id: `${origin}#9`, token: 'stored', user: { id: 9, login: 'user' }, source: 'pat', scope: '' };
    const current = { repositoryId: 'repo_one', bindingRevision: 5, binding: { status: 'bound' } };
    const failure = Object.assign(new Error('binding changed'), { code: 'SOURCE_CONTROL_BINDING_STALE', status: 409, current });
    const createResourceService = vi.fn();

    for (const suffix of ['list', 'context']) {
      const response = await request(appWith({
        store: makeStore(account),
        createResourceService,
        validateReadContext: vi.fn(async () => { throw failure; }),
      })).get(`/api/source-control/gitlab/pulls/${suffix}`).query({
        instance: origin,
        directory: '/repo',
        number: 5,
        repositoryId: 'repo_one',
        bindingRevision: 2,
        accountId: account.id,
        primaryRemote: 'upstream',
      }).expect(409);
      expect(response.body.code).toBe('SOURCE_CONTROL_BINDING_STALE');
      expect(response.body.current).toEqual(current);
    }

    expect(createResourceService).not.toHaveBeenCalled();
  });

  it('uses the exact bound account and primary remote for pull reads', async () => {
    const active = { id: `${origin}#1`, token: 'active-token', user: { id: 1 }, source: 'pat', scope: '', status: 'valid' };
    const bound = { id: `${origin}#2`, token: 'bound-token', user: { id: 2 }, source: 'oauth', scope: 'api', status: 'valid' };
    const store = makeStore(active);
    store.readInstance.mockResolvedValue({ activeAccountId: active.id, accounts: [active, bound], cliDisabled: false, cliActive: false });
    store.readAccount.mockImplementation(async (_instance, accountId) => accountId === bound.id ? bound : null);
    const createClient = vi.fn(() => ({}));
    const listChangeRequests = vi.fn(async () => ({ items: [], page: 1, hasMore: false }));
    const changeRequestContext = vi.fn(async () => ({ changeRequest: { number: 5 } }));
    const createResourceService = vi.fn(() => ({ listChangeRequests, changeRequestContext }));
    const validateReadContext = vi.fn(async (context) => ({ ...context, accountId: bound.id, primaryRemote: 'upstream' }));
    const app = appWith({ store, createClient, createResourceService, validateReadContext });
    const query = {
      instance: origin,
      directory: '/repo',
      repositoryId: 'repo_one',
      bindingRevision: 3,
      accountId: bound.id,
      primaryRemote: 'upstream',
    };

    await request(app).get('/api/source-control/gitlab/pulls/list').query(query).expect(200);
    await request(app).get('/api/source-control/gitlab/pulls/context')
      .query({ ...query, number: 5, owner: 'team', repo: 'repo', diff: '1', checkDetails: '1' }).expect(200);

    expect(createClient).toHaveBeenCalledTimes(2);
    expect(createClient).toHaveBeenCalledWith({ origin, token: 'bound-token', tokenType: 'oauth' });
    expect(listChangeRequests).toHaveBeenCalledWith('/repo', { page: 1, query: undefined, remote: 'upstream' });
    expect(changeRequestContext).toHaveBeenCalledWith('/repo', 5, {
      includeDiff: true,
      includeCIDetails: true,
      project: { owner: 'team', name: 'repo' },
      remote: 'upstream',
      constrainToPrimary: true,
    });
  });

  it('validates issue and repository reads before credentials and preserves binding errors', async () => {
    const account = { id: `${origin}#9`, token: 'stored', user: { id: 9 }, source: 'pat', scope: '' };
    const failure = Object.assign(new Error('binding changed'), { code: 'SOURCE_CONTROL_BINDING_STALE', status: 409 });
    const routes = [
      ['/api/source-control/gitlab/issues/list', {}],
      ['/api/source-control/gitlab/issues/get', { number: 3 }],
      ['/api/source-control/gitlab/issues/comments', { number: 3 }],
      ['/api/source-control/gitlab/repo/upstream', {}],
      ['/api/source-control/gitlab/repo/branches', { owner: 'team', repo: 'repo' }],
    ];

    for (const [route, extra] of routes) {
      const store = makeStore(account);
      const createResourceService = vi.fn();
      const response = await request(appWith({
        store,
        createResourceService,
        validateReadContext: vi.fn(async () => { throw failure; }),
      })).get(route).query({
        instance: origin,
        directory: '/repo',
        repositoryId: 'repo_one',
        bindingRevision: 4,
        accountId: account.id,
        primaryRemote: 'upstream',
        ...extra,
      }).expect(409);

      expect(response.body.code).toBe('SOURCE_CONTROL_BINDING_STALE');
      expect(store.readInstance).not.toHaveBeenCalled();
      expect(createResourceService).not.toHaveBeenCalled();
    }
  });

  it('uses the exact bound account and primary remote for issue and repository reads', async () => {
    const active = { id: `${origin}#1`, token: 'active-token', user: { id: 1 }, source: 'pat', scope: '', status: 'valid' };
    const bound = { id: `${origin}#2`, token: 'bound-token', user: { id: 2 }, source: 'oauth', scope: 'api', status: 'valid' };
    const store = makeStore(active);
    store.readInstance.mockResolvedValue({ activeAccountId: active.id, accounts: [active, bound], cliDisabled: false, cliActive: false });
    store.readAccount.mockImplementation(async (_instance, accountId) => accountId === bound.id ? bound : null);
    const createClient = vi.fn(() => ({}));
    const listIssues = vi.fn(async () => ({ items: [], page: 2, hasMore: false }));
    const getIssue = vi.fn(async () => ({ number: 3 }));
    const issueComments = vi.fn(async () => []);
    const projectUpstream = vi.fn(async () => ({ isFork: false, upstream: null }));
    const projectBranches = vi.fn(async () => ['main']);
    const createResourceService = vi.fn(() => ({ listIssues, getIssue, issueComments, projectUpstream, projectBranches }));
    const validateReadContext = vi.fn(async (context) => ({ ...context, accountId: bound.id, primaryRemote: 'upstream' }));
    const app = appWith({ store, createClient, createResourceService, validateReadContext });
    const query = {
      instance: origin,
      directory: '/repo',
      repositoryId: 'repo_one',
      bindingRevision: 4,
      accountId: bound.id,
      primaryRemote: 'upstream',
    };

    await request(app).get('/api/source-control/gitlab/issues/list').query({ ...query, page: 2, query: 'bug' }).expect(200);
    await request(app).get('/api/source-control/gitlab/issues/get').query({ ...query, number: 3, owner: 'team', repo: 'repo' }).expect(200);
    await request(app).get('/api/source-control/gitlab/issues/comments').query({ ...query, number: 3, owner: 'team', repo: 'repo' }).expect(200);
    await request(app).get('/api/source-control/gitlab/repo/upstream').query(query).expect(200);
    await request(app).get('/api/source-control/gitlab/repo/branches').query({ ...query, owner: 'team', repo: 'repo' }).expect(200);

    expect(createClient).toHaveBeenCalledTimes(5);
    expect(createClient).toHaveBeenCalledWith({ origin, token: 'bound-token', tokenType: 'oauth' });
    expect(createResourceService).toHaveBeenCalledWith(expect.objectContaining({ canonicalReads: true }));
    expect(listIssues).toHaveBeenCalledWith('/repo', { page: 2, query: 'bug', remote: 'upstream' });
    expect(getIssue).toHaveBeenCalledWith('/repo', 3, { owner: 'team', name: 'repo' }, 'upstream');
    expect(issueComments).toHaveBeenCalledWith('/repo', 3, { owner: 'team', name: 'repo' }, 'upstream');
    expect(projectUpstream).toHaveBeenCalledWith('/repo', 'upstream');
    expect(projectBranches).toHaveBeenCalledWith('/repo', { owner: 'team', name: 'repo' }, 'upstream');
    expect(validateReadContext).toHaveBeenCalledWith(expect.objectContaining({
      directory: '/repo', repositoryId: 'repo_one', provider: 'gitlab', instance: origin,
      accountId: bound.id, bindingRevision: 4, primaryRemote: 'upstream',
    }));
  });

  it('rejects invalid canonical issue selectors before binding or provider work', async () => {
    const validateReadContext = vi.fn();
    const createClient = vi.fn();
    const app = appWith({ store: makeStore(), validateReadContext, createClient });
    const base = { instance: origin, directory: '/repo' };
    const invalidSelectors = [
      { number: '3junk' },
      { number: '3.5' },
      { number: '3', owner: 'team' },
      { number: '3', repo: 'repo' },
    ];

    for (const suffix of ['get', 'comments']) {
      for (const selector of invalidSelectors) {
        await request(app).get(`/api/source-control/gitlab/issues/${suffix}`)
          .query({ ...base, ...selector }).expect(400);
      }
    }
    await request(app).get('/api/source-control/gitlab/repo/branches')
      .query({ ...base, owner: 'team' }).expect(400);
    await request(app).get('/api/source-control/gitlab/pulls/context')
      .query({ ...base, number: 3, repo: 'repo' }).expect(400);

    expect(validateReadContext).not.toHaveBeenCalled();
    expect(createClient).not.toHaveBeenCalled();
  });

  it('propagates fork-parent 401 and invalidates only the exact GitLab account', async () => {
    const account = { id: `${origin}#9`, token: 'stored', user: { id: 9 }, source: 'pat', scope: '', status: 'valid' };
    const store = makeStore(account);
    const onAccountInvalidated = vi.fn();
    const unauthorized = Object.assign(new Error('unauthorized parent'), { status: 401 });
    const app = appWith({
      store,
      onAccountInvalidated,
      resolveProjects: async () => ({ projects: [{ projectPath: 'me/repo', remoteName: 'bound' }] }),
      createClient: () => ({
        Projects: { show: vi.fn(async (id) => Number(id) === 2 ? Promise.reject(unauthorized) : {
          id: 1,
          path_with_namespace: 'me/repo',
          web_url: `${origin}/me/repo`,
          forked_from_project: { id: 2 },
        }) },
        Issues: { show: vi.fn() },
      }),
    });

    await request(app).get('/api/source-control/gitlab/issues/get').query({
      instance: origin,
      directory: '/repo',
      number: 3,
      owner: 'team',
      repo: 'repo',
      repositoryId: 'repo_one',
      bindingRevision: 1,
      accountId: account.id,
      primaryRemote: 'bound',
    }).expect(401);

    expect(store.markAccountInvalid).toHaveBeenCalledWith(origin, account.id, 'unauthorized');
    expect(onAccountInvalidated).toHaveBeenCalledWith({ provider: 'gitlab', instance: origin, accountId: account.id });
  });

  it('names a refused token so the interface can say what to fix', async () => {
    const store = makeStore();
    const fetch = vi.fn(async () => new Response('unauthorized', { status: 401 }));
    const app = appWith({ store, fetch });

    const response = await request(app).post('/api/source-control/gitlab/auth/token')
      .query({ instance: origin }).send({ token: 'not-a-token' }).expect(401);

    // Without the code every failure reads the same, and a person cannot tell
    // a bad token from a server they cannot reach.
    expect(response.body.code).toBe('INVALID_TOKEN');
    expect(store.setAccount).not.toHaveBeenCalled();
  });

  it('verifies PATs before persistence and uses them for resource operations', async () => {
    const store = makeStore();
    const fetch = vi.fn(async () => userResponse());
    const createClient = vi.fn(() => ({
      Projects: { show: vi.fn(async () => ({ id: 1, path_with_namespace: 'team/repo', web_url: `${origin}/team/repo` })) },
      Issues: { all: vi.fn(async () => [{ iid: 3, title: 'Bug', web_url: `${origin}/team/repo/-/issues/3`, state: 'opened' }]) },
    }));
    const onAccountConnected = vi.fn();
    const app = appWith({
      store,
      fetch,
      createClient,
      onAccountConnected,
      resolveProjects: async () => ({ branch: 'main', tracking: '', projects: [{ projectPath: 'team/repo', remoteName: 'origin' }] }),
    });
    await request(app).post('/api/source-control/gitlab/auth/token').query({ instance: origin }).send({ token: 'pat-token' }).expect(200);
    expect(fetch).toHaveBeenCalledWith(`${origin}/api/v4/user`, expect.objectContaining({ headers: expect.objectContaining({ Authorization: 'Bearer pat-token' }) }));
    expect(store.setAccount).toHaveBeenCalledWith(origin, expect.objectContaining({ token: 'pat-token', source: 'pat', user: expect.objectContaining({ id: 9 }) }));
    // A connected account announces itself so an identity can be made from it.
    expect(onAccountConnected).toHaveBeenCalledWith({
      account: { provider: 'gitlab', instance: origin, accountId: `${origin}#9` },
      user: expect.objectContaining({ id: 9 }),
      renews: [],
    });
    const response = await request(app).get('/api/source-control/gitlab/issues/list')
      .query({ instance: origin, directory: '/repo' }).expect(200);
    expect(response.body).toMatchObject({ items: [{ number: 3, provider: 'gitlab', instance: origin }], hasMore: false });
    expect(createClient).toHaveBeenCalledWith({ origin, token: 'pat-token', tokenType: 'token' });
  });

  it('reports glab available only after its host-scoped token verifies', async () => {
    const fetch = vi.fn()
      .mockResolvedValueOnce(Response.json({ version: '17.9.0' }))
      .mockResolvedValueOnce(Response.json({ device_code: 'device' }))
      .mockResolvedValueOnce(Response.json({}, { status: 401 }));
    const response = await request(appWith({ store: makeStore(), fetch, execFile: async () => ({ stdout: 'invalid-cli-token' }), readSettings: async () => ({ gitlabClientId: 'client' }) }))
      .get('/api/source-control/gitlab/capabilities').query({ instance: origin }).expect(200);
    expect(response.body.authenticationMethods).toMatchObject({ device: { available: true }, pat: { available: true }, cli: { available: false, reason: 'cli-unavailable' } });
    expect(response.body).toMatchObject({
      projects: true, issues: true, changeRequests: true, draftChangeRequests: true,
      mergeChangeRequests: true, mergeMethods: ['merge', 'squash'], ci: true,
    });
    expect(fetch.mock.calls.map(([url]) => url)).toEqual([
      `${origin}/api/v4/version`, `${origin}/oauth/authorize_device`, `${origin}/api/v4/user`,
    ]);
  });

  it('invalidates only the rejected account but preserves it on network failure', async () => {
    const account = { id: `${origin}#9`, token: 'stored', user: { id: 9, login: 'user' }, source: 'pat', scope: '' };
    const invalidStore = makeStore(account);
    const onAccountInvalidated = vi.fn();
    const invalidApp = appWith({ store: invalidStore, fetch: vi.fn(async () => Response.json({}, { status: 401 })), onAccountInvalidated });
    const invalid = await request(invalidApp).get('/api/source-control/gitlab/auth/status').query({ instance: origin }).expect(200);
    expect(invalidStore.markAccountInvalid).toHaveBeenCalledWith(origin, account.id, 'unauthorized');
    expect(invalidStore.removeAccount).not.toHaveBeenCalled();
    expect(onAccountInvalidated).toHaveBeenCalledWith({ provider: 'gitlab', instance: origin, accountId: account.id });
    expect(invalid.body.accounts).toEqual([expect.objectContaining({ id: account.id, status: 'invalid' })]);

    const networkStore = makeStore(account);
    const networkApp = appWith({ store: networkStore, fetch: vi.fn(async () => { throw Object.assign(new Error('offline'), { code: 'ENOTFOUND' }); }) });
    const response = await request(networkApp).get('/api/source-control/gitlab/auth/status').query({ instance: origin }).expect(200);
    expect(response.body).toMatchObject({ status: 'unreachable', connected: false });
    expect(networkStore.markAccountInvalid).not.toHaveBeenCalled();
  });

  it('preserves an account when the auth verification endpoint returns 403', async () => {
    const account = { id: `${origin}#9`, token: 'stored', user: { id: 9, login: 'user' }, source: 'pat', scope: '' };
    const store = makeStore(account);
    const onAccountInvalidated = vi.fn();
    const app = appWith({ store, fetch: vi.fn(async () => Response.json({}, { status: 403 })), onAccountInvalidated });

    const response = await request(app).get('/api/source-control/gitlab/auth/status').query({ instance: origin }).expect(200);

    expect(response.body).toMatchObject({ status: 'unavailable', connected: false });
    expect(store.markAccountInvalid).not.toHaveBeenCalled();
    expect(onAccountInvalidated).not.toHaveBeenCalled();
  });

  it('uses an exact non-active account without falling back to the active account', async () => {
    const active = { id: `${origin}#1`, token: 'active-token', user: { id: 1, login: 'active' }, source: 'pat', scope: '', status: 'valid' };
    const requested = { id: `${origin}#2`, token: 'requested-token', user: { id: 2, login: 'requested' }, source: 'oauth', scope: 'api', status: 'valid' };
    const store = makeStore(active);
    store.readInstance.mockResolvedValue({ activeAccountId: active.id, accounts: [active, requested], cliDisabled: false, cliActive: false });
    store.readAccount.mockImplementation(async (_instance, accountId) => accountId === requested.id ? requested : null);
    const createClient = vi.fn(() => ({
      Projects: { show: vi.fn(async () => ({ id: 1, path_with_namespace: 'team/repo', web_url: `${origin}/team/repo` })) },
      Issues: { all: vi.fn(async () => []) },
    }));
    const app = appWith({
      store,
      createClient,
      resolveProjects: async () => ({ branch: 'main', tracking: '', projects: [{ projectPath: 'team/repo', remoteName: 'origin' }] }),
    });

    await request(app).get('/api/source-control/gitlab/issues/list')
      .query({ instance: origin, directory: '/repo', accountId: requested.id }).expect(200);

    expect(createClient).toHaveBeenCalledWith({ origin, token: 'requested-token', tokenType: 'oauth' });
    await request(app).get('/api/source-control/gitlab/issues/list')
      .query({ instance: origin, directory: '/repo', accountId: `${origin}#999` }).expect(401);
    expect(createClient).toHaveBeenCalledTimes(1);
  });

  it('reconciles the exact account on resource 401 but not on 403 or network failure', async () => {
    const account = { id: `${origin}#9`, token: 'stored', user: { id: 9, login: 'user' }, source: 'pat', scope: '', status: 'valid' };
    const cases = [
      { error: Object.assign(new Error('provider rejected'), { status: 401 }), expectedStatus: 401, invalidated: true },
      { error: Object.assign(new Error('provider rejected'), { status: 403 }), expectedStatus: 403, invalidated: false },
      { error: Object.assign(new Error('offline'), { code: 'ENOTFOUND' }), expectedStatus: 502, invalidated: false },
    ];
    for (const testCase of cases) {
      const store = makeStore(account);
      const onAccountInvalidated = vi.fn();
      const app = appWith({
        store,
        onAccountInvalidated,
        createClient: () => ({
          Projects: { show: vi.fn(async () => ({ id: 1, path_with_namespace: 'team/repo', web_url: `${origin}/team/repo` })) },
          Issues: { all: vi.fn(async () => { throw testCase.error; }) },
        }),
        resolveProjects: async () => ({ branch: 'main', tracking: '', projects: [{ projectPath: 'team/repo', remoteName: 'origin' }] }),
      });
      await request(app).get('/api/source-control/gitlab/issues/list')
        .query({ instance: origin, directory: '/repo', accountId: account.id }).expect(testCase.expectedStatus);
      if (testCase.invalidated) {
        expect(store.markAccountInvalid).toHaveBeenCalledWith(origin, account.id, 'unauthorized');
        expect(onAccountInvalidated).toHaveBeenCalledWith({ provider: 'gitlab', instance: origin, accountId: account.id });
      } else {
        expect(store.markAccountInvalid).not.toHaveBeenCalled();
        expect(onAccountInvalidated).not.toHaveBeenCalled();
      }
    }
  });

  it('lists accounts without tokens and reconciles exact removal', async () => {
    const account = { id: `${origin}#9`, token: 'stored-secret', user: { id: 9, login: 'user' }, source: 'pat', scope: '', status: 'valid' };
    const store = makeStore(account);
    const onAccountRemoved = vi.fn();
    const app = appWith({ store, onAccountRemoved });

    const inventory = await request(app).get('/api/source-control/gitlab/auth/accounts').query({ instance: origin }).expect(200);
    expect(JSON.stringify(inventory.body)).not.toContain('stored-secret');
    expect(inventory.body.accounts).toEqual([expect.objectContaining({ id: account.id, status: 'valid' })]);

    await request(app).delete('/api/source-control/gitlab/auth').query({ instance: origin, accountId: account.id }).expect(200);
    expect(onAccountRemoved).toHaveBeenCalledWith({ provider: 'gitlab', instance: origin, accountId: account.id });
    expect(store.removeAccount).toHaveBeenCalledWith(origin, account.id);
  });

  it('requires exact account removal', async () => {
    const account = { id: `${origin}#9`, token: 'stored', user: { id: 9 }, source: 'pat', status: 'valid' };
    const store = makeStore(account);
    const onAccountRemoved = vi.fn();
    const app = appWith({ store, onAccountRemoved });

    await request(app).delete('/api/source-control/gitlab/auth').query({ instance: origin })
      .expect(400, { error: 'accountId is required' });
    await request(app).delete('/api/source-control/gitlab/auth').query({ instance: origin, accountId: ` ${account.id} ` })
      .expect(400, { error: 'accountId is required' });
    expect(store.removeAccount).not.toHaveBeenCalled();
    expect(onAccountRemoved).not.toHaveBeenCalled();

  });

  it('returns pending and slow-down device states without persisting', async () => {
    for (const state of ['authorization_pending', 'slow_down']) {
      const store = makeStore();
      const fetch = vi.fn(async (url) => url.endsWith('/oauth/token')
        ? Response.json({ error: state }, { status: 400 })
        : Response.json({ device_code: 'device', user_code: 'CODE', verification_uri: `${origin}/device`, expires_in: 300, interval: 5 }));
      const app = appWith({ store, fetch, readSettings: async () => ({ gitlabClientId: 'client' }) });
      const started = await request(app).post('/api/source-control/gitlab/auth/start').query({ instance: origin }).send({}).expect(200);
      const response = await request(app)
        .post('/api/source-control/gitlab/auth/complete').query({ instance: origin }).send({ flowId: started.body.flowId }).expect(200);
      expect(response.body).toEqual({ connected: false, status: state });
      expect(store.setAccount).not.toHaveBeenCalled();
    }
  });

  it('starts one API-scoped device authorization request', async () => {
    const fetch = vi.fn(async () => Response.json({
      device_code: 'raw-device-secret', user_code: 'ABCD1234', verification_uri: `${origin}/oauth/device`,
      verification_uri_complete: `${origin}/oauth/device?user_code=ABCD1234`, expires_in: 300, interval: 5,
    }));
    const response = await request(appWith({ store: makeStore(), fetch, readSettings: async () => ({ gitlabClientId: 'client' }) }))
      .post('/api/source-control/gitlab/auth/start').query({ instance: origin }).send({}).expect(200);

    expect(response.body).toMatchObject({ flowId: expect.stringMatching(/^oauth_/), userCode: 'ABCD1234' });
    expect(JSON.stringify(response.body)).not.toContain('raw-device-secret');
    expect(response.headers['cache-control']).toBe('no-store');
    expect(fetch).toHaveBeenCalledTimes(1);
    expect(fetch).toHaveBeenCalledWith(`${origin}/oauth/authorize_device`, expect.objectContaining({
      body: new URLSearchParams({ client_id: 'client', scope: 'api' }),
    }));
  });

  it('verifies and persists a successful device token', async () => {
    const store = makeStore();
    const fetch = vi.fn()
      .mockResolvedValueOnce(Response.json({
        device_code: 'device', user_code: 'CODE', verification_uri: `${origin}/device`, expires_in: 300, interval: 5,
      }))
      .mockResolvedValueOnce(Response.json({ access_token: 'oauth-token', scope: 'api' }))
      .mockResolvedValueOnce(userResponse());
    const app = appWith({ store, fetch, readSettings: async () => ({ gitlabClientId: 'client' }) });
    const started = await request(app).post('/api/source-control/gitlab/auth/start').query({ instance: origin }).send({}).expect(200);
    const response = await request(app)
      .post('/api/source-control/gitlab/auth/complete').query({ instance: origin }).send({ flowId: started.body.flowId }).expect(200);
    expect(response.body).toMatchObject({ connected: true, user: { id: 9 }, scope: 'api' });
    expect(response.headers['cache-control']).toBe('no-store');
    expect(store.setAccount).toHaveBeenCalledWith(origin, expect.objectContaining({ token: 'oauth-token', source: 'oauth', scope: 'api' }));
    await request(app).post('/api/source-control/gitlab/auth/complete').query({ instance: origin })
      .send({ flowId: started.body.flowId }).expect(410);
  });

  it('rejects a device flow on a different instance before token exchange', async () => {
    const fetch = vi.fn(async () => Response.json({
      device_code: 'device', user_code: 'CODE', verification_uri: `${origin}/device`, expires_in: 300, interval: 5,
    }));
    const app = appWith({ store: makeStore(), fetch, readSettings: async () => ({ gitlabClientId: 'client' }) });
    const started = await request(app).post('/api/source-control/gitlab/auth/start').query({ instance: origin }).send({}).expect(200);

    await request(app).post('/api/source-control/gitlab/auth/complete').query({ instance: 'https://other.example.com' })
      .send({ flowId: started.body.flowId }).expect(410);

    expect(fetch).toHaveBeenCalledTimes(1);
  });

  it('activates an ephemeral glab account without persisting its token', async () => {
    const store = makeStore({ id: `${origin}#1`, token: 'stored', user: { id: 1, login: 'stored' }, source: 'pat', scope: '' });
    const app = appWith({ store, execFile: async () => ({ stdout: 'cli-token\n' }), fetch: vi.fn(async () => userResponse()) });
    const response = await request(app).post('/api/source-control/gitlab/auth/activate').query({ instance: origin })
      .send({ accountId: `${origin}#cli:9` }).expect(200);
    expect(store.setCliActive).toHaveBeenCalledWith(origin, true);
    expect(response.body).toMatchObject({ connected: true, user: { id: 9 }, cli: { active: true } });
    expect(store.setAccount).not.toHaveBeenCalled();
  });

  it('rejects and reconciles a changed exact glab identity', async () => {
    const onAccountInvalidated = vi.fn();
    const app = appWith({
      store: makeStore(),
      onAccountInvalidated,
      execFile: async () => ({ stdout: 'cli-token\n' }),
      fetch: vi.fn(async () => userResponse()),
    });
    const previousAccountId = `${origin}#cli:8`;

    await request(app).get('/api/source-control/gitlab/issues/list')
      .query({ instance: origin, directory: '/repo', accountId: previousAccountId }).expect(401);

    expect(onAccountInvalidated).toHaveBeenCalledWith({ provider: 'gitlab', instance: origin, accountId: previousAccountId });
  });

  it('can re-enable a disabled glab credential', async () => {
    const store = makeStore();
    await store.setCliDisabled(origin, true);
    const app = appWith({ store, execFile: async () => ({ stdout: 'cli-token\n' }), fetch: vi.fn(async () => userResponse()) });

    const disabled = await request(app).get('/api/source-control/gitlab/auth/status').query({ instance: origin }).expect(200);
    expect(disabled.body).toMatchObject({ connected: false, cli: { available: false, disabled: true } });

    await request(app).post('/api/source-control/gitlab/auth/cli').query({ instance: origin }).send({ disabled: false }).expect(200);
    const enabled = await request(app).get('/api/source-control/gitlab/auth/status').query({ instance: origin }).expect(200);
    expect(enabled.body).toMatchObject({ connected: true, cli: { available: true, disabled: false } });
  });
});
