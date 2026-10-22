import { ownedOriginInstance } from './origin-instance.js';

/**
 * The account half of a provider that signs in with personal access tokens
 * only and keeps its accounts in its origin-keyed section of the auth store
 * (`authStore.section(id)`): Gitea, and extension providers. The provider
 * supplies the two network calls; everything else is the store.
 *
 * - `verify(origin, token)` answers the token's user (`{ id, login, ... }`)
 *   or throws; `classifyFailure(error) === 'invalid-token'` means the forge
 *   refused the token, which writes the account off.
 * - `probe(origin)` answers `{ supported, version?, message? }` without a
 *   token: whether the instance is one this provider can serve.
 */

const UNSUPPORTED_METHOD = Object.freeze({ available: false, reason: 'unsupported' });

/** An error the shell answers with exactly this status and body. */
const responseError = (status, body) => Object.assign(new Error(body.error), { sourceControlResponse: { status, body } });

export function createPatAccountAuth({ descriptor, store, events, verify, probe, classifyFailure }) {
  const identityFor = (origin, accountId) => ({ provider: descriptor.id, instance: origin, accountId });

  const accountView = (origin, account, current, accounts) => ({
    id: account.id,
    credentialId: account.id,
    credentialRevision: account.credentialRevision,
    providerUserId: account.providerUserId,
    providerUserStatus: accounts.some((candidate) => (
      candidate.providerUserId === account.providerUserId && candidate.status === 'valid'
    )) ? 'available' : 'unavailable',
    user: { ...account.user, provider: descriptor.id, instance: origin },
    scope: account.scope,
    current,
    source: account.source,
    status: account.status === 'invalid' ? 'invalid' : 'valid',
  });

  const announceConnectedAccount = async (origin, credential, user) => {
    const account = identityFor(origin, credential.credentialId);
    // Connecting the same user again supersedes the earlier credential;
    // whatever followed it keeps working as the same account.
    const instance = await store.readInstance(origin).catch(() => null);
    const superseded = (instance?.accounts ?? []).filter((candidate) =>
      candidate.providerUserId === credential.providerUserId && candidate.id !== credential.credentialId);
    await events.connected({
      account,
      user,
      credential: { credentialRevision: credential.credentialRevision, providerUserId: credential.providerUserId },
      renews: superseded.map((candidate) => ({ ...account, accountId: candidate.id })),
    });
  };

  /** A personal access token cannot be renewed: a refused one is written off. Bindings move first. */
  const invalidateAccount = async ({ instance: origin, accountId }) => {
    await events.invalidated(identityFor(origin, accountId));
    await store.markAccountInvalid(origin, accountId, 'unauthorized');
    return false;
  };

  const buildStatus = async (origin) => {
    const instance = await store.readInstance(origin);
    const active = instance.accounts.find((account) => account.id === instance.activeAccountId && account.status !== 'invalid') ?? null;
    const accounts = instance.accounts.map((account) => accountView(origin, account, Boolean(active && account.id === active.id), instance.accounts));
    if (!active) return { provider: descriptor.id, instance: origin, status: 'disconnected', connected: false, accounts };
    try {
      const user = await verify(origin, active.token);
      return {
        provider: descriptor.id, instance: origin, status: 'connected', connected: true,
        user: { ...user, provider: descriptor.id, instance: origin }, scope: active.scope, accounts,
      };
    } catch (error) {
      const failure = classifyFailure(error);
      if (failure === 'invalid-token') {
        await invalidateAccount({ instance: origin, accountId: active.id });
        return buildStatus(origin);
      }
      return { provider: descriptor.id, instance: origin, status: failure, connected: false, message: error?.message, accounts };
    }
  };

  // The token behind each session the shell holds stays in this module, never
  // in the session object, so serializing a session can never leak it.
  const tokens = new WeakMap();

  /** The exact account asked for, else the instance's current one. */
  const resolveAccount = async ({ instance: origin, accountId: requestedAccountId = '' }) => {
    let account;
    if (requestedAccountId) {
      account = await store.readAccount(origin, requestedAccountId);
    } else {
      const instance = await store.readInstance(origin);
      account = instance.accounts.find((candidate) => candidate.id === instance.activeAccountId && candidate.status !== 'invalid') ?? null;
    }
    if (!account?.token) {
      const error = new Error(`${descriptor.label} is not connected`);
      error.status = 401;
      error.sourceControlAccountUnavailable = true;
      if (requestedAccountId) error.sourceControlIdentity = identityFor(origin, requestedAccountId);
      throw error;
    }
    const session = Object.freeze({
      instance: origin,
      accountId: account.id,
      credentialRevision: account.credentialRevision,
      providerUserId: account.providerUserId,
      secretKind: 'pat',
      persisted: true,
    });
    tokens.set(session, account.token);
    return session;
  };

  const auth = Object.freeze({
    /** Whether the instance answers as one this provider supports; tokens are the only way in. */
    capabilities: async ({ instance: origin }) => {
      const { supported } = await probe(origin);
      return {
        authentication: supported,
        authenticationMethods: {
          device: UNSUPPORTED_METHOD,
          pat: supported ? { available: true } : UNSUPPORTED_METHOD,
          cli: UNSUPPORTED_METHOD,
        },
      };
    },
    status: ({ instance }) => buildStatus(instance),
    accounts: async ({ instance: origin }) => {
      const instance = await store.readInstance(origin);
      return instance.accounts.map((account) => accountView(origin, account, account.id === instance.activeAccountId, instance.accounts));
    },
    /** The token's user first, then the instance's support; nothing is stored unless both pass. */
    connectToken: async ({ instance: origin, token }) => {
      const user = await verify(origin, token);
      const { version, supported, message } = await probe(origin);
      if (!supported) {
        throw responseError(400, {
          error: message || (version ? `${descriptor.label} ${version} is not supported` : `${descriptor.label} is not supported`),
          code: 'UNSUPPORTED_PROVIDER_VERSION',
        });
      }
      const credential = await store.setAccount(origin, { token, user, source: 'pat' });
      await announceConnectedAccount(origin, credential, user);
      return { connected: true, user };
    },
    activate: async ({ instance: origin, accountId }) => {
      if (!accountId || !(await store.activate(origin, accountId))) throw responseError(404, { error: `${descriptor.label} account not found` });
      return buildStatus(origin);
    },
    /** Bindings let go of the exact account before it leaves the store. */
    remove: async ({ instance: origin, accountId }) => {
      const instance = await store.readInstance(origin);
      if (!instance.accounts.some((account) => account.id === accountId)) return { removed: false };
      await events.removed(identityFor(origin, accountId));
      return { removed: await store.removeAccount(origin, accountId) };
    },
    resolveAccount,
    invalidateAccount,
    readCurrentAccountId: async ({ instance: origin }) => {
      const instance = await store.readInstance(origin);
      return instance.accounts.find((account) => account.id === instance.activeAccountId && account.status !== 'invalid')?.id ?? null;
    },
    listInstances: async () => (await store.listInstances?.()) ?? [],
    /** Every valid stored account, for identity backfill and binding repair at start. */
    listConnectedAccounts: async () => {
      const connected = [];
      for (const origin of (await store.listInstances?.()) ?? []) {
        for (const account of (await store.listAccounts?.(origin)) ?? []) {
          if (account?.status !== 'valid' || !account.credentialId) continue;
          connected.push({
            account: identityFor(origin, account.credentialId),
            user: account.user,
            credential: { credentialRevision: account.credentialRevision, providerUserId: account.providerUserId },
          });
        }
      }
      return connected;
    },
    /** The known instance a host belongs to; a provider is never inferred from an unknown host. */
    ownsHost: ownedOriginInstance,
  });

  return Object.freeze({
    auth,
    /** The token behind a session `resolveAccount` returned; undefined for any other object. */
    tokenFor: (session) => tokens.get(session),
    /** Git transport's view of an exact stored credential, or null. */
    readCredential: async ({ instance, credentialId, credentialRevision }) => {
      const account = await store.readAccount(instance, credentialId, credentialRevision);
      if (!account) return null;
      return {
        credentialId: account.credentialId,
        credentialRevision: account.credentialRevision,
        providerUserId: account.providerUserId,
        status: account.status,
        source: account.source,
        user: account.user,
        secret: account.token,
      };
    },
  });
}
