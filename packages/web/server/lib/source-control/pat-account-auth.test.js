import { describe, expect, it, vi } from 'vitest';
import { createPatAccountAuth } from './pat-account-auth.js';

const ORIGIN = 'https://forge.example.com';
const descriptor = { id: 'ext-forge', label: 'Forge' };

/** An in-memory origin section with the auth store's surface. */
function fakeStore() {
  const instances = new Map();
  let next = 0;
  const instanceOf = (origin) => instances.get(origin) ?? { activeAccountId: null, accounts: [] };
  return {
    listInstances: async () => [...instances.keys()],
    listAccounts: async (origin) => instanceOf(origin).accounts,
    readInstance: async (origin) => structuredClone(instanceOf(origin)),
    readAccount: async (origin, id, revision) => instanceOf(origin).accounts.find((account) => account.id === id
      && account.status === 'valid' && (revision === undefined || account.credentialRevision === revision)) ?? null,
    setAccount: async (origin, { token, user, source }) => {
      next += 1;
      const id = `occred:v1:ext-forge:${next}:r1`;
      const account = {
        id, credentialId: id, credentialRevision: 1, providerUserId: `${origin}#${user.id}`,
        token, user, source, scope: '', status: 'valid',
      };
      const instance = instanceOf(origin);
      instances.set(origin, { activeAccountId: id, accounts: [...instance.accounts, account] });
      return account;
    },
    activate: async (origin, id) => {
      const instance = instanceOf(origin);
      if (!instance.accounts.some((account) => account.id === id && account.status === 'valid')) return false;
      instance.activeAccountId = id;
      return true;
    },
    removeAccount: async (origin, id) => {
      const instance = instanceOf(origin);
      const accounts = instance.accounts.filter((account) => account.id !== id);
      if (accounts.length === instance.accounts.length) return false;
      instances.set(origin, { activeAccountId: accounts[0]?.id ?? null, accounts });
      return true;
    },
    markAccountInvalid: async (origin, id) => {
      const account = instanceOf(origin).accounts.find((candidate) => candidate.id === id);
      if (!account) return false;
      account.status = 'invalid';
      return true;
    },
  };
}

const refused = () => Object.assign(new Error('refused'), { kind: 'invalid-token' });

function setup({ verify, probe } = {}) {
  const store = fakeStore();
  const events = { connected: vi.fn(), invalidated: vi.fn(), removed: vi.fn() };
  const accounts = createPatAccountAuth({
    descriptor,
    store,
    events,
    verify: verify ?? vi.fn(async (_origin, token) => ({ id: token === 'pat-2' ? 8 : 7, login: token === 'pat-2' ? 'bob' : 'alice' })),
    probe: probe ?? vi.fn(async () => ({ supported: true, version: '1.0' })),
    classifyFailure: (error) => error?.kind ?? 'provider-error',
  });
  return { store, events, accounts, auth: accounts.auth };
}

describe('PAT account auth', () => {
  it('connects a verified token, announces it and reports it connected', async () => {
    const { auth, events } = setup();

    await expect(auth.connectToken({ instance: ORIGIN, token: 'pat-1' })).resolves.toEqual({ connected: true, user: { id: 7, login: 'alice' } });

    expect(events.connected).toHaveBeenCalledWith(expect.objectContaining({
      account: expect.objectContaining({ provider: 'ext-forge', instance: ORIGIN }),
      credential: { credentialRevision: 1, providerUserId: `${ORIGIN}#7` },
      renews: [],
    }));
    await expect(auth.status({ instance: ORIGIN })).resolves.toMatchObject({
      provider: 'ext-forge', status: 'connected', connected: true, user: { login: 'alice', provider: 'ext-forge', instance: ORIGIN },
      accounts: [{ current: true, providerUserStatus: 'available', status: 'valid', user: { provider: 'ext-forge' } }],
    });
  });

  it('renews the earlier credential of the same user when it connects again', async () => {
    const { auth, events } = setup();
    await auth.connectToken({ instance: ORIGIN, token: 'pat-1' });
    const first = await auth.readCurrentAccountId({ instance: ORIGIN });
    await auth.connectToken({ instance: ORIGIN, token: 'pat-1' });

    expect(events.connected).toHaveBeenLastCalledWith(expect.objectContaining({
      renews: [{ provider: 'ext-forge', instance: ORIGIN, accountId: first }],
    }));
  });

  it('refuses an unsupported instance with the provider message and stores nothing', async () => {
    const { auth, store } = setup({ probe: async () => ({ supported: false, version: '0.9', message: 'Forge 0.9 is too old' }) });

    await expect(auth.connectToken({ instance: ORIGIN, token: 'pat-1' })).rejects.toMatchObject({
      sourceControlResponse: { status: 400, body: { error: 'Forge 0.9 is too old', code: 'UNSUPPORTED_PROVIDER_VERSION' } },
    });
    expect(await store.listInstances()).toEqual([]);
    await expect(auth.capabilities({ instance: ORIGIN })).resolves.toEqual({
      authentication: false,
      authenticationMethods: {
        device: { available: false, reason: 'unsupported' },
        pat: { available: false, reason: 'unsupported' },
        cli: { available: false, reason: 'unsupported' },
      },
    });
  });

  it('words an unsupported instance itself when the probe gives no message', async () => {
    const { auth } = setup({ probe: async () => ({ supported: false }) });
    await expect(auth.connectToken({ instance: ORIGIN, token: 'pat-1' })).rejects.toMatchObject({
      sourceControlResponse: { body: { error: 'Forge is not supported' } },
    });
  });

  it('writes the active account off when the forge refuses its token, and reports other failures as they are', async () => {
    let failure = null;
    const { auth, events, store } = setup({
      verify: async () => {
        if (failure) throw failure;
        return { id: 7, login: 'alice' };
      },
    });
    await auth.connectToken({ instance: ORIGIN, token: 'pat-1' });

    failure = Object.assign(new Error('down'), { kind: 'unreachable' });
    await expect(auth.status({ instance: ORIGIN })).resolves.toMatchObject({ status: 'unreachable', connected: false, message: 'down' });
    expect(events.invalidated).not.toHaveBeenCalled();

    failure = refused();
    await expect(auth.status({ instance: ORIGIN })).resolves.toMatchObject({ status: 'disconnected', connected: false });
    expect(events.invalidated).toHaveBeenCalledWith(expect.objectContaining({ provider: 'ext-forge', instance: ORIGIN }));
    expect((await store.listAccounts(ORIGIN))[0].status).toBe('invalid');
    await expect(auth.listConnectedAccounts()).resolves.toEqual([]);
  });

  it('keeps the token out of the session and hands it back only for that session', async () => {
    const { auth, accounts } = setup();
    await auth.connectToken({ instance: ORIGIN, token: 'pat-1' });

    const session = await auth.resolveAccount({ instance: ORIGIN });

    expect(Object.isFrozen(session)).toBe(true);
    expect(JSON.stringify(session)).not.toContain('pat-1');
    expect(session).toMatchObject({ instance: ORIGIN, providerUserId: `${ORIGIN}#7`, secretKind: 'pat', persisted: true });
    expect(accounts.tokenFor(session)).toBe('pat-1');
    expect(accounts.tokenFor({ ...session })).toBeUndefined();
  });

  it('answers 401 naming the exact account when it does not resolve', async () => {
    const { auth } = setup();
    await expect(auth.resolveAccount({ instance: ORIGIN })).rejects.toMatchObject({
      status: 401, sourceControlAccountUnavailable: true, message: 'Forge is not connected',
    });
    await expect(auth.resolveAccount({ instance: ORIGIN, accountId: 'gone' })).rejects.toMatchObject({
      sourceControlIdentity: { provider: 'ext-forge', instance: ORIGIN, accountId: 'gone' },
    });
  });

  it('activates and removes accounts, announcing the removal first', async () => {
    const { auth, events } = setup();
    await auth.connectToken({ instance: ORIGIN, token: 'pat-1' });
    const alice = await auth.readCurrentAccountId({ instance: ORIGIN });
    await auth.connectToken({ instance: ORIGIN, token: 'pat-2' });

    await expect(auth.activate({ instance: ORIGIN, accountId: alice })).resolves.toMatchObject({ user: { login: 'alice' } });
    await expect(auth.activate({ instance: ORIGIN, accountId: 'nope' })).rejects.toMatchObject({
      sourceControlResponse: { status: 404, body: { error: 'Forge account not found' } },
    });
    await expect(auth.accounts({ instance: ORIGIN })).resolves.toHaveLength(2);

    await expect(auth.remove({ instance: ORIGIN, accountId: 'nope' })).resolves.toEqual({ removed: false });
    await expect(auth.remove({ instance: ORIGIN, accountId: alice })).resolves.toEqual({ removed: true });
    expect(events.removed).toHaveBeenCalledWith({ provider: 'ext-forge', instance: ORIGIN, accountId: alice });
    await expect(auth.listInstances()).resolves.toEqual([ORIGIN]);
    await expect(auth.listConnectedAccounts()).resolves.toEqual([expect.objectContaining({
      account: expect.objectContaining({ provider: 'ext-forge' }), user: { id: 8, login: 'bob' },
    })]);
  });

  it('hands Git transport the exact stored credential', async () => {
    const { auth, accounts } = setup();
    await auth.connectToken({ instance: ORIGIN, token: 'pat-1' });
    const credentialId = await auth.readCurrentAccountId({ instance: ORIGIN });

    await expect(accounts.readCredential({ instance: ORIGIN, credentialId, credentialRevision: 1 })).resolves.toEqual({
      credentialId, credentialRevision: 1, providerUserId: `${ORIGIN}#7`, status: 'valid', source: 'pat',
      user: { id: 7, login: 'alice' }, secret: 'pat-1',
    });
    await expect(accounts.readCredential({ instance: ORIGIN, credentialId, credentialRevision: 2 })).resolves.toBeNull();
  });

  describe('Basic-auth hosts (a username settings field)', () => {
    const basicDescriptor = { ...descriptor, settings: [{ key: 'username', type: 'username', secret: false, scope: 'instance' }] };
    const basicSetup = () => {
      const store = fakeStore();
      const events = { connected: vi.fn(), invalidated: vi.fn(), removed: vi.fn() };
      const verify = vi.fn(async () => ({ id: 7, login: 'reported-name' }));
      const probe = vi.fn(async () => ({ supported: true }));
      const accounts = createPatAccountAuth({
        descriptor: basicDescriptor, store, events, verify, probe, classifyFailure: (error) => error?.kind ?? 'provider-error',
      });
      return { accounts, auth: accounts.auth, verify, probe };
    };

    it('verifies and probes with the typed username and keeps it as the login', async () => {
      const { auth, accounts, verify, probe } = basicSetup();
      await expect(auth.connectToken({ instance: ORIGIN, token: 'http-pass', username: 'alice' }))
        .resolves.toEqual({ connected: true, user: { id: 7, login: 'alice' } });
      expect(verify).toHaveBeenCalledWith(ORIGIN, 'http-pass', { username: 'alice' });
      expect(probe).toHaveBeenCalledWith(ORIGIN, 'http-pass', { username: 'alice' });

      verify.mockClear();
      await auth.status({ instance: ORIGIN });
      expect(verify).toHaveBeenCalledWith(ORIGIN, 'http-pass', { username: 'alice' });
      const session = await auth.resolveAccount({ instance: ORIGIN });
      expect(accounts.loginFor(session)).toBe('alice');
      expect(accounts.tokenFor(session)).toBe('http-pass');
    });

    it('refuses a connect without a username before any request', async () => {
      const { auth, verify } = basicSetup();
      await expect(auth.connectToken({ instance: ORIGIN, token: 'http-pass' })).rejects.toMatchObject({
        sourceControlResponse: { status: 400, body: { error: 'username is required' } },
      });
      expect(verify).not.toHaveBeenCalled();
    });

    it('calls a token-only provider exactly as before, ignoring a username', async () => {
      const verify = vi.fn(async () => ({ id: 7, login: 'alice' }));
      const probe = vi.fn(async () => ({ supported: true }));
      const { auth } = setup({ verify, probe });
      await auth.connectToken({ instance: ORIGIN, token: 'pat-1', username: 'ignored' });
      expect(verify.mock.calls[0]).toEqual([ORIGIN, 'pat-1']);
      expect(probe.mock.calls[0]).toEqual([ORIGIN]);
      await auth.status({ instance: ORIGIN });
      expect(verify.mock.calls[1]).toEqual([ORIGIN, 'pat-1']);
    });
  });
});
