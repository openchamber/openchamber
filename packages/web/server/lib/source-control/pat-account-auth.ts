import { isString } from '../shared/guards.js';
import { ownedOriginInstance } from './origin-instance.js';
import type { AuthCredential, AuthUserInput, PublicAuthInstance, createSourceControlAuthStore } from './auth-storage.js';
import type { AccountEvents, ProviderDescriptor, ProviderSession } from './provider-contract.js';
import type { normalizeSshUrl, parseSshUrl } from './ssh-url.js';

type PatUser = AuthUserInput & { username?: string };
type PatStore = ReturnType<ReturnType<typeof createSourceControlAuthStore>['section']>;
interface PatFailure {
  message?: unknown;
  kind?: unknown;
  status?: unknown;
  code?: unknown;
  response?: unknown;
  cause?: unknown;
}
interface PatCli {
  status?(origin: string): Promise<PatUser | null>;
  tokenResult?(origin: string): Promise<{ gone?: boolean; token?: string; unknown?: boolean; reason?: string }>;
  listInstances(): Promise<string[]>;
}
export interface PatAccountAuthOptions {
  descriptor: ProviderDescriptor;
  store: PatStore;
  events: Pick<AccountEvents, 'connected' | 'invalidated' | 'removed'>;
  verify(origin: string, token: string | undefined, credentials?: { username: string | undefined }): Promise<PatUser>;
  probe(origin: string, token?: string, credentials?: { username: string | undefined }): Promise<{ supported: boolean; version?: string | null | undefined; message?: string | undefined; edition?: string | null }>;
  classifyFailure(error: PatFailure | null | undefined): PatFailure['kind'];
  ownerElsewhere?: ((input: { origin: string; version: string | null | undefined; edition: string | null | undefined }) => { id: string; label: string } | null | Promise<{ id: string; label: string } | null>) | null;
  normalizeSshUrl?: typeof normalizeSshUrl | null;
  parseSshUrl?: typeof parseSshUrl | null;
  cli?: PatCli | null;
}
type CliState = { status: 'usable'; user: PatUser; token?: string; error?: never }
  | { status: 'disabled' | 'gone' | 'unknown'; error?: unknown; user?: never; token?: never };
type CliBlock = { available: boolean; disabled: boolean; active: boolean; user?: PatUser & { provider: string; instance: string } };
export interface AccountStatus {
  provider: string; instance: string; status: PatFailure['kind']; connected: boolean;
  accounts: Array<{ id: string; credentialId: string; credentialRevision: number; providerUserId: string; providerUserStatus: string; user: PatUser & { provider: string; instance: string }; current: boolean; source: string; status: string; scope?: string }>;
  user?: PatUser & { provider: string; instance: string };
  scope?: string;
  cli?: CliBlock;
  message?: unknown;
}
const required = <T>(value: T | null | undefined): T => {
  if (value === null || value === undefined) throw new TypeError('Missing provider authentication dependency');
  return value;
};
const errorWithMessage = (value: unknown): value is PatFailure => value !== null && value !== undefined;

const UNSUPPORTED_METHOD = Object.freeze({ available: false, reason: 'unsupported' });

const ownedSshInstance = ({ host, port, sshPort, knownSshHosts, parseSshUrl }: {
  host: string; port?: number; sshPort?: number; knownSshHosts?: Array<{ instance: string; sshUrl: string }>; parseSshUrl: PatAccountAuthOptions['parseSshUrl'];
}) => {
  if (port !== undefined || sshPort === undefined || !Array.isArray(knownSshHosts) || !(parseSshUrl instanceof Function)) return null;
  const name = String(host ?? '').toLowerCase().replace(/\.$/, '');
  for (const entry of knownSshHosts) {
    const parsed = parseSshUrl(entry?.sshUrl);
    if (parsed && parsed.host === name && parsed.port === sshPort) return entry.instance;
  }
  return null;
};

const responseError = <Body extends { error: unknown; code?: string; provider?: string }>(status: number, body: Body) => Object.assign(new Error(`${body.error}`), { sourceControlResponse: { status, body } });

export function createPatAccountAuth({
  descriptor, store, events, verify, probe, classifyFailure, ownerElsewhere = null,
  normalizeSshUrl = null, parseSshUrl = null, cli = null,
}: PatAccountAuthOptions) {
  const cliEnabled = Boolean(cli && descriptor.authMethods?.cli);
  const patEnabled = descriptor.authMethods?.pat !== false;
  const serviceLogin = cliEnabled && descriptor.authMethods.cli !== false && descriptor.authMethods.cli.kind === 'service';
  const serviceOnly = serviceLogin && !descriptor.authMethods.pat;
  const cliIsCurrent = (instance: PublicAuthInstance) => cliEnabled && (serviceOnly || instance.cliActive) && !instance.cliDisabled;
  const takesUsername = descriptor.settings?.some((field) => field.type === 'username') === true;
  const takesSshUrl = descriptor.settings?.some((field) => field.key === 'sshUrl') === true;
  if (takesSshUrl && (!(normalizeSshUrl instanceof Function) || !(parseSshUrl instanceof Function))) {
    throw new TypeError(`${descriptor.label} SSH URL requires a normalizer and a parser`);
  }
  const loginOf = (account: { user?: PatUser }) => account.user?.login ?? account.user?.username ?? '';
  const verifyAccount = (origin: string, account: AuthCredential) => (takesUsername
    ? verify(origin, account.token, { username: loginOf(account) })
    : verify(origin, account.token));
  const identityFor = (origin: string, accountId: string) => ({ provider: descriptor.id, instance: origin, accountId });

  const accountView = (origin: string, account: AuthCredential, current: boolean, accounts: AuthCredential[]) => ({
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

  const cliAccountId = (origin: string, user: PatUser) => `${origin}#cli:${user.id}`;
  const isCliAccountId = (origin: string, accountId: string) => cliEnabled && isString(accountId) && accountId.startsWith(`${origin}#cli:`);
  const cliUser = (origin: string, user: PatUser) => ({ ...user, provider: descriptor.id, instance: origin });
  const cliAccountView = (origin: string, user: PatUser, current: boolean) => ({
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

  const cliState = async (origin: string, instance: PublicAuthInstance): Promise<CliState> => {
    if (instance.cliDisabled) return { status: 'disabled' };
    if (serviceLogin) {
      try {
        const user = await required(required(cli).status).call(cli, origin);
        return user ? { status: 'usable', user } : { status: 'gone' };
      } catch (error) {
        return { status: 'unknown', error };
      }
    }
    const lookup = await required(required(cli).tokenResult).call(cli, origin);
    if (lookup.gone) return { status: 'gone' };
    if (!lookup.token) return { status: 'unknown' };
    try {
      return { status: 'usable', token: lookup.token, user: await verify(origin, lookup.token) };
    } catch (error) {
      return classifyFailure(errorWithMessage(error) ? error : error === null ? null : undefined) === 'invalid-token' ? { status: 'gone' } : { status: 'unknown' };
    }
  };
  const usableCli = async (origin: string) => {
    const state = await cliState(origin, await store.readInstance(origin));
    return state.status === 'usable' ? state : null;
  };

  const announceConnectedAccount = async (origin: string, credential: { credentialId: string; credentialRevision: number; providerUserId: string }, user: PatUser) => {
    const account = identityFor(origin, credential.credentialId);
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

  const invalidateAccount = async ({ instance: origin, accountId, persisted = true }: { instance: string; accountId: string; persisted?: boolean }) => {
    await events.invalidated(identityFor(origin, accountId));
    if (persisted) await store.markAccountInvalid(origin, accountId, 'unauthorized');
    return false;
  };

  const buildStatus = async (origin: string): Promise<AccountStatus> => {
    const instance = await store.readInstance(origin);
    const storedAccounts = patEnabled ? instance.accounts : [];
    const switched = cliIsCurrent(instance);
    const active = switched ? null : storedAccounts.find((account) => account.id === instance.activeAccountId && account.status !== 'invalid') ?? null;
    const login = cliEnabled ? await cliState(origin, instance) : null;
    if (switched && !serviceOnly && required(login).status === 'gone') {
      await store.setCliActive(origin, false);
      return buildStatus(origin);
    }
    const usable = login?.status === 'usable' ? login : null;
    const accounts: AccountStatus['accounts'] = storedAccounts.map((account) => accountView(origin, account, Boolean(active && account.id === active.id), storedAccounts));
    if (usable) accounts.push(cliAccountView(origin, usable.user, switched));
    const cliBlock = (current: boolean) => {
      const block: CliBlock = { available: Boolean(usable), disabled: instance.cliDisabled, active: current };
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
      return { provider: descriptor.id, instance: origin, status: 'disconnected', connected: false, accounts, cli: cliBlock(switched) };
    }
    try {
      const user = await verifyAccount(origin, active);
      const status: AccountStatus = {
        provider: descriptor.id, instance: origin, status: 'connected', connected: true,
        user: { ...user, provider: descriptor.id, instance: origin }, scope: active.scope, accounts,
      };
      if (cliEnabled) status.cli = cliBlock(false);
      return status;
    } catch (error) {
      const failure = classifyFailure(errorWithMessage(error) ? error : error === null ? null : undefined);
      if (failure === 'invalid-token') {
        await invalidateAccount({ instance: origin, accountId: active.id });
        return buildStatus(origin);
      }
      return { provider: descriptor.id, instance: origin, status: failure, connected: false, message: errorWithMessage(error) ? error.message : undefined, accounts };
    }
  };

  const tokens = new WeakMap<ProviderSession, string | undefined>();
  const logins = new WeakMap<ProviderSession, string>();
  const sshUrls = new WeakMap<ProviderSession, string | null>();
  const users = new WeakMap<ProviderSession, PatUser>();

  const notConnected = (origin: string, requestedAccountId: string) => {
    const error: Error & { status: number; sourceControlAccountUnavailable: boolean; sourceControlIdentity?: ReturnType<typeof identityFor> } = Object.assign(new Error(`${descriptor.label} is not connected`), { status: 401, sourceControlAccountUnavailable: true });
    if (requestedAccountId) error.sourceControlIdentity = identityFor(origin, requestedAccountId);
    return error;
  };
  const sessionWith = (instance: PublicAuthInstance, fields: ProviderSession, { token, login }: { token: string | undefined; login: string }) => {
    const session = Object.freeze(fields);
    tokens.set(session, token);
    logins.set(session, login);
    sshUrls.set(session, takesSshUrl ? instance.sshUrl ?? null : null);
    return session;
  };

  const resolveCliAccount = async (origin: string, instance: PublicAuthInstance, requestedAccountId: string) => {
    if (serviceLogin) {
      const login = await cliState(origin, instance);
      if (login.error) throw login.error;
      if (login.status !== 'usable' || requestedAccountId !== cliAccountId(origin, login.user)) {
        await events.invalidated(identityFor(origin, requestedAccountId));
        throw notConnected(origin, requestedAccountId);
      }
      return cliSession(origin, instance, login);
    }
    const lookup = instance.cliDisabled ? null : await required(required(cli).tokenResult).call(cli, origin);
    if (!lookup?.token) throw notConnected(origin, requestedAccountId);
    let user;
    try {
      user = await verify(origin, lookup.token);
    } catch (error) {
      if (classifyFailure(errorWithMessage(error) ? error : error === null ? null : undefined) === 'invalid-token') await events.invalidated(identityFor(origin, requestedAccountId));
      throw error;
    }
    if (requestedAccountId !== cliAccountId(origin, user)) {
      await events.invalidated(identityFor(origin, requestedAccountId));
      throw notConnected(origin, requestedAccountId);
    }
    return cliSession(origin, instance, { token: lookup.token, user });
  };
  const cliSession = (origin: string, instance: PublicAuthInstance, { token, user }: { token?: string; user: PatUser }) => {
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

  const resolveAccount = async ({ instance: origin, accountId: requestedAccountId = '' }: { instance: string; accountId?: string }) => {
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

  const cliCapability = async (origin: string, supported: boolean) => {
    if (!cliEnabled) return UNSUPPORTED_METHOD;
    return supported && await usableCli(origin) ? { available: true } : { available: false, reason: 'cli-unavailable' };
  };

  const cliOnly = cliEnabled ? {
    setCliDisabled: async ({ instance: origin, disabled }: { instance: string; disabled: boolean }) => {
      const nextDisabled = await store.setCliDisabled(origin, disabled);
      return { available: Boolean(await usableCli(origin)), disabled: nextDisabled };
    },
  } : {};

  const auth = Object.freeze({
    capabilities: async ({ instance: origin }: { instance: string }) => {
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
    status: ({ instance }: { instance: string }) => buildStatus(instance),
    accounts: async ({ instance: origin }: { instance: string }) => {
      if (serviceLogin) return (await buildStatus(origin)).accounts;
      const instance = await store.readInstance(origin);
      const switched = cliEnabled && instance.cliActive;
      return instance.accounts.map((account) => accountView(origin, account, account.id === instance.activeAccountId && !switched, instance.accounts));
    },
    connectToken: async ({ instance: origin, token, username }: { instance: string; token: string; username?: string }) => {
      if (!patEnabled) throw responseError(501, { error: `${descriptor.label} does not accept tokens` });
      if (takesUsername && !username) throw responseError(400, { error: 'username is required' });
      const credentials = { username };
      const user = takesUsername ? { ...(await verify(origin, token, credentials)), login: required(username) } : await verify(origin, token);
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
    activate: async ({ instance: origin, accountId }: { instance: string; accountId: string }) => {
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
    remove: async ({ instance: origin, accountId }: { instance: string; accountId: string }) => {
      if (isCliAccountId(origin, accountId)) {
        const usable = await usableCli(origin);
        if (!usable || accountId !== cliAccountId(origin, usable.user)) return { removed: false };
        await events.removed(identityFor(origin, accountId));
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
    readCurrentAccountId: async ({ instance: origin }: { instance: string }) => {
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
    listInstances: async () => {
      const stored = (await store.listInstances?.()) ?? [];
      return cliEnabled ? [...new Set([...stored, ...await required(cli).listInstances()])] : stored;
    },
    readSshUrl: async ({ instance: origin }: { instance: string }) => {
      if (!takesSshUrl) return null;
      return (await store.readInstance(origin)).sshUrl ?? null;
    },
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
    setSshUrl: async ({ instance: origin, sshUrl }: { instance: string; sshUrl: string | null }) => {
      if (!takesSshUrl) throw responseError(400, { error: `${descriptor.label} does not take an SSH URL` });
      let normalized;
      try { normalized = required(normalizeSshUrl)(sshUrl); }
      catch (error) { throw responseError(400, { error: errorWithMessage(error) && error.message || 'Invalid SSH URL', code: 'INVALID_SSH_URL' }); }
      await store.setSshUrl(origin, normalized);
      return { sshUrl: normalized };
    },
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
    ownsHost: (input: Parameters<typeof ownedOriginInstance>[0] & { sshPort?: number; knownSshHosts?: Array<{ instance: string; sshUrl: string }> }) => ownedOriginInstance(input)
      ?? ownedSshInstance({ ...input, parseSshUrl }),
  });

  return Object.freeze({
    auth,
    tokenFor: (session: ProviderSession) => tokens.get(session),
    userFor: (session: ProviderSession) => users.get(session),
    loginFor: (session: ProviderSession) => logins.get(session),
    sshUrlFor: (session: ProviderSession) => sshUrls.get(session) ?? null,
    readCredential: async ({ instance, credentialId, credentialRevision }: { instance: string; credentialId: string; credentialRevision?: number }) => {
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
