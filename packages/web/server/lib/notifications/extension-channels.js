import crypto from 'node:crypto';

import {
  NOTIFICATIONS_PROVIDER_IDLE_MS,
  NOTIFICATIONS_PROVIDER_PATH,
  NOTIFICATIONS_PROVIDER_RESPONSE_MAX,
  NOTIFICATIONS_PROVIDER_WIRE_VERSION,
  SOURCE_CONTROL_OUTBOUND_METHODS,
  isGuestApproved,
  notificationProviderIdOf,
  notificationsProviderTimeoutMs,
  requestedGuestCapabilities,
  serviceProvides,
  toPublicNotifications,
} from '@openchamber/sdk';
import { notificationsProviderSchemasV1 as schemas } from '@openchamber/sdk/schemas';

import { isProviderUsername } from '../source-control/provider-id.js';
import { isEnterpriseMode } from '../enterprise-mode.js';
import { genericNotificationTitle } from './message.js';

/**
 * Extension notification channels (`provides: ["notifications"]`): which
 * installed extensions deliver the user's notifications right now, the
 * account each one sends as, and the delivery itself.
 *
 * The catalog is the authority, never an event: `reconcile()` reads it and
 * keeps the registered set in step (after approval, enable, install, update,
 * pause, removal and withdrawn approval). A guest is a channel when it is
 * enabled, fully approved with an effective `service` grant, provides
 * `notifications` and has a parsed `contributes.notifications`. Approving the
 * extension and connecting an account is the whole switch; pausing it is the
 * off. Which kinds reach a channel is decided before `deliver` is called, by
 * the user's own notification toggles in `runtime.js`.
 *
 * Accounts are OpenChamber's (`channel-accounts.js`): the user connects one
 * through the routes in `channel-routes.js`, the token stays here, and the
 * service never sees it. Each forwarded call carries a fresh handle
 * (`../source-control/outbound-handles.js`) bound to the account's origin and
 * token; the service reaches the channel's server through the callback
 * listener with that handle, and the handle ends with the call. A 401 the
 * service reports writes the account off only when the proxy saw the server
 * answer 401 on that handle.
 *
 * Delivery is at most once: a channel whose service fails or whose account
 * is written off gets one warning a minute and nothing is retried. Nothing
 * here logs a notification's text.
 */

const INELIGIBLE_CODES = new Set(['NO_SERVICE', 'DISABLED', 'CANCELLED']);
/** Proxy failures where the service never answered the call: the channel is unavailable, not wrong. */
const NOT_REACHED_CODES = new Set(['SERVICE_FAILED', 'NO_SERVICE', 'DISABLED', 'REQUEST_FAILED', 'CANCELLED']);
const WARN_INTERVAL_MS = 60_000;
const CHANNEL_PENDING_MAX = 200;
const LOOPBACK_HOSTS = new Set(['127.0.0.1', 'localhost', '[::1]']);

/** Whether a catalog row may deliver notifications; the runtime asks again on every call. */
export const isNotificationChannelGuest = (guest) => {
  const granted = Array.isArray(guest?.capabilityGrants) ? guest.capabilityGrants : [];
  return Boolean(guest)
    && guest.enabled !== false
    && serviceProvides(guest.service, 'notifications')
    && Boolean(guest.notifications)
    && granted.includes('service')
    && isGuestApproved({ requested: requestedGuestCapabilities(guest), granted });
};

/**
 * A server address the user typed for a `user` instance: an https origin, or
 * http on this machine so a development receiver can be connected. Anything
 * with a path, a query, a fragment or credentials is refused; the service
 * builds the paths.
 */
export const normalizeChannelInstance = (value) => {
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

const routeError = (status, code, message) => Object.assign(new Error(message), { status, code });

/**
 * The server a stored account's token belongs to. A `fixed` channel whose
 * manifest now names another server gets null: the token was given for the
 * old one and goes nowhere until the user connects again.
 */
const accountInstanceOf = (contribution, stored) => (
  contribution.instances.kind === 'fixed' && stored.instance !== contribution.instances.origin ? null : stored.instance
);

/** `kind` says what a failed call means: `invalid-token`, `unavailable` (never reached), `malformed`, or `provider-error`. */
const callError = (message, { status, code, kind = 'provider-error' } = {}) => {
  const error = new Error(message);
  if (status !== undefined) error.status = status;
  if (code !== undefined) error.code = code;
  error.kind = kind;
  return error;
};

/** What a handle carries to the channel's server, per the contribution's token block; `basic` pairs it with the login. */
const credentialOf = (contribution, token, login) => {
  const credential = { token, header: contribution.token.header, scheme: contribution.token.scheme };
  if (contribution.token.scheme === 'basic') credential.login = login;
  return credential;
};

/**
 * @param {{
 *   listGuests: () => Promise<object[]>,
 *   proxyServiceRequest: (params: object) => Promise<{ status: number, body: string }>,
 *   persistPath: string,
 *   accounts: ReturnType<typeof import('./channel-accounts.js').createNotificationChannelAccounts>,
 *   handles: ReturnType<typeof import('../source-control/outbound-handles.js').createOutboundHandles>,
 *   isAnyUiVisible?: () => boolean,
 *   now?: () => number,
 *   createId?: () => string,
 *   warn?: (...args: unknown[]) => void,
 * }} deps
 */
export const createExtensionNotificationChannels = ({
  listGuests,
  proxyServiceRequest,
  persistPath,
  accounts,
  handles,
  isAnyUiVisible = () => false,
  now = Date.now,
  createId = () => crypto.randomUUID(),
  warn = (...args) => console.warn(...args),
}) => {
  /** Per provider id: the catalog row of the extension that serves the channel. */
  const registered = new Map();
  let queue = Promise.resolve();
  const lastWarnAt = new Map();
  const calls = new Map();

  const cancelChannel = (providerId) => {
    calls.get(providerId)?.controller.abort();
    calls.delete(providerId);
    accounts.cancelConnect(providerId);
  };

  // Authentication and notification calls share the service's one-call-at-a-time contract.
  const callInOrder = (providerId, action) => {
    let state = calls.get(providerId);
    if (!state) {
      state = { tail: Promise.resolve(), pending: 0, controller: new AbortController() };
      calls.set(providerId, state);
    }
    if (state.pending >= CHANNEL_PENDING_MAX) return Promise.reject(callError('The channel queue is full.', { code: 'CHANNEL_BUSY', status: 503 }));
    state.pending += 1;
    const result = state.tail.then(() => {
      if (state.controller.signal.aborted || !registered.has(providerId)) throw callError('The channel is no longer active.', { code: 'CANCELLED', kind: 'unavailable' });
      return action(state.controller.signal);
    }).finally(() => { state.pending -= 1; });
    state.tail = result.catch(() => undefined);
    return result;
  };

  const warnOnce = (providerId, detail) => {
    const last = lastWarnAt.get(providerId) ?? 0;
    if (now() - last < WARN_INTERVAL_MS) return;
    lastWarnAt.set(providerId, now());
    warn(`[notifications] ${providerId}: ${detail}`);
  };

  const run = async () => {
    let guests;
    try {
      guests = await listGuests();
    } catch (error) {
      // A catalog that cannot be read changes nothing: it is not an empty catalog.
      warn('[notifications] the extension catalog could not be read:', error?.message ?? error);
      return;
    }
    const next = new Map();
    for (const guest of Array.isArray(guests) ? guests : []) {
      if (isNotificationChannelGuest(guest)) next.set(notificationProviderIdOf(guest.id), guest);
    }
    for (const [providerId, guest] of registered) {
      if (!next.has(providerId)) {
        cancelChannel(providerId);
        handles.revokeGuest(guest.id);
      }
    }
    registered.clear();
    for (const [providerId, guest] of next) registered.set(providerId, guest);
    // An update that moved a fixed channel's server leaves the account on the old one: written off, so the card says so.
    for (const [providerId, guest] of registered) {
      let stored;
      try {
        stored = await accounts.read(providerId);
      } catch {
        continue;
      }
      if (stored && stored.account.status === 'valid' && accountInstanceOf(guest.notifications, stored) === null) {
        await accounts.markInvalid(providerId, 'instance-changed', stored).catch(() => undefined);
      }
    }
  };

  const reconcile = () => {
    queue = queue.then(run, run);
    return queue;
  };

  /**
   * One forwarded call. `credential` is what the handle carries to the
   * channel's server (null for `auth.probe`), `account` who the call acts as
   * (null before one exists). Answers the parsed data.
   */
  const forward = async (providerId, guest, method, { instance, credential, account, input }, signal) => {
    if (signal?.aborted) throw callError('The channel is no longer active.', { code: 'CANCELLED', kind: 'unavailable' });
    const timeoutMs = notificationsProviderTimeoutMs(method);
    const grant = handles.mint({
      guestId: guest.id,
      providerId,
      origin: instance,
      credential,
      deadline: now() + timeoutMs,
      methods: SOURCE_CONTROL_OUTBOUND_METHODS,
    });
    try {
      let proxied;
      try {
        proxied = await proxyServiceRequest({
          guestId: guest.id,
          guestName: guest.name,
          packageRoot: guest.packageRoot,
          service: guest.service,
          granted: guest.capabilityGrants,
          persistPath,
          method: 'POST',
          path: NOTIFICATIONS_PROVIDER_PATH,
          body: JSON.stringify({
            v: NOTIFICATIONS_PROVIDER_WIRE_VERSION,
            requestId: createId(),
            method,
            provider: providerId,
            session: { instance, handle: grant.handle, account },
            input,
          }),
          timeoutMs,
          responseMax: NOTIFICATIONS_PROVIDER_RESPONSE_MAX,
          idleStopMs: NOTIFICATIONS_PROVIDER_IDLE_MS,
          signal,
        });
      } catch (error) {
        const code = error?.code;
        throw callError(`${guest.name} could not answer (${code ?? 'error'}): ${error?.message ?? error}`, {
          code, status: 503, kind: NOT_REACHED_CODES.has(code) ? 'unavailable' : 'provider-error',
        });
      }
      const malformed = (detail) => callError(`${guest.name} answered something OpenChamber cannot use: ${detail}`, {
        status: 502, code: 'MALFORMED_PROVIDER_RESPONSE', kind: 'malformed',
      });
      if (proxied.status !== 200) throw malformed(`HTTP ${proxied.status}`);
      let envelope;
      try {
        envelope = schemas.envelope.safeParse(JSON.parse(proxied.body));
      } catch {
        throw malformed('not JSON');
      }
      if (!envelope.success) throw malformed('not a notifications answer');
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

  const registeredChannel = (providerId) => {
    const guest = registered.get(providerId);
    if (!guest) throw routeError(404, 'CHANNEL_UNKNOWN', 'This notification channel is not available: the extension is paused, removed, or not approved.');
    return guest;
  };

  /** A connect that failed in the service or at the server, as a route answers it. */
  const connectFailure = (error, label) => {
    if (error.kind === 'invalid-token') return routeError(401, 'TOKEN_REFUSED', `${label} refused this token.`);
    if (error.kind === 'unavailable') return routeError(503, 'CHANNEL_UNAVAILABLE', error.message);
    if (error.kind === 'malformed') return routeError(502, error.code, error.message);
    return routeError(Number.isInteger(error.status) && error.status >= 400 && error.status <= 599 ? error.status : 400, error.code ?? 'CONNECT_FAILED', error.message);
  };

  /**
   * Connect the channel's one account: probe a typed instance, verify the
   * token through the service, store what the server said the account is.
   * Nothing is stored unless both pass; connecting again replaces the account.
   */
  const connect = async ({ providerId, instance, token, username }) => {
    const guest = registeredChannel(providerId);
    const contribution = guest.notifications;
    const secret = String(token) === token ? token.trim() : '';
    if (!secret) throw routeError(400, 'TOKEN_REQUIRED', 'A token is required.');
    const login = String(username) === username && username.trim() ? username.trim() : null;
    if (contribution.token.scheme === 'basic' && !login) throw routeError(400, 'USERNAME_REQUIRED', `${contribution.label} signs in with a username; enter it beside the token.`);
    // The handle minter sends only a username it can put in a Basic header; refused here, in the channel's words.
    if (login && !isProviderUsername(login)) throw routeError(400, 'USERNAME_INVALID', `${contribution.label} cannot sign in with this username: use Latin letters, digits and punctuation other than ":".`);
    let origin;
    if (contribution.instances.kind === 'fixed') {
      origin = contribution.instances.origin;
    } else {
      origin = normalizeChannelInstance(instance);
      if (!origin) throw routeError(400, 'INSTANCE_REQUIRED', `Enter the server address as an https origin, like ${contribution.instances.placeholder || 'https://example.org'}.`);
    }
    let probe;
    let verified;
    const connection = accounts.beginConnect(providerId);
    try {
      probe = await callInOrder(providerId, (signal) => forward(providerId, guest, 'auth.probe', { instance: origin, credential: null, account: null, input: {} }, signal));
      if (!probe.supported) throw routeError(400, 'UNSUPPORTED_INSTANCE', probe.message || `${origin} is not a server ${contribution.label} can deliver to.`);
      verified = await callInOrder(providerId, (signal) => forward(providerId, guest, 'auth.verify', {
        instance: origin, credential: credentialOf(contribution, secret, login), account: null, input: {},
      }, signal));
    } catch (error) {
      throw error.kind ? connectFailure(error, contribution.label) : error;
    }
    const account = {
      id: verified.account.id,
      // A Basic-auth server's stored login is the username the user typed, the one Basic auth accepted.
      login: contribution.token.scheme === 'basic' ? login : verified.account.login,
    };
    if (verified.account.name) account.name = verified.account.name;
    const view = await accounts.set(providerId, { instance: origin, token: secret, account }, connection);
    if (!view) throw routeError(409, 'CONNECT_SUPERSEDED', 'A newer account action replaced this connection.');
    return view;
  };

  const disconnect = async ({ providerId }) => {
    registeredChannel(providerId);
    return { removed: await accounts.remove(providerId) };
  };

  /** Every registered channel with what the card shows: the channel's description and its account, never a token. */
  const list = async () => {
    const views = await accounts.list();
    return [...registered].map(([providerId, guest]) => ({
      providerId,
      guestId: guest.id,
      name: guest.name,
      channel: toPublicNotifications(guest.notifications),
      account: views[providerId] ?? null,
    }));
  };

  /**
   * One notification, already past the user's toggles and the runtime's
   * suppressions, to every registered channel with a valid account.
   * `requireHidden` is the push rule: nothing goes out while a client is
   * visible, unless the user chose to be notified always.
   */
  const deliver = async ({ notification, requireHidden }) => {
    if (registered.size === 0) return;
    if (requireHidden && isAnyUiVisible() === true) return;
    await Promise.all([...registered].map(([providerId, guest]) => callInOrder(providerId, async (signal) => {
      if (requireHidden && isAnyUiVisible() === true) return;
      let stored;
      try {
        stored = await accounts.read(providerId);
      } catch (error) {
        warnOnce(providerId, `its account could not be read: ${error?.message ?? error}`);
        return;
      }
      if (!stored || stored.account.status !== 'valid') return;
      const instance = accountInstanceOf(guest.notifications, stored);
      if (!instance) return;
      try {
        // Policy can change while this notification waits in the channel queue.
        const outgoing = isEnterpriseMode() ? {
          ...notification,
          title: genericNotificationTitle(notification.kind),
          body: '',
          sessionName: null,
          directory: null,
        } : notification;
        await forward(providerId, guest, 'notify', {
          instance,
          credential: credentialOf(guest.notifications, stored.account.token, stored.account.login),
          account: { id: stored.account.id, login: stored.account.login },
          input: { notification: outgoing },
        }, signal);
      } catch (error) {
        if (INELIGIBLE_CODES.has(error.code)) {
          // Paused, removed or withdrawn meanwhile: the catalog, not this call, says so.
          void reconcile();
          return;
        }
        if (error.kind === 'invalid-token') {
          const invalidated = await accounts.markInvalid(providerId, 'unauthorized', stored).catch(() => false);
          if (invalidated) warnOnce(providerId, 'its server refused the account\'s token; reconnect it in Settings → Integrations');
          return;
        }
        warnOnce(providerId, `delivery failed (${error.code ?? 'error'}): ${error.message}`);
      }
    }).catch((error) => {
      if (!INELIGIBLE_CODES.has(error.code)) warnOnce(providerId, `delivery failed (${error.code ?? 'error'}): ${error.message}`);
    })));
  };

  /** After a pause, a removal or withdrawn approval. A removed extension's account goes with it. */
  const deactivated = async ({ guestId, removed = false }) => {
    const providerId = notificationProviderIdOf(guestId);
    registered.delete(providerId);
    cancelChannel(providerId);
    handles.revokeGuest(guestId);
    await reconcile();
    if (removed) await accounts.remove(notificationProviderIdOf(guestId));
  };

  return Object.freeze({ reconcile, deactivated, connect, disconnect, list, deliver });
};
