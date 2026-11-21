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
import type { GuestNotification, NotificationsContribution, NotificationsProviderAccount, NotificationsProviderMethod, NotificationsProviderInputs, ServiceContribution } from '@openchamber/sdk';
import type { z } from 'zod';
import type { GuestRecord } from '../guests/contracts.js';
import type { proxyGuestServiceRequest } from '../guests/service.js';
import type { createOutboundHandles } from '../source-control/outbound-handles.js';
import type { createNotificationChannelAccounts, NotificationChannelAccount, StoredNotificationChannel } from './channel-accounts.js';
import { hasErrorProperties, isString, isNumber } from './inputs.js';
import type { NotificationFailure } from './inputs.js';

export type NotificationChannelGuest = GuestRecord & { notifications: NotificationsContribution; service: ServiceContribution };
export type ChannelProbeData = z.infer<typeof schemas.data['auth.probe']>;
export type ChannelAccountData = z.infer<typeof schemas.data['auth.verify']>;
export type ChannelNotifyData = z.infer<typeof schemas.data.notify>;

interface ChannelFailure extends NotificationFailure {
  kind?: unknown;
}

interface ChannelCallState {
  tail: Promise<unknown>;
  pending: number;
  controller: AbortController;
}

type ChannelCredential = NonNullable<Parameters<ReturnType<typeof createOutboundHandles>['mint']>[0]['credential']>;
type OutgoingChannelNotification = Omit<GuestNotification, 'kind'> & { kind: GuestNotification['kind'] | 'share-answer' };
export interface ExtensionNotificationDelivery {
  notification: OutgoingChannelNotification;
  requireHidden: boolean;
}

type ChannelInputs = Omit<NotificationsProviderInputs, 'notify'> & { notify: { notification: OutgoingChannelNotification } };

interface ChannelForwardInput {
  instance: string;
  credential: ChannelCredential | null;
  account: NotificationsProviderAccount | null;
  input: ChannelInputs[NotificationsProviderMethod];
}

export interface ExtensionNotificationChannelDependencies {
  listGuests: () => Promise<GuestRecord[]>;
  proxyServiceRequest: typeof proxyGuestServiceRequest;
  persistPath: string;
  accounts: ReturnType<typeof createNotificationChannelAccounts>;
  handles: ReturnType<typeof createOutboundHandles>;
  isAnyUiVisible?: () => boolean;
  now?: () => number;
  createId?: () => string;
  warn?: (...args: unknown[]) => void;
}

const isChannelString = (value: unknown): value is string => String(value) === value;
const isChannelFailure = (value: unknown): value is ChannelFailure => hasErrorProperties(value);


const INELIGIBLE_CODES = new Set(['NO_SERVICE', 'DISABLED', 'CANCELLED']);
const NOT_REACHED_CODES = new Set(['SERVICE_FAILED', 'NO_SERVICE', 'DISABLED', 'REQUEST_FAILED', 'CANCELLED']);
const WARN_INTERVAL_MS = 60_000;
const CHANNEL_PENDING_MAX = 200;
const LOOPBACK_HOSTS = new Set(['127.0.0.1', 'localhost', '[::1]']);

export const isNotificationChannelGuest = (guest: GuestRecord | null | undefined): guest is NotificationChannelGuest => {
  const granted = Array.isArray(guest?.capabilityGrants) ? guest.capabilityGrants : [];
  return Boolean(guest)
    && guest !== null && guest !== undefined
    && guest.enabled !== false
    && serviceProvides(guest.service, 'notifications')
    && Boolean(guest.notifications)
    && granted.includes('service')
    && isGuestApproved({ requested: requestedGuestCapabilities(guest), granted });
};

export const normalizeChannelInstance = (value: Parameters<typeof isChannelString>[0]) => {
  if (!isChannelString(value)) return null;
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

const routeError = (status: number, code: ChannelFailure['code'], message: ChannelFailure['message']) => Object.assign(new Error(message === undefined ? undefined : `${message}`), { status, code });

const accountInstanceOf = (contribution: NotificationsContribution, stored: StoredNotificationChannel) => (
  contribution.instances.kind === 'fixed' && stored.instance !== contribution.instances.origin ? null : stored.instance
);

const callError = (message: string, { status, code, kind = 'provider-error' }: { status?: number | undefined; code?: unknown; kind?: string } = {}) => {
  const error: Error & ChannelFailure = new Error(message);
  if (status !== undefined) error.status = status;
  if (code !== undefined) error.code = code;
  error.kind = kind;
  return error;
};

const credentialOf = (contribution: NotificationsContribution, token: string, login: string | null): ChannelCredential => {
  const credential: ChannelCredential = { token, header: contribution.token.header, scheme: contribution.token.scheme };
  if (contribution.token.scheme === 'basic') credential.login = login;
  return credential;
};

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
}: ExtensionNotificationChannelDependencies) => {
  const registered = new Map<string, NotificationChannelGuest>();
  let queue = Promise.resolve();
  const lastWarnAt = new Map<string, number>();
  const calls = new Map<string, ChannelCallState>();

  const cancelChannel = (providerId: string) => {
    calls.get(providerId)?.controller.abort();
    calls.delete(providerId);
    accounts.cancelConnect(providerId);
  };

  const callInOrder = <T>(providerId: string, action: (signal: AbortSignal) => Promise<T>) => {
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

  const warnOnce = (providerId: string, detail: string) => {
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
      warn('[notifications] the extension catalog could not be read:', (isChannelFailure(error) ? error.message : undefined) ?? error);
      return;
    }
    const next = new Map<string, NotificationChannelGuest>();
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

  function forward(providerId: string, guest: NotificationChannelGuest, method: 'auth.probe', input: ChannelForwardInput, signal: AbortSignal): Promise<ChannelProbeData>;
  function forward(providerId: string, guest: NotificationChannelGuest, method: 'auth.verify', input: ChannelForwardInput, signal: AbortSignal): Promise<ChannelAccountData>;
  function forward(providerId: string, guest: NotificationChannelGuest, method: 'notify', input: ChannelForwardInput, signal: AbortSignal): Promise<ChannelNotifyData>;
  async function forward(providerId: string, guest: NotificationChannelGuest, method: NotificationsProviderMethod, { instance, credential, account, input }: ChannelForwardInput, signal: AbortSignal) {
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
        const failure = isChannelFailure(error) ? error : undefined;
        const code = failure?.code;
        throw callError(`${guest.name} could not answer (${code ?? 'error'}): ${failure?.message ?? error}`, {
          code, status: 503, kind: isString(code) && NOT_REACHED_CODES.has(code) ? 'unavailable' : 'provider-error',
        });
      }
      const malformed = (detail: string) => callError(`${guest.name} answered something OpenChamber cannot use: ${detail}`, {
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

  const registeredChannel = (providerId: string) => {
    const guest = registered.get(providerId);
    if (!guest) throw routeError(404, 'CHANNEL_UNKNOWN', 'This notification channel is not available: the extension is paused, removed, or not approved.');
    return guest;
  };

  const connectFailure = (error: ChannelFailure, label: string) => {
    if (error.kind === 'invalid-token') return routeError(401, 'TOKEN_REFUSED', `${label} refused this token.`);
    if (error.kind === 'unavailable') return routeError(503, 'CHANNEL_UNAVAILABLE', error.message);
    if (error.kind === 'malformed') return routeError(502, error.code, error.message);
    return routeError(isNumber(error.status) && Number.isInteger(error.status) && error.status >= 400 && error.status <= 599 ? error.status : 400, error.code ?? 'CONNECT_FAILED', error.message);
  };

  const connect = async ({ providerId, instance, token, username }: { providerId: string; instance?: unknown; token?: unknown; username?: unknown }) => {
    const guest = registeredChannel(providerId);
    const contribution = guest.notifications;
    const secret = isChannelString(token) ? token.trim() : '';
    if (!secret) throw routeError(400, 'TOKEN_REQUIRED', 'A token is required.');
    const login = isChannelString(username) && username.trim() ? username.trim() : null;
    if (contribution.token.scheme === 'basic' && !login) throw routeError(400, 'USERNAME_REQUIRED', `${contribution.label} signs in with a username; enter it beside the token.`);
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
      const failure = isChannelFailure(error) ? error : undefined;
      throw failure?.kind ? connectFailure(failure, contribution.label) : error;
    }
    const account: Pick<NotificationChannelAccount, 'id' | 'login' | 'name'> = {
      id: verified.account.id,
      login: contribution.token.scheme === 'basic' ? login : verified.account.login,
    };
    if (verified.account.name) account.name = verified.account.name;
    const view = await accounts.set(providerId, { instance: origin, token: secret, account }, connection);
    if (!view) throw routeError(409, 'CONNECT_SUPERSEDED', 'A newer account action replaced this connection.');
    return view;
  };

  const disconnect = async ({ providerId }: { providerId: string }) => {
    registeredChannel(providerId);
    return { removed: await accounts.remove(providerId) };
  };

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

  const deliver = async ({ notification, requireHidden }: ExtensionNotificationDelivery) => {
    if (registered.size === 0) return;
    if (requireHidden && isAnyUiVisible() === true) return;
    await Promise.all([...registered].map(([providerId, guest]) => callInOrder(providerId, async (signal) => {
      if (requireHidden && isAnyUiVisible() === true) return;
      let stored;
      try {
        stored = await accounts.read(providerId);
      } catch (error) {
        warnOnce(providerId, `its account could not be read: ${(isChannelFailure(error) ? error.message : undefined) ?? error}`);
        return;
      }
      if (!stored || stored.account.status !== 'valid') return;
      const instance = accountInstanceOf(guest.notifications, stored);
      if (!instance) return;
      try {
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
        const failure = isChannelFailure(error) ? error : undefined;
        if (isString(failure?.code) && INELIGIBLE_CODES.has(failure.code)) {
          void reconcile();
          return;
        }
        if (failure?.kind === 'invalid-token') {
          const invalidated = await accounts.markInvalid(providerId, 'unauthorized', stored).catch(() => false);
          if (invalidated) warnOnce(providerId, 'its server refused the account\'s token; reconnect it in Settings → Integrations');
          return;
        }
        warnOnce(providerId, `delivery failed (${failure?.code ?? 'error'}): ${failure?.message}`);
      }
    }).catch((error) => {
      const failure = isChannelFailure(error) ? error : undefined;
      if (!(isString(failure?.code) && INELIGIBLE_CODES.has(failure.code))) warnOnce(providerId, `delivery failed (${failure?.code ?? 'error'}): ${failure?.message}`);
    })));
  };

  const deactivated = async ({ guestId, removed = false }: { guestId: string; removed?: boolean }) => {
    const providerId = notificationProviderIdOf(guestId);
    registered.delete(providerId);
    cancelChannel(providerId);
    handles.revokeGuest(guestId);
    await reconcile();
    if (removed) await accounts.remove(notificationProviderIdOf(guestId));
  };

  return Object.freeze({ reconcile, deactivated, connect, disconnect, list, deliver });
};
