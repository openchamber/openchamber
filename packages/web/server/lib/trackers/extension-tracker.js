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
  trackerProviderIdOf,
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

/**
 * An installed extension's tracker (`ext-<guestId>`) as a `TrackerImplementation`
 * (`tracker-contract.d.ts`) the registry serves beside Linear. The extension's
 * service answers the forwarded calls (`POST /tracker` on its loopback, the
 * SDK's wire 1); everything that must not depend on a third party stays here:
 * the accounts and their credentials (`extension-accounts.js`), the browser
 * sign-in (`extension-oauth.js`), the project mapping, the session comment
 * preference and the session records, and which failures write an account off.
 *
 * Every call reads the guest's current catalog row (`currentGuest`), which
 * applies enterprise policy on each read: a guest that is no longer eligible
 * (paused, unapproved, refused by policy) is refused before anything is sent,
 * and the registered set is reconciled.
 *
 * The service never holds a credential. Each forwarded call carries a fresh
 * handle (`../source-control/outbound-handles.js`) bound to the instance
 * origin and, when the call acts as an account, its token; the handle ends
 * with the call. Only the two writes (`items.updateState`, `comments.create`)
 * may send anything but `GET` through their handle. A 401 the service reports
 * writes the account off only when the proxy saw the server answer 401 on that
 * handle. Answers are checked with the SDK's `trackerProviderSchemasV1`; one
 * that does not parse is `502 MALFORMED_PROVIDER_RESPONSE`, never an empty
 * answer. Every item goes to the UI with `provider` set here.
 */

const INELIGIBLE_CODES = new Set(['NO_SERVICE', 'DISABLED', 'CANCELLED']);
/** Proxy failures where the service never answered the call: the tracker is unavailable, not wrong. */
const NOT_REACHED_CODES = new Set(['SERVICE_FAILED', 'NO_SERVICE', 'DISABLED', 'REQUEST_FAILED', 'CANCELLED']);
const READ_ONLY = Object.freeze(['GET']);
/** An OAuth access token this close to expiry is refreshed before the call. */
const OAUTH_REFRESH_LEEWAY_MS = 60_000;
const LOOPBACK_HOSTS = new Set(['127.0.0.1', 'localhost', '[::1]']);
const SESSION_STATUS_KINDS = new Set(['started', 'completed', 'failure']);

/** Whether a catalog row may serve a tracker; the adapter asks again on every call. */
export const isTrackerGuest = (guest) => {
  const granted = Array.isArray(guest?.capabilityGrants) ? guest.capabilityGrants : [];
  return Boolean(guest)
    && guest.enabled !== false
    && serviceProvides(guest.service, 'tracker')
    && Boolean(guest.tracker)
    && granted.includes('service')
    && isGuestApproved({ requested: requestedGuestCapabilities(guest), granted })
    && extensionProviderId(guest.id) !== null;
};

/**
 * A server address the user typed for a `user` instance: an https origin, or
 * http on this machine so a development server can be connected. Anything
 * with a path, a query, a fragment or credentials is refused.
 */
export const normalizeTrackerInstance = (value) => {
  if (String(value) !== value) return null;
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
};

/**
 * `kind` says what a failed call means: `invalid-token`, `unavailable` (never
 * reached), `malformed`, or `provider-error`. The route answers the status and
 * code only when both are known (`TrackerRouteError`); a provider's answer that
 * carries neither is 500 there.
 */
const callError = (message, { status, code, kind = 'provider-error' } = {}) => {
  const coded = Number.isInteger(status) && typeof code === 'string' && code.length > 0;
  return Object.assign(coded ? new TrackerRouteError(status, code, message) : new Error(message), { status, code, kind });
};
const userError = (message) => Object.assign(new Error(message), { code: 'INVALID', userError: true });

/** Plain JSON of an input the shell built, without `undefined` fields. */
const json = (value) => JSON.parse(JSON.stringify(value));

const sameTarget = (a, b) => Boolean(a && b) && a.authorizeUrl === b.authorizeUrl && a.tokenUrl === b.tokenUrl;

/**
 * @param {{
 *   descriptor: import('./tracker-contract').TrackerDescriptor,
 *   guest: { id: string, name: string, packageRoot: string, service: object, capabilityGrants: string[] },
 *   contribution: import('./extension-descriptor.js').TrackerContribution,
 *   currentGuest: (guestId: string) => Promise<object | null>,
 *   reconcile: () => unknown,
 *   accounts: ReturnType<typeof import('./extension-accounts.js').createTrackerAccounts>,
 *   handles: ReturnType<typeof import('../source-control/outbound-handles.js').createOutboundHandles>,
 *   oauth: ReturnType<typeof import('./extension-oauth.js').createTrackerOAuth>,
 *   persistPath: string,
 *   proxy?: typeof proxyGuestServiceRequest,
 *   now?: () => number,
 *   createId?: () => string,
 *   warn?: (...args: unknown[]) => void,
 * }} deps `persistPath` is the extension store the guest service proxy reads
 * its enabled flag from. `reconcile` brings the registered set in step with
 * the catalog, and rebuilds this tracker's descriptor when its instance changes.
 */
export function createExtensionTracker({
  descriptor, guest, contribution, currentGuest, reconcile, accounts, handles, oauth, persistPath,
  proxy = proxyGuestServiceRequest, now = Date.now, createId = () => crypto.randomUUID(), warn = (...args) => console.warn(...args),
}) {
  const id = descriptor.id;
  const label = contribution.label;
  const tokenAuth = contribution.auth.token ?? null;
  const oauthAuth = contribution.auth.oauth ?? null;
  const fixedOrigin = contribution.instances.kind === 'fixed' ? contribution.instances.origin : null;

  // After the registry detaches the tracker, a call still running (a connect
  // waiting on the service) must not write an account into a store section
  // that removal is about to drop or already dropped.
  let disposed = false;
  const requireLive = () => {
    if (disposed) throw routeError(404, 'UNKNOWN_TRACKER', `${label} is no longer available`);
  };

  /** The guest as the catalog has it now; a guest that may no longer serve is refused before anything is sent. */
  const eligibleGuest = async () => {
    let current;
    try {
      current = await currentGuest(guest.id);
    } catch (error) {
      throw callError(`${label} could not answer: the extension catalog could not be read: ${error?.message ?? error}`, { code: 'NO_SERVICE', status: 503, kind: 'unavailable' });
    }
    if (current && isTrackerGuest(current)) return current;
    void Promise.resolve().then(reconcile).catch((error) => {
      warn('[trackers] Failed to withdraw an extension tracker:', error?.message ?? error);
    });
    throw callError(`${label} could not answer: the extension may no longer serve this tracker`, { code: 'NO_SERVICE', status: 503, kind: 'unavailable' });
  };

  /** What a handle carries to the tracker's server for a stored credential. */
  const credentialOf = (credential) => {
    if (credential.kind === 'oauth') return { token: credential.accessToken, header: 'authorization', scheme: 'bearer' };
    const value = { token: credential.token, header: tokenAuth.header, scheme: tokenAuth.scheme };
    if (tokenAuth.scheme === 'basic') value.login = credential.login;
    return value;
  };

  /**
   * One forwarded call. `credential` is what the handle carries (null for
   * `auth.probe`), `account` who the call acts as (null before one exists).
   * Answers the parsed data and what the proxy saw the call send.
   */
  const forward = async (method, { instance, credential, account, input }) => {
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
        const code = error?.code;
        throw callError(`${label} could not answer (${code ?? 'error'}): ${error?.message ?? error}`, {
          code, status: 503, kind: NOT_REACHED_CODES.has(code) ? 'unavailable' : 'provider-error',
        });
      }
      const malformed = (detail) => callError(`${label} answered something OpenChamber cannot use: ${detail}`, {
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
          // The service's word alone never writes an account off.
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
  };

  /** The stored account every call acts as: the current valid one, else null. */
  const currentAccount = (stored) => {
    if (!stored) return null;
    const active = stored.accounts.find((account) => account.id === stored.activeAccountId && account.status === 'valid');
    return active ?? stored.accounts.find((account) => account.status === 'valid') ?? null;
  };

  /**
   * The credential a call sends, refreshed first when it is an OAuth token
   * about to lapse. A refresh commits only against the revision it started
   * from; one that lands on a replaced account is dropped and the current
   * account read again.
   */
  const freshAccount = async (stored, account) => {
    const credential = account.credential;
    if (credential.kind !== 'oauth' || !credential.refreshToken || credential.expiresAt === null || credential.expiresAt - now() > OAUTH_REFRESH_LEEWAY_MS) return account;
    const client = await accounts.readClient(id, credential.target);
    if (!client) return account;
    let tokens;
    try {
      tokens = await oauth.refresh({ tokenUrl: credential.target.tokenUrl, refreshToken: credential.refreshToken, client });
    } catch (error) {
      warn(`[trackers] ${id}: the access token could not be renewed: ${error?.message ?? error}`);
      return account;
    }
    const renewed = { kind: 'oauth', accessToken: tokens.accessToken, refreshToken: tokens.refreshToken ?? credential.refreshToken, expiresAt: tokens.expiresAt, target: credential.target };
    const revision = await accounts.updateCredential(id, account.id, renewed, account.revision);
    if (!revision) return currentAccount(await accounts.read(id));
    return { ...account, revision, credential: renewed };
  };

  /** A call as the current account; null when none is connected. A refused credential writes that account off. */
  const forwardAs = async (method, input) => {
    requireLive();
    const stored = await accounts.read(id);
    // Every stored account written off reads as disconnected, as no account does.
    const current = currentAccount(stored);
    const account = current ? await freshAccount(stored, current) : null;
    if (!account) return null;
    try {
      return await forward(method, {
        instance: stored.instance,
        credential: credentialOf(account.credential),
        account: { id: account.id, login: account.login },
        input,
      });
    } catch (error) {
      if (error.kind === 'invalid-token') {
        const invalidated = await accounts.markInvalid(id, account.id, 'unauthorized', account.revision).catch(() => false);
        if (invalidated) warn(`[trackers] ${id}: the server refused the account's credential; connect it again in Settings → Integrations`);
      }
      throw error;
    }
  };

  const connectFailure = (error) => {
    if (error.kind === 'invalid-token') return routeError(401, 'TOKEN_REFUSED', `${label} refused this credential.`);
    if (error.kind === 'unavailable') return routeError(503, 'TRACKER_UNAVAILABLE', error.message);
    if (error.kind === 'malformed') return routeError(502, error.code, error.message);
    return routeError(Number.isInteger(error.status) && error.status >= 400 && error.status <= 599 ? error.status : 400, error.code ?? 'CONNECT_FAILED', error.message);
  };

  /**
   * The origin accounts live on: the fixed one, the connected one, or the one
   * typed now. A client saved before any account pins nothing: the typed
   * address wins, so a mistyped server can be corrected; without one the saved
   * address stands.
   */
  const instanceFor = (stored, typed) => {
    if (fixedOrigin) return fixedOrigin;
    const typedText = typeof typed === 'string' ? typed.trim() : '';
    if (stored?.instance && stored.accounts.length > 0) {
      const typedOrigin = typedText ? normalizeTrackerInstance(typedText) : null;
      if (typedOrigin && typedOrigin !== stored.instance) {
        throw routeError(409, 'INSTANCE_MISMATCH', `The connected accounts live on ${stored.instance}; disconnect them before connecting to ${typedOrigin}.`);
      }
      return stored.instance;
    }
    const origin = typedText ? normalizeTrackerInstance(typedText) : stored?.instance ?? null;
    if (!origin) throw routeError(400, 'INSTANCE_REQUIRED', `Enter the server address as an https origin, like ${contribution.instances.placeholder || 'https://example.org'}.`);
    return origin;
  };

  /** The cap is a matter of admission: a full tracker refuses before the service, or the browser, is asked anything. */
  const requireRoom = (stored) => {
    if (stored && stored.accounts.length >= TRACKER_ACCOUNTS_MAX) {
      throw routeError(409, 'ACCOUNTS_FULL', `At most ${TRACKER_ACCOUNTS_MAX} accounts per tracker; disconnect one first.`);
    }
  };

  const accountOf = (verified, login) => {
    const account = { id: verified.account.id, login: login ?? verified.account.login ?? null };
    if (verified.account.name) account.name = verified.account.name;
    if (verified.account.avatarUrl) account.avatarUrl = verified.account.avatarUrl;
    return account;
  };

  /** A stored account in the neutral shape, with its standing. */
  const toTrackerAccount = (account, current) => {
    const name = account.name ?? account.login ?? null;
    const view = {
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

  /** What the card needs to connect, beside the accounts: where, whether a client is saved, where the sign-in returns. */
  const connectInfo = (stored, origin) => {
    const info = {
      // Known only once an account lives there: until then the card keeps asking, so a saved client alone never hides the field.
      instance: fixedOrigin ?? (stored && stored.accounts.length > 0 ? stored.instance : null),
      instances: contribution.instances.kind === 'fixed'
        ? { kind: 'fixed', origin: fixedOrigin }
        : { kind: 'user', label: contribution.instances.label, ...(contribution.instances.placeholder ? { placeholder: contribution.instances.placeholder } : {}) },
      hasClient: Boolean(stored?.client),
      redirectUri: oauthAuth && origin ? trackerRedirectUri(origin, id) : null,
    };
    return info;
  };

  /** Disconnected with accounts means every stored account is written off: the card shows them so the user can reconnect or remove them. */
  const status = async ({ origin } = {}) => {
    const stored = await accounts.read(id);
    const current = currentAccount(stored);
    const connect = connectInfo(stored, origin ?? null);
    const views = (stored?.accounts ?? []).map((account) => toTrackerAccount(account, Boolean(current) && account.id === current.id));
    if (!current) return views.length > 0 ? { connected: false, accounts: views, connect } : { connected: false, connect };
    return { connected: true, account: toTrackerAccount(current, true), accounts: views, connect };
  };

  /** Everything the registry and the UI see goes through here: an item with this tracker's provider id. */
  const withProvider = (item) => {
    if (!item) return null;
    const result = { ...item, provider: id };
    if (item.parent !== undefined) result.parent = withProvider(item.parent);
    if (Array.isArray(item.children)) result.children = item.children.map(withProvider);
    return result;
  };
  /** The listing's view of a full item: what `items.get` adds is left out. */
  const summaryOf = ({ description, comments, children, childrenMore, ...summary }) => summary;

  const matchUrl = createDescriptorUrlMatcher(descriptor);
  const identifierShape = new RegExp(descriptor.identifierPattern);
  /**
   * A pasted link this tracker's patterns claim, or an identifier of its
   * shape, names one item: the host reads it through `items.get` instead of
   * searching, as Linear's list does, so the service never sees a link.
   */
  const directIdentifierOf = (query) => {
    const text = typeof query === 'string' ? query.trim() : '';
    if (!text) return null;
    const linked = matchUrl(text);
    if (linked) return { identifier: linked, linked: true };
    return identifierShape.test(text) ? { identifier: text.toUpperCase(), linked: false } : null;
  };

  // The browser sign-in: a `start` remembers the client and the endpoints
  // resolved against the instance; the callback exchanges the code and asks
  // the service who the tokens belong to.
  const start = async ({ callbackOrigin, instance } = {}) => {
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

  const completeAuthorization = async ({ code, state, error, errorDescription }) => {
    requireLive();
    // The state names the sign-in an answer is about. The callback is public, so an
    // answer without the matching state is nobody's, whatever it says: it cancels nothing.
    const pending = oauth.take({ providerId: id, state });
    if (!pending) throw routeError(400, 'STATE_MISMATCH', 'Authorization state was missing or expired.');
    if (error) {
      accounts.cancelConnect(id, pending.connection);
      throw routeError(400, 'OAUTH_DENIED', errorDescription || error);
    }
    // The package must still name the endpoints the user saw when they clicked Connect.
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
    const credential = { kind: 'oauth', accessToken: tokens.accessToken, refreshToken: tokens.refreshToken ?? null, expiresAt: tokens.expiresAt ?? null, target: pending.target };
    let verified;
    try {
      verified = await forward('auth.verify', { instance: pending.instance, credential: credentialOf(credential), account: null, input: {} });
    } catch (verifyError) {
      throw verifyError.kind ? connectFailure(verifyError) : verifyError;
    }
    const view = await accounts.connect(id, { instance: pending.instance, account: accountOf(verified), credential }, pending.connection);
    if (!view) throw routeError(409, 'CONNECT_SUPERSEDED', 'A newer account action replaced this sign-in.');
    void Promise.resolve().then(reconcile).catch(() => undefined);
    return view;
  };

  const connectToken = async ({ instance, token, username }) => {
    requireLive();
    if (!tokenAuth) throw routeError(404, 'UNSUPPORTED', `${label} does not sign in with a token`);
    const secret = String(token) === token ? token.trim() : '';
    if (!secret) throw routeError(400, 'TOKEN_REQUIRED', 'A token is required.');
    const login = String(username) === username && username.trim() ? username.trim() : null;
    if (tokenAuth.scheme === 'basic' && !login) throw routeError(400, 'USERNAME_REQUIRED', `${label} signs in with a username; enter it beside the token.`);
    if (login && !isProviderUsername(login)) throw routeError(400, 'USERNAME_INVALID', `${label} cannot sign in with this username: use Latin letters, digits and punctuation other than ":".`);
    const stored = await accounts.read(id);
    requireRoom(stored);
    const origin = instanceFor(stored, instance);
    const credential = { kind: 'token', token: secret, login };
    const connection = accounts.beginConnect(id);
    let verified;
    try {
      const probe = await forward('auth.probe', { instance: origin, credential: null, account: null, input: {} });
      if (!probe.supported) throw routeError(400, 'UNSUPPORTED_INSTANCE', probe.message || `${origin} is not a server ${label} can work with.`);
      verified = await forward('auth.verify', { instance: origin, credential: credentialOf(credential), account: null, input: {} });
    } catch (error) {
      throw error.kind ? connectFailure(error) : error;
    }
    // A Basic-auth server's stored login is the username the user typed, the one Basic auth accepted.
    const view = await accounts.connect(id, { instance: origin, account: accountOf(verified, tokenAuth.scheme === 'basic' ? login : undefined), credential }, connection);
    if (!view) throw routeError(409, 'CONNECT_SUPERSEDED', 'A newer account action replaced this connection.');
    void Promise.resolve().then(reconcile).catch(() => undefined);
    return view;
  };

  const setOAuthClient = async ({ instance, clientId, clientSecret }) => {
    requireLive();
    if (!oauthAuth) throw routeError(404, 'UNSUPPORTED', `${label} does not sign in through the browser`);
    const trimmedId = String(clientId) === clientId ? clientId.trim() : '';
    if (!trimmedId) throw routeError(400, 'CLIENT_MISSING', 'Client id is missing.');
    const stored = await accounts.read(id);
    // Removal may have run while the store was read: a client secret never outlives the uninstall.
    requireLive();
    const origin = instanceFor(stored, instance);
    const view = await accounts.setClient(id, {
      instance: origin, clientId: trimmedId, clientSecret: String(clientSecret) === clientSecret ? clientSecret.trim() : '', target: oauthTargetOf(oauthAuth, origin),
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

  // Session comments: one `started` record per session (written when a
  // session starts from an item), then one `completed` and one `failure` at
  // most, with the same rules Linear applies (`../linear/status.js`).
  const inflight = new Map();
  const postOnce = async (input) => {
    const kind = String(input?.kind ?? '').trim();
    const sessionId = String(input?.sessionId ?? '').trim();
    if (!SESSION_STATUS_KINDS.has(kind) || !sessionId) throw userError('kind and sessionId are required');
    const stored = await accounts.read(id);
    if (!currentAccount(stored)) return { connected: false };
    if (!(await accounts.preferences(id)).sessionComments) return { connected: true, posted: false, skipped: 'disabled' };
    const existing = await accounts.sessionRecord(id, sessionId);
    if (existing?.[kind] === true) return { connected: true, posted: false, skipped: 'already-posted' };
    if (kind !== 'started' && existing?.started !== true) return { connected: true, posted: false, skipped: 'not-started' };
    const identifier = String(input.identifier ?? '').trim().toUpperCase() || existing?.identifier || '';
    if (!identifier) throw userError('identifier is required');
    if (!identifierShape.test(identifier)) throw userError(`identifier is not a ${label} identifier`);
    const sessionOrigin = readSessionOrigin(input.sessionOrigin) || existing?.sessionOrigin || '';
    // Without an origin other people can reach, the comment would carry a link only its author could open.
    if (!isPublicSessionOrigin(sessionOrigin)) return { connected: true, posted: false, skipped: 'origin-not-public' };
    const body = buildSessionStatusComment({ kind, sessionUrl: buildSessionOpenUrl(sessionId, sessionOrigin) });
    const answer = await forwardAs('comments.create', { identifier, body });
    if (!answer) return { connected: false };
    if (!answer.comment) return { connected: true, posted: false, skipped: 'issue-not-found' };
    // The record keeps the next post of this kind away; after removal there is no next post and no store section to write.
    if (!disposed) await accounts.writeSessionRecord(id, sessionId, {
      identifier,
      sessionOrigin,
      started: existing?.started === true || kind === 'started',
      completed: existing?.completed === true || kind === 'completed',
      failure: existing?.failure === true || kind === 'failure',
    });
    return { connected: true, posted: true, commentId: answer.comment.id };
  };
  const postSessionStatus = (input) => {
    const key = `${String(input?.sessionId ?? '')}:${String(input?.kind ?? '')}`;
    const pending = inflight.get(key);
    if (pending) return pending;
    const promise = postOnce(input).finally(() => { inflight.delete(key); });
    inflight.set(key, promise);
    return promise;
  };

  const connected = (data) => (data === null ? { connected: false } : { connected: true, ...data });

  return Object.freeze({
    auth: Object.freeze({
      status,
      start,
      disconnect,
      activate: async (accountId) => {
        requireLive();
        if (!(await accounts.activate(id, accountId))) return null;
        return status();
      },
      connectToken,
      setOAuthClient,
      completeAuthorization,
    }),

    list: async ({ query, cursor, state, people, priority, containerId } = {}) => {
      const direct = directIdentifierOf(query);
      if (direct) {
        const data = await forwardAs('items.get', { id: direct.identifier });
        if (data === null) return connected(null);
        if (data.item) return connected({ items: [withProvider(summaryOf(data.item))], cursor: null, hasMore: false });
        // A link names an item that is not there. A bare word that is no identifier
        // after all is a search: a `short-code` shape claims most single words.
        if (direct.linked) return connected({ items: [], cursor: null, hasMore: false });
      }
      const data = await forwardAs('items.list', json({ query, cursor, state: state ?? 'open', people: people ?? 'any', priority: priority ?? 'all', containerId: containerId ?? null }));
      return connected(data && { items: data.items.map(withProvider), cursor: data.cursor, hasMore: data.hasMore });
    },
    get: async (itemId) => {
      const data = await forwardAs('items.get', { id: itemId });
      return connected(data && { item: withProvider(data.item) });
    },
    states: async (containerId) => connected(await forwardAs('states.list', { containerId })),
    updateState: async ({ id: itemId, stateId }) => {
      const data = await forwardAs('items.updateState', { id: itemId, stateId });
      return connected(data && { item: withProvider(data.item) });
    },
    liveSummaries: async (identifiers) => {
      const items = [];
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
      set: async (input) => {
        requireLive();
        const paths = Object.fromEntries(Object.entries(input?.containerProjectPaths ?? {}).filter(([, value]) => String(value) === value && value.trim()));
        // A mapping belongs to the connected server: with no account there is nothing to map it for.
        if (!currentAccount(await accounts.read(id))) return { connected: false };
        await accounts.setMapping(id, { defaultProjectPath: String(input?.defaultProjectPath ?? '') === input?.defaultProjectPath && input.defaultProjectPath.trim() ? input.defaultProjectPath : null, containerProjectPaths: paths });
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
      set: ({ sessionComments }) => { requireLive(); return accounts.setPreferences(id, { sessionComments }); },
    }),

    sessionStatus: Object.freeze({
      post: postSessionStatus,
      createRuntime: () => createSessionStatusRuntime({ label: id, warn, post: postSessionStatus }),
    }),

    /** Called by the extension layer when it detaches the tracker: account writes still in flight are refused. */
    dispose: () => {
      disposed = true;
      accounts.cancelConnect(id);
      oauth.dropProvider(id);
    },
  });
}

