import { isString } from '../shared/guards.js';
import { ownedOriginInstance } from './origin-instance.js';

/**
 * The account half of a provider that signs in with personal access tokens
 * and/or a CLI login, keeping tokens in its origin-keyed section of the auth store
 * (`authStore.section(id)`): Gitea, Forgejo, and extension providers. The provider
 * supplies the two network calls; everything else is the store.
 *
 * - `verify(origin, token)` answers the token's user (`{ id, login, ... }`)
 *   or throws; `classifyFailure(error) === 'invalid-token'` means the forge
 *   refused the token, which writes the account off.
 * - `probe(origin, token?)` answers `{ supported, version?, edition?, message? }`:
 *   whether the instance is one this provider can serve. Capabilities call
 *   it without a token; connect passes the token being connected, for an
 *   instance that refuses anonymous reads. `edition` is the server the
 *   instance's own API namespace named, when it reports one.
 * - `ownerElsewhere({ origin, version, edition })`, optional, answers another
 *   provider (`{ id, label }`) whose card the instance belongs on, or null.
 *   `edition` is what the probe learned from the instance's own API
 *   namespace, when it reports one; `version` is the fallback signal.
 *   Connect refuses such an instance before anything is stored.
 *
 * A provider whose settings declare a `username` field signs in with HTTP
 * Basic (Gerrit: username plus HTTP password), so the token alone cannot
 * verify. For it, and only for it, connect takes a `username` and calls
 * `verify(origin, token, { username })` and `probe(origin, token, { username })`.
 * The typed username is stored as the account's `user.login`, so every later
 * re-verify, `loginFor(session)` and Git transport use exactly what Basic auth
 * accepted. Other providers are called with `(origin, token)` for both.
 *
 * A provider whose settings declare an `sshUrl` field keeps an optional
 * instance-level SSH address beside its accounts. `setSshUrl` stores the
 * normalized address, `listSshHosts`/`readSshUrl` expose it to remote matching,
 * and `ownsHost` accepts a remote on it; `sshUrlFor` gives the session's
 * address to the provider's own remote parser.
 *
 * A provider whose descriptor names a CLI (`authMethods.cli: { tool }`) and
 * that passes `cli` also takes that CLI's login, by GitLab's glab rule
 * (`../gitlab/DOCUMENTATION.md`): it is used only after the user switches to
 * it (`cliActive`), its token is never stored, and only a CLI answer that it
 * has no login, or the forge refusing its token, undoes the switch.
 * - `cli.tokenResult(origin)` answers `{ token }`, `{ gone: true }` or
 *   `{ unknown: true }`, as `../gitlab/glab-credential.js` does.
 * - `cli.listInstances()` answers the origins the CLI has a login for, which
 *   are listed beside the stored ones.
 * A service-owned CLI login instead supplies `cli.status(origin)`: the user
 * or null for that origin, with errors left unknown. It uses the same CLI
 * account without a token. With no PAT method it is current without a stored
 * activation flag; token-backed built-in CLIs retain their existing switches.
 */

const UNSUPPORTED_METHOD = Object.freeze({ available: false, reason: 'unsupported' });

/** The instance whose configured SSH address a remote lives on, or null. */
const ownedSshInstance = ({ host, port, sshPort, knownSshHosts, parseSshUrl }) => {
  if (port !== undefined || sshPort === undefined || !Array.isArray(knownSshHosts) || !(parseSshUrl instanceof Function)) return null;
  const name = String(host ?? '').toLowerCase().replace(/\.$/, '');
  for (const entry of knownSshHosts) {
    const parsed = parseSshUrl(entry?.sshUrl);
    if (parsed && parsed.host === name && parsed.port === sshPort) return entry.instance;
  }
  return null;
};

/** An error the shell answers with exactly this status and body. */
const responseError = (status, body) => Object.assign(new Error(body.error), { sourceControlResponse: { status, body } });

export function createPatAccountAuth({
  descriptor, store, events, verify, probe, classifyFailure, ownerElsewhere = null,
  normalizeSshUrl = null, parseSshUrl = null, cli = null,
}) {
  const cliEnabled = Boolean(cli && descriptor.authMethods?.cli);
  const patEnabled = descriptor.authMethods?.pat !== false;
  const serviceLogin = cliEnabled && descriptor.authMethods.cli.kind === 'service';
  const serviceOnly = serviceLogin && !descriptor.authMethods.pat;
  const cliIsCurrent = (instance) => cliEnabled && (serviceOnly || instance.cliActive) && !instance.cliDisabled;
  const takesUsername = descriptor.settings?.some((field) => field.type === 'username') === true;
  const takesSshUrl = descriptor.settings?.some((field) => field.key === 'sshUrl') === true;
  if (takesSshUrl && (!(normalizeSshUrl instanceof Function) || !(parseSshUrl instanceof Function))) {
    throw new TypeError(`${descriptor.label} SSH URL requires a normalizer and a parser`);
  }
  const loginOf = (account) => account.user?.login ?? account.user?.username ?? '';
  const verifyAccount = (origin, account) => (takesUsername
    ? verify(origin, account.token, { username: loginOf(account) })
    : verify(origin, account.token));
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

  const cliAccountId = (origin, user) => `${origin}#cli:${user.id}`;
  const isCliAccountId = (origin, accountId) => cliEnabled && isString(accountId) && accountId.startsWith(`${origin}#cli:`);
  const cliUser = (origin, user) => ({ ...user, provider: descriptor.id, instance: origin });
  const cliAccountView = (origin, user, current) => ({
    id: cliAccountId(origin, user),
    credentialId: cliAccountId(origin, user),
    credentialRevision: 1,
    providerUserId: `${origin}#${user.id}`,
    providerUserStatus: 'available',
    user: cliUser(origin, user),
    current,
    source: 'cli',
    status: 'valid',
  });

  /**
   * The CLI login for an instance: `usable` with its token and user, `gone`
   * when the CLI said it has none or the forge refused its token, `unknown`
   * when neither could be settled, `disabled` when the user turned it off.
   */
  const cliState = async (origin, instance) => {
    if (instance.cliDisabled) return { status: 'disabled' };
    if (serviceLogin) {
      // Errors remain unknown. Only an explicit null means this instance has no login.
      try {
        const user = await cli.status(origin);
        return user ? { status: 'usable', user } : { status: 'gone' };
      } catch (error) {
        return { status: 'unknown', error };
      }
    }
    const lookup = await cli.tokenResult(origin);
    if (lookup.gone) return { status: 'gone' };
    if (!lookup.token) return { status: 'unknown' };
    try {
      return { status: 'usable', token: lookup.token, user: await verify(origin, lookup.token) };
    } catch (error) {
      return classifyFailure(error) === 'invalid-token' ? { status: 'gone' } : { status: 'unknown' };
    }
  };
  const usableCli = async (origin) => {
    const state = await cliState(origin, await store.readInstance(origin));
    return state.status === 'usable' ? state : null;
  };

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

  /**
   * A personal access token cannot be renewed: a refused one is written off.
   * Bindings move first. A CLI login has no stored record and only reports.
   */
  const invalidateAccount = async ({ instance: origin, accountId, persisted = true }) => {
    await events.invalidated(identityFor(origin, accountId));
    if (persisted) await store.markAccountInvalid(origin, accountId, 'unauthorized');
    return false;
  };

  const buildStatus = async (origin) => {
    const instance = await store.readInstance(origin);
    const storedAccounts = patEnabled ? instance.accounts : [];
    const switched = cliIsCurrent(instance);
    const active = switched ? null : storedAccounts.find((account) => account.id === instance.activeAccountId && account.status !== 'invalid') ?? null;
    const login = cliEnabled ? await cliState(origin, instance) : null;
    // The user's switch to the CLI login is undone only when that login is
    // really gone; a timeout, a missing CLI or an unreachable instance keep it.
    if (switched && !serviceOnly && login.status === 'gone') {
      await store.setCliActive(origin, false);
      return buildStatus(origin);
    }
    const usable = login?.status === 'usable' ? login : null;
    const accounts = storedAccounts.map((account) => accountView(origin, account, Boolean(active && account.id === active.id), storedAccounts));
    if (usable) accounts.push(cliAccountView(origin, usable.user, switched));
    const cliBlock = (current) => {
      const block = { available: Boolean(usable), disabled: instance.cliDisabled, active: current };
      if (usable) block.user = cliUser(origin, usable.user);
      return block;
    };
    if (!active) {
      if (login?.error) throw Object.assign(login.error, { sourceControlAuthUnknown: true });
      if (!cliEnabled) return { provider: descriptor.id, instance: origin, status: 'disconnected', connected: false, accounts };
      if (usable && switched) {
        return {
          provider: descriptor.id, instance: origin, status: 'connected', connected: true,
          user: cliUser(origin, usable.user), accounts, cli: cliBlock(true),
        };
      }
      // A switch kept while the CLI cannot answer is reported, so the user can
      // turn it off with the CLI and the instance both down.
      return { provider: descriptor.id, instance: origin, status: 'disconnected', connected: false, accounts, cli: cliBlock(switched) };
    }
    try {
      const user = await verifyAccount(origin, active);
      const status = {
        provider: descriptor.id, instance: origin, status: 'connected', connected: true,
        user: { ...user, provider: descriptor.id, instance: origin }, scope: active.scope, accounts,
      };
      if (cliEnabled) status.cli = cliBlock(false);
      return status;
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
  const logins = new WeakMap();
  const sshUrls = new WeakMap();
  const users = new WeakMap();

  const notConnected = (origin, requestedAccountId) => {
    const error = new Error(`${descriptor.label} is not connected`);
    error.status = 401;
    error.sourceControlAccountUnavailable = true;
    if (requestedAccountId) error.sourceControlIdentity = identityFor(origin, requestedAccountId);
    return error;
  };
  const sessionWith = (instance, fields, { token, login }) => {
    const session = Object.freeze(fields);
    tokens.set(session, token);
    logins.set(session, login);
    sshUrls.set(session, takesSshUrl ? instance.sshUrl ?? null : null);
    return session;
  };

  /** The CLI login asked for by its account id, while the CLI is still logged in as that user. */
  const resolveCliAccount = async (origin, instance, requestedAccountId) => {
    if (serviceLogin) {
      const login = await cliState(origin, instance);
      if (login.error) throw login.error;
      if (login.status !== 'usable' || requestedAccountId !== cliAccountId(origin, login.user)) {
        await events.invalidated(identityFor(origin, requestedAccountId));
        throw notConnected(origin, requestedAccountId);
      }
      return cliSession(origin, instance, login);
    }
    const lookup = instance.cliDisabled ? null : await cli.tokenResult(origin);
    if (!lookup?.token) throw notConnected(origin, requestedAccountId);
    let user;
    try {
      user = await verify(origin, lookup.token);
    } catch (error) {
      if (classifyFailure(error) === 'invalid-token') await events.invalidated(identityFor(origin, requestedAccountId));
      throw error;
    }
    if (requestedAccountId !== cliAccountId(origin, user)) {
      // The CLI is logged in as someone else now.
      await events.invalidated(identityFor(origin, requestedAccountId));
      throw notConnected(origin, requestedAccountId);
    }
    return cliSession(origin, instance, { token: lookup.token, user });
  };
  const cliSession = (origin, instance, { token, user }) => {
    const session = sessionWith(instance, {
      instance: origin,
      accountId: cliAccountId(origin, user),
      credentialRevision: 1,
      providerUserId: `${origin}#${user.id}`,
      secretKind: 'cli',
      persisted: false,
    }, { token, login: user.login ?? '' });
    users.set(session, user);
    return session;
  };

  /** The exact account asked for, else the instance's current one: the CLI login while the user switched to it. */
  const resolveAccount = async ({ instance: origin, accountId: requestedAccountId = '' }) => {
    const instance = await store.readInstance(origin);
    if (isCliAccountId(origin, requestedAccountId)) return resolveCliAccount(origin, instance, requestedAccountId);
    if (!requestedAccountId && cliIsCurrent(instance)) {
      const login = await cliState(origin, instance);
      if (login.error) throw login.error;
      if (login.status !== 'usable') throw notConnected(origin, '');
      return cliSession(origin, instance, login);
    }
    if (!patEnabled) throw notConnected(origin, requestedAccountId);
    const account = requestedAccountId
      ? instance.accounts.find((candidate) => candidate.id === requestedAccountId)
      : instance.accounts.find((candidate) => candidate.id === instance.activeAccountId && candidate.status !== 'invalid') ?? null;
    if (!account?.token || account.status === 'invalid') throw notConnected(origin, requestedAccountId);
    return sessionWith(instance, {
      instance: origin,
      accountId: account.id,
      credentialRevision: account.credentialRevision,
      providerUserId: account.providerUserId,
      secretKind: 'pat',
      persisted: true,
    }, { token: account.token, login: loginOf(account) });
  };

  /** The CLI method's availability: only a login whose token the instance accepts counts. */
  const cliCapability = async (origin, supported) => {
    if (!cliEnabled) return UNSUPPORTED_METHOD;
    return supported && await usableCli(origin) ? { available: true } : { available: false, reason: 'cli-unavailable' };
  };

  const cliOnly = cliEnabled ? {
    /** Turning the CLI off also undoes the switch to it (`auth-storage.js`). */
    setCliDisabled: async ({ instance: origin, disabled }) => {
      const nextDisabled = await store.setCliDisabled(origin, disabled);
      return { available: Boolean(await usableCli(origin)), disabled: nextDisabled };
    },
  } : {};

  const auth = Object.freeze({
    /** Whether the instance answers as one this provider supports, and which ways in it offers. */
    capabilities: async ({ instance: origin }) => {
      const { supported } = await probe(origin);
      return {
        authentication: supported,
        authenticationMethods: {
          device: UNSUPPORTED_METHOD,
          pat: supported && patEnabled ? { available: true } : UNSUPPORTED_METHOD,
          cli: await cliCapability(origin, supported),
        },
      };
    },
    status: ({ instance }) => buildStatus(instance),
    accounts: async ({ instance: origin }) => {
      if (serviceLogin) return (await buildStatus(origin)).accounts;
      const instance = await store.readInstance(origin);
      const switched = cliEnabled && instance.cliActive;
      return instance.accounts.map((account) => accountView(origin, account, account.id === instance.activeAccountId && !switched, instance.accounts));
    },
    /** The token's user first, then the instance's support and owner; nothing is stored unless all pass. */
    connectToken: async ({ instance: origin, token, username }) => {
      if (!patEnabled) throw responseError(501, { error: `${descriptor.label} does not accept tokens` });
      if (takesUsername && !username) throw responseError(400, { error: 'username is required' });
      const credentials = { username };
      // A Basic-auth host's stored login is the username the user typed, the
      // one Basic auth accepted, whatever name the host reports for the account.
      const user = takesUsername ? { ...(await verify(origin, token, credentials)), login: username } : await verify(origin, token);
      const { version, supported, message, edition } = takesUsername ? await probe(origin, token, credentials) : await probe(origin, token);
      if (!supported) {
        throw responseError(400, {
          error: message || (version ? `${descriptor.label} ${version} is not supported` : `${descriptor.label} is not supported`),
          code: 'UNSUPPORTED_PROVIDER_VERSION',
        });
      }
      const owner = ownerElsewhere ? await ownerElsewhere({ origin, version, edition }) : null;
      if (owner) {
        throw responseError(409, {
          error: `${origin} belongs on the ${owner.label} card`,
          code: 'SOURCE_CONTROL_INSTANCE_OTHER_PROVIDER',
          provider: owner.id,
        });
      }
      const credential = await store.setAccount(origin, { token, user, source: 'pat' });
      await announceConnectedAccount(origin, credential, user);
      return { connected: true, user };
    },
    activate: async ({ instance: origin, accountId }) => {
      if (isCliAccountId(origin, accountId)) {
        const usable = await usableCli(origin);
        if (!usable || accountId !== cliAccountId(origin, usable.user)) throw responseError(404, { error: `${descriptor.label} CLI account not found` });
        await store.setCliActive(origin, true);
        return buildStatus(origin);
      }
      if (!patEnabled) throw responseError(404, { error: `${descriptor.label} account not found` });
      if (!accountId || !(await store.activate(origin, accountId))) throw responseError(404, { error: `${descriptor.label} account not found` });
      return buildStatus(origin);
    },
    ...cliOnly,
    /** Bindings let go of the exact account before it leaves the store; a CLI login only loses the switch. */
    remove: async ({ instance: origin, accountId }) => {
      if (isCliAccountId(origin, accountId)) {
        const usable = await usableCli(origin);
        if (!usable || accountId !== cliAccountId(origin, usable.user)) return { removed: false };
        await events.removed(identityFor(origin, accountId));
        // `setCliActive` answers the switch's new state, which is off here.
        await store.setCliActive(origin, false);
        return { removed: true };
      }
      const instance = await store.readInstance(origin);
      if (!instance.accounts.some((account) => account.id === accountId)) return { removed: false };
      await events.removed(identityFor(origin, accountId));
      return { removed: await store.removeAccount(origin, accountId) };
    },
    resolveAccount,
    invalidateAccount,
    /** The CLI login while the user switched to it and it still works, else the active stored account. */
    readCurrentAccountId: async ({ instance: origin }) => {
      const instance = await store.readInstance(origin);
      if (serviceLogin && cliIsCurrent(instance)) {
        const login = await cliState(origin, instance);
        if (login.error) throw login.error;
        return login.status === 'usable' ? cliAccountId(origin, login.user) : null;
      }
      if (!patEnabled) return null;
      const usable = cliIsCurrent(instance) ? await usableCli(origin) : null;
      if (usable) return cliAccountId(origin, usable.user);
      return instance.accounts.find((account) => account.id === instance.activeAccountId && account.status !== 'invalid')?.id ?? null;
    },
    /** The stored instances, then those the CLI has a login for. */
    listInstances: async () => {
      const stored = (await store.listInstances?.()) ?? [];
      return cliEnabled ? [...new Set([...stored, ...await cli.listInstances()])] : stored;
    },
    /** The instance's separate SSH address, when it has one. */
    readSshUrl: async ({ instance: origin }) => {
      if (!takesSshUrl) return null;
      return (await store.readInstance(origin)).sshUrl ?? null;
    },
    /** Every instance with a separate SSH address, for recognising remotes on it. */
    listSshHosts: async () => {
      if (!takesSshUrl) return [];
      if (store.listSshUrls instanceof Function) {
        return Object.entries(await store.listSshUrls()).map(([instance, sshUrl]) => ({ instance, sshUrl }));
      }
      const hosts = [];
      for (const origin of (await store.listInstances?.()) ?? []) {
        const sshUrl = (await store.readInstance(origin)).sshUrl;
        if (sshUrl) hosts.push({ instance: origin, sshUrl });
      }
      return hosts;
    },
    /** Stores the instance's separate SSH address; an empty value removes it. */
    setSshUrl: async ({ instance: origin, sshUrl }) => {
      if (!takesSshUrl) throw responseError(400, { error: `${descriptor.label} does not take an SSH URL` });
      let normalized;
      try { normalized = normalizeSshUrl(sshUrl); }
      catch (error) { throw responseError(400, { error: error?.message || 'Invalid SSH URL', code: 'INVALID_SSH_URL' }); }
      await store.setSshUrl(origin, normalized);
      return { sshUrl: normalized };
    },
    /** Every valid stored account, for identity backfill and binding repair at start. */
    listConnectedAccounts: async () => {
      if (!patEnabled) return [];
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
    ownsHost: (input) => ownedOriginInstance(input)
      ?? ownedSshInstance({ ...input, parseSshUrl }),
  });

  return Object.freeze({
    auth,
    /** The token behind a session `resolveAccount` returned; undefined for any other object. */
    tokenFor: (session) => tokens.get(session),
    /** The verified CLI user, kept outside the serializable session. */
    userFor: (session) => users.get(session),
    /** The stored login of that session's account (a Basic-auth host's username); undefined for any other object. */
    loginFor: (session) => logins.get(session),
    /** The instance's separate SSH address for that session's instance; null when it has none. */
    sshUrlFor: (session) => sshUrls.get(session) ?? null,
    /** Git transport's view of an exact stored credential, or null. */
    readCredential: async ({ instance, credentialId, credentialRevision }) => {
      if (!patEnabled) return null;
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
