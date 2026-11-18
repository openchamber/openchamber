import crypto from 'node:crypto';

import {
  SOURCE_CONTROL_OUTBOUND_METHODS,
  TRACKER_PROVIDER_IDLE_MS,
  TRACKER_PROVIDER_LIVE_SUMMARIES_MAX,
  TRACKER_PROVIDER_PATH,
  TRACKER_PROVIDER_RESPONSE_MAX,
  TRACKER_PROVIDER_WIRE_VERSION,
  isGuestApproved,
  isTrackerProviderWriteMethod,
  requestedGuestCapabilities,
  serviceProvides,
  trackerProviderTimeoutMs,
} from '@openchamber/sdk';
import { trackerProviderSchemasV1 as schemas } from '@openchamber/sdk/schemas';

import { GuestOAuthError } from '../guests/oauth.js';
import { proxyGuestServiceRequest } from '../guests/service.js';
import { extensionProviderId, isProviderUsername } from '../source-control/provider-id.js';
import { TRACKER_ACCOUNTS_MAX } from './extension-accounts.js';
import { createDescriptorUrlMatcher } from './extension-descriptor.js';
import { oauthTargetOf, trackerRedirectUri } from './extension-oauth.js';
import { TrackerRouteError, routeError } from './route-error.js';
import { createSessionStatusRuntime } from './session-status-runtime.js';
import { buildSessionOpenUrl, buildSessionStatusComment, isPublicSessionOrigin, readSessionOrigin } from './session-origin.js';
import { z } from 'zod';
import type { TrackerProviderInputs, TrackerProviderMethod } from '@openchamber/sdk';
import type { GuestRecord } from '../guests/contracts.js';
import type { createOutboundHandles } from '../source-control/outbound-handles.js';
import type { createTrackerAccounts, StoredTracker, StoredTrackerAccount, TrackerCredential } from './extension-accounts.js';
import type { TrackerContribution } from './extension-descriptor.js';
import type { createTrackerOAuth, TrackerOAuthTarget } from './extension-oauth.js';
import type { Connected, TrackerAccount, TrackerAuthStatus, TrackerConnectInfo, TrackerDescriptor, TrackerImplementation, TrackerListOptions, TrackerMappingRequest, TrackerPreferences, TrackerSessionStatusInput, TrackerSessionStatusResult } from './tracker-contract.js';


const NOT_REACHED_CODES = new Set(['SERVICE_FAILED', 'NO_SERVICE', 'DISABLED', 'REQUEST_FAILED', 'CANCELLED']);
const READ_ONLY = Object.freeze(['GET']);
const OAUTH_REFRESH_LEEWAY_MS = 60_000;
const LOOPBACK_HOSTS = new Set(['127.0.0.1', 'localhost', '[::1]']);
const SESSION_STATUS_KINDS = new Set(['started', 'completed', 'failure']);

export type TrackerGuest = GuestRecord & Required<Pick<GuestRecord, 'service' | 'tracker' | 'capabilityGrants'>>;
export type ProviderData = { [K in TrackerProviderMethod]: z.output<typeof schemas.data[K]> };
type ProviderItem = z.output<typeof schemas.item>;
type WithProvider<T> = T extends null ? null : T & { provider: string };
type ForwardCredential = NonNullable<Parameters<ReturnType<typeof createOutboundHandles>['mint']>[0]['credential']>;
type ForwardOptions<K extends TrackerProviderMethod> = {
  instance: string | null;
  credential: ForwardCredential | null;
  account: { id: string; login: string | null } | null;
  input: TrackerProviderInputs[K];
};
export type ExtensionTrackerOptions = {
  descriptor: TrackerDescriptor;
  guest: Pick<TrackerGuest, 'id' | 'name' | 'packageRoot' | 'service' | 'capabilityGrants'>;
  contribution: TrackerContribution;
  currentGuest: (guestId: string) => Promise<GuestRecord | null>;
  reconcile: () => void | Promise<void>;
  accounts: ReturnType<typeof createTrackerAccounts>;
  handles: ReturnType<typeof createOutboundHandles>;
  oauth: ReturnType<typeof createTrackerOAuth>;
  persistPath: string;
  proxy?: typeof proxyGuestServiceRequest | undefined;
  now?: () => number;
  createId?: () => string;
  warn?: (...args: unknown[]) => void;
};

const isText = (value: unknown): value is string => typeof value === 'string';
const isPrimitiveText = (value: unknown): value is string => String(value) === value;
const isMappingPath = (value: unknown): value is string => String(value ?? '') === value;
const hasErrorFields = (value: unknown): value is { message?: unknown; kind?: unknown; code?: unknown; status?: unknown } => value !== null
  && (typeof value === 'object' || typeof value === 'function');
const errorMessageSchema = z.unknown().transform((value) => value === undefined ? undefined : `${value}`);
const isHttpStatus = (value: unknown): value is number => Number.isInteger(value) && Number(value) >= 400 && Number(value) <= 599;
const isStatusKind = (value: string): value is TrackerSessionStatusInput['kind'] => SESSION_STATUS_KINDS.has(value);

export const isTrackerGuest = (guest: GuestRecord | null | undefined): guest is TrackerGuest => {
  const granted = Array.isArray(guest?.capabilityGrants) ? guest.capabilityGrants : [];
  return guest != null
    && guest.enabled !== false
    && serviceProvides(guest.service, 'tracker')
    && Boolean(guest.tracker)
    && granted.includes('service')
    && isGuestApproved({ requested: requestedGuestCapabilities(guest), granted })
    && extensionProviderId(guest.id) !== null;
};

const trackerInstanceSchema = z.unknown().transform((value) => {
  if (!isPrimitiveText(value)) return null;
  let url;
  try {
    url = new URL(value.trim());
  } catch {
    return null;
  }
  if (url.username || url.password || url.search || url.hash || (url.pathname !== '/' && url.pathname !== '')) return null;
  if (url.protocol === 'https:') return url.origin;
  if (url.protocol === 'http:' && LOOPBACK_HOSTS.has(url.hostname)) return url.origin;
  return null;
});
export const normalizeTrackerInstance = trackerInstanceSchema.parse;

const callError = (message: string, { status, code, kind = 'provider-error' }: { status?: number | undefined; code?: unknown; kind?: string } = {}) => {
  const coded = Number.isInteger(status) && isText(code) && code.length > 0;
  return Object.assign(coded ? new TrackerRouteError(Number(status), code, message) : new Error(message), { status, code, kind });
};
const userError = (message: string) => Object.assign(new Error(message), { code: 'INVALID', userError: true });

const json = (value: Omit<TrackerProviderInputs['items.list'], 'query' | 'cursor'> & {
  query: string | undefined; cursor: string | undefined;
}): TrackerProviderInputs['items.list'] => JSON.parse(JSON.stringify(value));

const sameTarget = (a: TrackerOAuthTarget, b: TrackerOAuthTarget) => Boolean(a && b) && a.authorizeUrl === b.authorizeUrl && a.tokenUrl === b.tokenUrl;

export function createExtensionTracker({
  descriptor, guest, contribution, currentGuest, reconcile, accounts, handles, oauth, persistPath,
  proxy = proxyGuestServiceRequest, now = Date.now, createId = () => crypto.randomUUID(), warn = (...args) => console.warn(...args),
}: ExtensionTrackerOptions) {
  const id = descriptor.id;
  const label = contribution.label;
  const tokenAuth = contribution.auth.token ?? null;
  const oauthAuth = contribution.auth.oauth ?? null;
  const fixedOrigin = contribution.instances.kind === 'fixed' ? contribution.instances.origin : null;

  let disposed = false;
  const requireLive = () => {
    if (disposed) throw routeError(404, 'UNKNOWN_TRACKER', `${label} is no longer available`);
  };

  const eligibleGuest = async () => {
    let current;
    try {
      current = await currentGuest(guest.id);
    } catch (error) {
      throw callError(`${label} could not answer: the extension catalog could not be read: ${hasErrorFields(error) ? error.message ?? error : error}`, { code: 'NO_SERVICE', status: 503, kind: 'unavailable' });
    }
    if (current && isTrackerGuest(current)) return current;
    void Promise.resolve().then(reconcile).catch((error) => {
      warn('[trackers] Failed to withdraw an extension tracker:', error?.message ?? error);
    });
    throw callError(`${label} could not answer: the extension may no longer serve this tracker`, { code: 'NO_SERVICE', status: 503, kind: 'unavailable' });
  };

  const credentialOf = (credential: TrackerCredential): ForwardCredential => {
    if (credential.kind === 'oauth') return { token: credential.accessToken, header: 'authorization', scheme: 'bearer' };
    const auth = tokenAuth;
    if (!auth) throw new TypeError("Cannot read properties of null (reading 'header')");
    const value: ForwardCredential = { token: credential.token, header: auth.header, scheme: auth.scheme };
    if (auth.scheme === 'basic') value.login = credential.login;
    return value;
  };

  function forward<K extends TrackerProviderMethod>(method: K, options: ForwardOptions<K>): Promise<ProviderData[K]>;
  async function forward(method: TrackerProviderMethod, { instance, credential, account, input }: ForwardOptions<TrackerProviderMethod>) {
    const current = await eligibleGuest();
    const timeoutMs = trackerProviderTimeoutMs(method);
    const grant = handles.mint({
      guestId: guest.id,
      providerId: id,
      origin: instance,
      credential,
      deadline: now() + timeoutMs,
      methods: isTrackerProviderWriteMethod(method) ? SOURCE_CONTROL_OUTBOUND_METHODS : READ_ONLY,
    });
    try {
      let proxied;
      try {
        proxied = await proxy({
          guestId: guest.id,
          guestName: guest.name,
          packageRoot: guest.packageRoot,
          service: guest.service,
          granted: current.capabilityGrants,
          persistPath,
          method: 'POST',
          path: TRACKER_PROVIDER_PATH,
          body: JSON.stringify({
            v: TRACKER_PROVIDER_WIRE_VERSION,
            requestId: createId(),
            method,
            provider: id,
            session: { instance, handle: grant.handle, account },
            input,
          }),
          timeoutMs,
          responseMax: TRACKER_PROVIDER_RESPONSE_MAX,
          idleStopMs: TRACKER_PROVIDER_IDLE_MS,
        });
      } catch (error) {
        const code = hasErrorFields(error) ? error.code : undefined;
        throw callError(`${label} could not answer (${code ?? 'error'}): ${hasErrorFields(error) ? error.message ?? error : error}`, {
          code, status: 503, kind: NOT_REACHED_CODES.has(isText(code) ? code : '') ? 'unavailable' : 'provider-error',
        });
      }
      const malformed = (detail: string) => callError(`${label} answered something OpenChamber cannot use: ${detail}`, {
        status: 502, code: 'MALFORMED_PROVIDER_RESPONSE', kind: 'malformed',
      });
      if (proxied.status !== 200) throw malformed(`HTTP ${proxied.status}`);
      let envelope;
      try {
        envelope = schemas.envelope.safeParse(JSON.parse(proxied.body));
      } catch {
        throw malformed('not JSON');
      }
      if (!envelope.success) throw malformed('not a tracker answer');
      if (!envelope.data.ok) {
        const { message, status, code } = envelope.data.error;
        if (status === 401) {
          if (!grant.outbound.some((request) => request.status === 401)) throw malformed('a 401 the server did not give');
          throw callError(message, { status, code, kind: 'invalid-token' });
        }
        throw callError(message, { status, code });
      }
      const data = schemas.data[method].safeParse(envelope.data.data);
      if (!data.success) throw malformed(`${method} does not match its schema`);
      return data.data;
    } finally {
      grant.revoke();
    }
  }

  const currentAccount = (stored: StoredTracker | null) => {
    if (!stored) return null;
    const active = stored.accounts.find((account) => account.id === stored.activeAccountId && account.status === 'valid');
    return active ?? stored.accounts.find((account) => account.status === 'valid') ?? null;
  };

  const freshAccount = async (stored: StoredTracker | null, account: StoredTrackerAccount) => {
    const credential = account.credential;
    if (credential.kind !== 'oauth' || !credential.refreshToken || credential.expiresAt === null || credential.expiresAt - now() > OAUTH_REFRESH_LEEWAY_MS) return account;
    const client = await accounts.readClient(id, credential.target);
    if (!client) return account;
    let tokens;
    try {
      tokens = await oauth.refresh({ tokenUrl: credential.target.tokenUrl, refreshToken: credential.refreshToken, client });
    } catch (error) {
      warn(`[trackers] ${id}: the access token could not be renewed: ${hasErrorFields(error) ? error.message ?? error : error}`);
      return account;
    }
    const renewed: TrackerCredential = { kind: 'oauth', accessToken: tokens.accessToken, refreshToken: tokens.refreshToken ?? credential.refreshToken, expiresAt: tokens.expiresAt, target: credential.target };
    const revision = await accounts.updateCredential(id, account.id, renewed, account.revision);
    if (!revision) return currentAccount(await accounts.read(id));
    return { ...account, revision, credential: renewed };
  };

  const forwardAs = async <K extends TrackerProviderMethod>(method: K, input: TrackerProviderInputs[K]) => {
    requireLive();
    const stored = await accounts.read(id);
    const current = currentAccount(stored);
    const account = current ? await freshAccount(stored, current) : null;
    if (!account || !stored) return null;
    try {
      return await forward(method, {
        instance: stored.instance,
        credential: credentialOf(account.credential),
        account: { id: account.id, login: account.login },
        input,
      });
    } catch (error) {
      if (hasErrorFields(error) && error.kind === 'invalid-token') {
        const invalidated = await accounts.markInvalid(id, account.id, 'unauthorized', account.revision).catch(() => false);
        if (invalidated) warn(`[trackers] ${id}: the server refused the account's credential; connect it again in Settings → Integrations`);
      }
      throw error;
    }
  };

  const connectFailure = (error: { kind?: unknown; code?: unknown; status?: unknown; message?: unknown }) => {
    if (error.kind === 'invalid-token') return routeError(401, 'TOKEN_REFUSED', `${label} refused this credential.`);
    if (error.kind === 'unavailable') return routeError(503, 'TRACKER_UNAVAILABLE', errorMessageSchema.parse(error.message));
    if (error.kind === 'malformed') return routeError(502, error.code, errorMessageSchema.parse(error.message));
    return routeError(isHttpStatus(error.status) ? error.status : 400, error.code ?? 'CONNECT_FAILED', errorMessageSchema.parse(error.message));
  };

  const instanceFor = (stored: StoredTracker | null, typed: string | undefined) => {
    if (fixedOrigin) return fixedOrigin;
    const typedText = isText(typed) ? typed.trim() : '';
    if (stored?.instance && stored.accounts.length > 0) {
      const typedOrigin = typedText ? normalizeTrackerInstance(typedText) : null;
      if (typedOrigin && typedOrigin !== stored.instance) {
        throw routeError(409, 'INSTANCE_MISMATCH', `The connected accounts live on ${stored.instance}; disconnect them before connecting to ${typedOrigin}.`);
      }
      return stored.instance;
    }
    const origin = typedText ? normalizeTrackerInstance(typedText) : stored?.instance ?? null;
    if (!origin) throw routeError(400, 'INSTANCE_REQUIRED', `Enter the server address as an https origin, like ${('placeholder' in contribution.instances && contribution.instances.placeholder) || 'https://example.org'}.`);
    return origin;
  };

  const requireRoom = (stored: StoredTracker | null) => {
    if (stored && stored.accounts.length >= TRACKER_ACCOUNTS_MAX) {
      throw routeError(409, 'ACCOUNTS_FULL', `At most ${TRACKER_ACCOUNTS_MAX} accounts per tracker; disconnect one first.`);
    }
  };

  const accountOf = (verified: ProviderData['auth.verify'], login?: string | null) => {
    const account: Parameters<ReturnType<typeof createTrackerAccounts>['connect']>[1]['account'] = { id: verified.account.id, login: login ?? verified.account.login ?? null };
    if (verified.account.name) account.name = verified.account.name;
    if (verified.account.avatarUrl) account.avatarUrl = verified.account.avatarUrl;
    return account;
  };

  const toTrackerAccount = (account: StoredTrackerAccount, current: boolean) => {
    const name = account.name ?? account.login ?? null;
    const view: TrackerAccount = {
      id: account.id,
      name,
      user: { name, avatarUrl: account.avatarUrl ?? null },
      current,
      authorizedAt: account.connectedAt,
      status: account.status,
      method: account.credential.kind,
    };
    if (account.invalidReason) view.invalidReason = account.invalidReason;
    return view;
  };

  const connectInfo = (stored: StoredTracker | null, origin: string | null) => {
    const instances: TrackerConnectInfo['instances'] = contribution.instances.kind === 'fixed'
      ? { kind: 'fixed', origin: contribution.instances.origin }
      : { kind: 'user', label: contribution.instances.label };
    if (instances.kind === 'user' && contribution.instances.kind === 'user' && contribution.instances.placeholder) {
      instances.placeholder = contribution.instances.placeholder;
    }
    const info: TrackerConnectInfo = {
      instance: fixedOrigin ?? (stored && stored.accounts.length > 0 ? stored.instance : null),
      instances,
      hasClient: Boolean(stored?.client),
      redirectUri: oauthAuth && origin ? trackerRedirectUri(origin, id) : null,
    };
    return info;
  };

  const status = async ({ origin }: { origin?: string | null } = {}): Promise<TrackerAuthStatus> => {
    const stored = await accounts.read(id);
    const current = currentAccount(stored);
    const connect = connectInfo(stored, origin ?? null);
    const views = (stored?.accounts ?? []).map((account) => toTrackerAccount(account, current !== null && account.id === current.id));
    if (!current) return views.length > 0 ? { connected: false, accounts: views, connect } : { connected: false, connect };
    return { connected: true, account: toTrackerAccount(current, true), accounts: views, connect };
  };

  function withProvider<T extends ProviderItem | null>(item: T): WithProvider<T>;
  function withProvider(item: ProviderItem | null): (ProviderItem & { provider: string }) | null {
    if (!item) return null;
    const result = { ...item, provider: id };
    if (item.parent !== undefined) result.parent = withProvider(item.parent);
    if (Array.isArray(item.children)) result.children = item.children.map((child) => withProvider(child));
    return result;
  }
  const summaryOf = ({ description: _description, comments: _comments, children: _children, childrenMore: _childrenMore, ...summary }: ProviderItem) => summary;

  const matchUrl = createDescriptorUrlMatcher(descriptor);
  const identifierPattern = new RegExp(descriptor.identifierPattern);
  const directIdentifierOf = (query: string | undefined) => {
    const text = isText(query) ? query.trim() : '';
    if (!text) return null;
    const linked = matchUrl(text);
    if (linked) return { identifier: linked, linked: true };
    return identifierPattern.test(text) ? { identifier: text.toUpperCase(), linked: false } : null;
  };

  const start = async ({ callbackOrigin, instance }: Parameters<TrackerImplementation['auth']['start']>[0] = {}) => {
    requireLive();
    if (!oauthAuth) throw routeError(404, 'UNSUPPORTED', `${label} does not sign in through the browser`);
    if (!callbackOrigin) throw routeError(400, 'ORIGIN_REQUIRED', 'The sign-in needs the address this OpenChamber is opened at.');
    const stored = await accounts.read(id);
    requireRoom(stored);
    const origin = instanceFor(stored, instance);
    const target = oauthTargetOf(oauthAuth, origin);
    const client = await accounts.readClient(id, target);
    if (!client) throw routeError(400, 'CLIENT_MISSING', 'Save the client id first.');
    const connection = accounts.beginConnect(id);
    return oauth.start({
      providerId: id, instance: origin, client, target, scopes: oauthAuth.scopes ?? [], redirectUri: trackerRedirectUri(callbackOrigin, id), connection,
    });
  };

  const completeAuthorization = async ({ code, state, error, errorDescription }: Parameters<NonNullable<TrackerImplementation['auth']['completeAuthorization']>>[0]) => {
    requireLive();
    const pending = oauth.take({ providerId: id, state });
    if (!pending) throw routeError(400, 'STATE_MISMATCH', 'Authorization state was missing or expired.');
    if (error) {
      accounts.cancelConnect(id, pending.connection);
      throw routeError(400, 'OAUTH_DENIED', errorDescription || error);
    }
    if (!oauthAuth || !sameTarget(oauthTargetOf(oauthAuth, pending.instance), pending.target)) {
      accounts.cancelConnect(id, pending.connection);
      throw routeError(400, 'TARGET_CHANGED', 'The extension changed its endpoints while you were signing in. Review it in Settings → Extensions and connect again.');
    }
    if (!code) throw routeError(400, 'CODE_MISSING', 'The authorization code is missing.');
    let tokens;
    try {
      tokens = await oauth.exchange(pending, code);
    } catch (exchangeError) {
      if (exchangeError instanceof GuestOAuthError) throw routeError(400, exchangeError.code, exchangeError.message);
      throw exchangeError;
    }
    const credential: TrackerCredential = { kind: 'oauth', accessToken: tokens.accessToken, refreshToken: tokens.refreshToken ?? null, expiresAt: tokens.expiresAt ?? null, target: pending.target };
    let verified;
    try {
      verified = await forward('auth.verify', { instance: pending.instance, credential: credentialOf(credential), account: null, input: {} });
    } catch (verifyError) {
      throw hasErrorFields(verifyError) && verifyError.kind ? connectFailure(verifyError) : verifyError;
    }
    const view = await accounts.connect(id, { instance: pending.instance, account: accountOf(verified), credential }, pending.connection);
    if (!view) throw routeError(409, 'CONNECT_SUPERSEDED', 'A newer account action replaced this sign-in.');
    void Promise.resolve().then(reconcile).catch(() => undefined);
    return view;
  };

  const connectToken = async ({ instance, token, username }: Parameters<NonNullable<TrackerImplementation['auth']['connectToken']>>[0]) => {
    requireLive();
    if (!tokenAuth) throw routeError(404, 'UNSUPPORTED', `${label} does not sign in with a token`);
    const secret = isPrimitiveText(token) ? token.trim() : '';
    if (!secret) throw routeError(400, 'TOKEN_REQUIRED', 'A token is required.');
    const login = isPrimitiveText(username) && username.trim() ? username.trim() : null;
    if (tokenAuth.scheme === 'basic' && !login) throw routeError(400, 'USERNAME_REQUIRED', `${label} signs in with a username; enter it beside the token.`);
    if (login && !isProviderUsername(login)) throw routeError(400, 'USERNAME_INVALID', `${label} cannot sign in with this username: use Latin letters, digits and punctuation other than ":".`);
    const stored = await accounts.read(id);
    requireRoom(stored);
    const origin = instanceFor(stored, instance);
    const credential: TrackerCredential = { kind: 'token', token: secret, login };
    const connection = accounts.beginConnect(id);
    let verified;
    try {
      const probe = await forward('auth.probe', { instance: origin, credential: null, account: null, input: {} });
      if (!probe.supported) throw routeError(400, 'UNSUPPORTED_INSTANCE', probe.message || `${origin} is not a server ${label} can work with.`);
      verified = await forward('auth.verify', { instance: origin, credential: credentialOf(credential), account: null, input: {} });
    } catch (error) {
      throw hasErrorFields(error) && error.kind ? connectFailure(error) : error;
    }
    const view = await accounts.connect(id, { instance: origin, account: accountOf(verified, tokenAuth.scheme === 'basic' ? login : undefined), credential }, connection);
    if (!view) throw routeError(409, 'CONNECT_SUPERSEDED', 'A newer account action replaced this connection.');
    void Promise.resolve().then(reconcile).catch(() => undefined);
    return view;
  };

  const setOAuthClient = async ({ instance, clientId, clientSecret }: Parameters<NonNullable<TrackerImplementation['auth']['setOAuthClient']>>[0]) => {
    requireLive();
    if (!oauthAuth) throw routeError(404, 'UNSUPPORTED', `${label} does not sign in through the browser`);
    const trimmedId = isPrimitiveText(clientId) ? clientId.trim() : '';
    if (!trimmedId) throw routeError(400, 'CLIENT_MISSING', 'Client id is missing.');
    const stored = await accounts.read(id);
    requireLive();
    const origin = instanceFor(stored, instance);
    const view = await accounts.setClient(id, {
      instance: origin, clientId: trimmedId, clientSecret: isPrimitiveText(clientSecret) ? clientSecret.trim() : '', target: oauthTargetOf(oauthAuth, origin),
    });
    void Promise.resolve().then(reconcile).catch(() => undefined);
    return view;
  };

  const disconnect = async () => {
    requireLive();
    const stored = await accounts.read(id);
    const target = currentAccount(stored) ?? stored?.accounts[0] ?? null;
    oauth.dropProvider(id);
    accounts.cancelConnect(id);
    if (!target) return { removed: false };
    const removed = await accounts.removeAccount(id, target.id);
    void Promise.resolve().then(reconcile).catch(() => undefined);
    return { removed };
  };

  const inflight = new Map<string, Promise<TrackerSessionStatusResult>>();
  const postOnce = async (input: TrackerSessionStatusInput): Promise<TrackerSessionStatusResult> => {
    const kind = String(input?.kind ?? '').trim();
    const sessionId = String(input?.sessionId ?? '').trim();
    if (!isStatusKind(kind) || !sessionId) throw userError('kind and sessionId are required');
    const stored = await accounts.read(id);
    if (!currentAccount(stored)) return { connected: false };
    if (!(await accounts.preferences(id)).sessionComments) return { connected: true, posted: false, skipped: 'disabled' };
    const existing = await accounts.sessionRecord(id, sessionId);
    if (existing?.[kind] === true) return { connected: true, posted: false, skipped: 'already-posted' };
    if (kind !== 'started' && existing?.started !== true) return { connected: true, posted: false, skipped: 'not-started' };
    const identifier = String(input.identifier ?? '').trim().toUpperCase() || existing?.identifier || '';
    if (!identifier) throw userError('identifier is required');
    if (!identifierPattern.test(identifier)) throw userError(`identifier is not a ${label} identifier`);
    const sessionOrigin = readSessionOrigin(input.sessionOrigin) || existing?.sessionOrigin || '';
    if (!isPublicSessionOrigin(sessionOrigin)) return { connected: true, posted: false, skipped: 'origin-not-public' };
    const body = buildSessionStatusComment({ kind, sessionUrl: buildSessionOpenUrl(sessionId, sessionOrigin) });
    const answer = await forwardAs('comments.create', { identifier, body });
    if (!answer) return { connected: false };
    if (!answer.comment) return { connected: true, posted: false, skipped: 'issue-not-found' };
    if (!disposed) await accounts.writeSessionRecord(id, sessionId, {
      identifier,
      sessionOrigin,
      started: existing?.started === true || kind === 'started',
      completed: existing?.completed === true || kind === 'completed',
      failure: existing?.failure === true || kind === 'failure',
    });
    return { connected: true, posted: true, commentId: answer.comment.id };
  };
  const postSessionStatus = (input: TrackerSessionStatusInput) => {
    const key = `${String(input?.sessionId ?? '')}:${String(input?.kind ?? '')}`;
    const pending = inflight.get(key);
    if (pending) return pending;
    const promise = postOnce(input).finally(() => { inflight.delete(key); });
    inflight.set(key, promise);
    return promise;
  };

  function connected(data: null): { connected: false };
  function connected<T extends object>(data: T | null): Connected<T>;
  function connected<T extends object>(data: T | null): Connected<T> {
    return data === null ? { connected: false } : { connected: true, ...data };
  }

  return Object.freeze({
    auth: Object.freeze({
      status,
      start,
      disconnect,
      activate: async (accountId: string) => {
        requireLive();
        if (!(await accounts.activate(id, accountId))) return null;
        return status();
      },
      connectToken,
      setOAuthClient,
      completeAuthorization,
    }),

    list: async ({ query, cursor, state, people, priority, containerId }: TrackerListOptions = {}) => {
      const direct = directIdentifierOf(query);
      if (direct) {
        const data = await forwardAs('items.get', { id: direct.identifier });
        if (data === null) return connected(null);
        if (data.item) return connected({ items: [withProvider(summaryOf(data.item))], cursor: null, hasMore: false });
        if (direct.linked) return connected({ items: [], cursor: null, hasMore: false });
      }
      const data = await forwardAs('items.list', json({ query, cursor, state: state ?? 'open', people: people ?? 'any', priority: priority ?? 'all', containerId: containerId ?? null }));
      return connected(data && { items: data.items.map((item) => withProvider(item)), cursor: data.cursor, hasMore: data.hasMore });
    },
    get: async (itemId: string) => {
      const data = await forwardAs('items.get', { id: itemId });
      return connected(data && { item: withProvider(data.item) });
    },
    states: async (containerId: string) => connected(await forwardAs('states.list', { containerId })),
    updateState: async ({ id: itemId, stateId }: { id: string; stateId: string }) => {
      const data = await forwardAs('items.updateState', { id: itemId, stateId });
      return connected(data && { item: withProvider(data.item) });
    },
    liveSummaries: async (identifiers: string[]) => {
      const items: ProviderData['items.liveSummaries']['items'] = [];
      for (let index = 0; index < identifiers.length; index += TRACKER_PROVIDER_LIVE_SUMMARIES_MAX) {
        const data = await forwardAs('items.liveSummaries', { identifiers: identifiers.slice(index, index + TRACKER_PROVIDER_LIVE_SUMMARIES_MAX) });
        if (!data) return { connected: false };
        items.push(...data.items);
      }
      return { connected: true, items };
    },
    matchUrl,

    mapping: Object.freeze({
      get: async () => {
        const data = await forwardAs('containers.list', {});
        if (!data) return { connected: false };
        const mapping = await accounts.mapping(id);
        return {
          connected: true,
          defaultProjectPath: mapping.defaultProjectPath,
          containers: data.containers.map((container) => ({ ...container, projectPath: mapping.containerProjectPaths[container.id] ?? null })),
        };
      },
      set: async (input: TrackerMappingRequest) => {
        requireLive();
        const paths = Object.fromEntries(Object.entries(input?.containerProjectPaths ?? {}).filter((entry): entry is [string, string] => isPrimitiveText(entry[1]) && Boolean(entry[1].trim())));
        if (!currentAccount(await accounts.read(id))) return { connected: false };
        await accounts.setMapping(id, { defaultProjectPath: isMappingPath(input?.defaultProjectPath) && input.defaultProjectPath.trim() ? input.defaultProjectPath : null, containerProjectPaths: paths });
        const data = await forwardAs('containers.list', {});
        if (!data) return { connected: false };
        const mapping = await accounts.mapping(id);
        return {
          connected: true,
          defaultProjectPath: mapping.defaultProjectPath,
          containers: data.containers.map((container) => ({ ...container, projectPath: mapping.containerProjectPaths[container.id] ?? null })),
        };
      },
    }),

    preferences: Object.freeze({
      get: () => accounts.preferences(id),
      set: ({ sessionComments }: TrackerPreferences) => { requireLive(); return accounts.setPreferences(id, { sessionComments }); },
    }),

    sessionStatus: Object.freeze({
      post: postSessionStatus,
      createRuntime: () => createSessionStatusRuntime({ label: id, warn, post: postSessionStatus }),
    }),

    dispose: () => {
      disposed = true;
      accounts.cancelConnect(id);
      oauth.dropProvider(id);
    },
  });
}
