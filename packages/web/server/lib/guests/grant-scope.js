import { resolveIntegrationApi, serviceProvides } from '@openchamber/sdk';

// What a grant covered when the user approved it. `filesystem` is the
// declared pattern list, `origins` the origins the frame may reach, `network` the API origin, `service` the exec names
// and socket ids the dialog showed. A newer package that changes any of
// these has not been approved for that capability, whatever the stored
// grant list says, so the card asks again and the proxies refuse meanwhile.

const sortedUnique = (values) => [...new Set(values)].sort();

/**
 * @typedef {{ events: string[], content: boolean }} SessionEventsScope
 * @typedef {{ kind: 'fixed', origin: string } | { kind: 'user' }} NotificationsScope
 * @typedef {{ kind: 'fixed', origin: string } | { kind: 'user' }} TrackerInstanceScope
 * @typedef {{ instances: TrackerInstanceScope, oauth: { authorizeUrl: string, tokenUrl: string } | null, urls: string[] }} TrackerScope
 * @typedef {{ providers: string[] }} QuotaScope
 * @typedef {{ action: string, keys: string[], origin: string | null, identifier: string | null, urls: string[] }} LinksScope
 * @typedef {{ exec: string[], sockets: string[], sourceControl?: { defaultInstances: string[], custom: boolean }, sessionEvents?: SessionEventsScope, notifications?: NotificationsScope, tracker?: TrackerScope, quota?: QuotaScope, keepRunning?: true, schedule?: string[], mentions?: true, sessionControl?: { content: boolean } }} ServiceScope
 * @param {{ filesystem?: string[], integration?: object, skills?: string, mentions?: object, sessionControl?: { content?: true }, service?: { provides?: string[], keepRunning?: true, schedule?: Array<{ id: string, cron: string, timezone?: string }>, permissions?: { exec?: string[], sockets?: Array<{ id: string }> } }, sourceControl?: { instances: { defaultInstances: string[], custom: boolean } }, sessionEvents?: { events: string[], content?: true }, notifications?: { instances: { kind: 'fixed', origin: string } | { kind: 'user' } }, tracker?: { instances: { kind: 'fixed', origin: string } | { kind: 'user' }, auth: { oauth?: { authorizeUrl: string, tokenUrl: string } }, urls: { item: string[] } }, quota?: { providers: string[] }, links?: { action: string, identifier?: { keys: string[] }, urls?: { origin: string, identifier: string, item: string[] } } }} guest
 * @returns {{ filesystem?: string[], apiOrigin?: string, service?: ServiceScope, links?: LinksScope }}
 */
export const guestGrantScope = (guest) => {
  const scope = {};
  if (Array.isArray(guest.filesystem) && guest.filesystem.length > 0) {
    scope.filesystem = sortedUnique(guest.filesystem);
  }
  if (Array.isArray(guest.origins) && guest.origins.length > 0) {
    scope.origins = sortedUnique(guest.origins);
  }
  if (guest.integration) {
    const api = resolveIntegrationApi(guest.integration);
    if (api?.apiOrigin) {
      scope.apiOrigin = api.apiOrigin;
    }
    // The stored refresh token and client secret travel to these two URLs;
    // a package that moves either one has not been approved for them.
    if (guest.integration.oauth) {
      scope.oauth = {
        authorizeUrl: guest.integration.oauth.authorizeUrl,
        tokenUrl: guest.integration.oauth.tokenUrl,
      };
    }
  }
  if (guest.service) {
    scope.service = {
      exec: sortedUnique(guest.service.permissions?.exec ?? []),
      sockets: sortedUnique((guest.service.permissions?.sockets ?? []).map((binding) => binding.id)),
    };
    // A Git host role sends what the user writes to the instances it names,
    // so the service grant covers those too; absent for every other service,
    // which keeps their stored approvals as they are.
    if (serviceProvides(guest.service, 'source-control') && guest.sourceControl) {
      scope.service.sourceControl = {
        defaultInstances: sortedUnique(guest.sourceControl.instances.defaultInstances),
        custom: guest.sourceControl.instances.custom,
      };
    }
    // Session events are posted to the service without a window; the approval
    // covers which events, and whether their text comes along (`transcript`).
    // Absent for a service that subscribes to none.
    if (guest.sessionEvents) {
      scope.service.sessionEvents = {
        events: sortedUnique(guest.sessionEvents.events),
        content: guest.sessionEvents.content === true,
      };
    }
    // A notification channel sends the user's notifications to the server its
    // account lives on; the approval covers that server. Absent for every other service.
    if (serviceProvides(guest.service, 'notifications') && guest.notifications) {
      scope.service.notifications = guest.notifications.instances.kind === 'fixed'
        ? { kind: 'fixed', origin: guest.notifications.instances.origin }
        : { kind: 'user' };
    }
    // A tracker sends the user's items and comments to the server its accounts
    // live on, mints tokens at its OAuth endpoints and claims the links its
    // templates name; the approval covers all three. Absent for every other service.
    if (serviceProvides(guest.service, 'tracker') && guest.tracker) {
      scope.service.tracker = {
        instances: guest.tracker.instances.kind === 'fixed'
          ? { kind: 'fixed', origin: guest.tracker.instances.origin }
          : { kind: 'user' },
        oauth: guest.tracker.auth.oauth
          ? { authorizeUrl: guest.tracker.auth.oauth.authorizeUrl, tokenUrl: guest.tracker.auth.oauth.tokenUrl }
          : null,
        urls: sortedUnique(guest.tracker.urls.item),
      };
    }
    // A usage provider receives the credentials OpenCode holds for the providers
    // it lists; the approval covers that list, empty included. Absent for every other service.
    if (serviceProvides(guest.service, 'quota') && guest.quota) {
      scope.service.quota = { providers: sortedUnique(guest.quota.providers) };
    }
    // Running with nobody asking is part of what the user approved, and so is
    // the clock it runs on. Each key is absent for a service without it, which
    // keeps every stored approval as it is.
    if (guest.service.keepRunning) scope.service.keepRunning = true;
    if (guest.service.schedule) {
      scope.service.schedule = sortedUnique(guest.service.schedule.map((entry) => `${entry.id} ${entry.cron} ${entry.timezone ?? ''}`.trim()));
    }
    // What the user types after `@` goes to the service.
    if (guest.mentions) scope.service.mentions = true;
    if (guest.sessionControl) scope.service.sessionControl = { content: guest.sessionControl.content === true };
  }
  // Which identifiers and links in chats become the extension's, and what a
  // click hands it; a version that claims others or acts differently asks again.
  if (guest.links) {
    scope.links = {
      action: guest.links.action,
      keys: sortedUnique(guest.links.identifier?.keys ?? []),
      origin: guest.links.urls?.origin ?? null,
      identifier: guest.links.urls?.identifier ?? null,
      urls: sortedUnique(guest.links.urls?.item ?? []),
    };
  }
  // The waits whose text may wake an agent's session; a package that adds one
  // has not been approved for it.
  if (Array.isArray(guest.waits) && guest.waits.length > 0) {
    scope.wake = sortedUnique(guest.waits.map((wait) => wait.id));
  }
  return scope;
};

const sameOauth = (a, b) => (
  (!a && !b) || Boolean(a && b && a.authorizeUrl === b.authorizeUrl && a.tokenUrl === b.tokenUrl)
);

/**
 * Whether the credentials pasted or minted for one integration may still be
 * used with the package as it is now: same API origin and same OAuth
 * endpoints. Otherwise the tokens are dropped at re-approval.
 */
export const sameCredentialTarget = (stored, current) => (
  Boolean(stored?.apiOrigin) && stored.apiOrigin === current.apiOrigin && sameOauth(stored.oauth, current.oauth)
);

const sameList = (a, b) => a.length === b.length && a.every((value, index) => value === b[index]);

/** Both without the Git host role, or both with it reaching the same instances. */
const sameSourceControl = (a, b) => (
  (!a && !b) || Boolean(a && b && a.custom === b.custom && sameList(a.defaultInstances, b.defaultInstances))
);

/** Both without session events, or both with the same events and the same answer on their text. */
const sameSessionEvents = (a, b) => (
  (!a && !b) || Boolean(a && b && a.content === b.content && sameList(a.events, b.events))
);

/** Both without the notifications role, or both with it sending to the same place. */
const sameNotifications = (a, b) => (
  (!a && !b) || Boolean(a && b && a.kind === b.kind && (a.origin ?? null) === (b.origin ?? null))
);

/** Both without the tracker role, or both with it on the same server, the same OAuth endpoints and the same links. */
const sameTracker = (a, b) => (
  (!a && !b) || Boolean(a && b
    && a.instances.kind === b.instances.kind && (a.instances.origin ?? null) === (b.instances.origin ?? null)
    && sameOauth(a.oauth, b.oauth)
    && sameList(a.urls, b.urls))
);

/** Both without the quota role, or both with it reading the same providers' credentials. */
const sameQuota = (a, b) => (
  (!a && !b) || Boolean(a && b && sameList(a.providers, b.providers))
);

/** Both without session control, or both with the same answer on reading replies. */
const sameSessionControl = (a, b) => (
  (!a && !b) || Boolean(a && b && a.content === b.content)
);

/**
 * The grants that still hold for the package as it is now. A scoped
 * capability (`filesystem`, `origins`, `network`, `service`, `transcript`) only counts when the stored
 * scope equals the current one; without a stored scope it never counts.
 * @param {string[]} granted
 * @param {ReturnType<typeof guestGrantScope> | undefined} stored
 * @param {ReturnType<typeof guestGrantScope>} current
 */
export const effectiveGrants = (granted, stored, current) => granted.filter((capability) => {
  if (capability === 'transcript') {
    // The text of session events rides on the service grant's event scope: it
    // counts only while the approved subscription asked for content and is the
    // one the package declares now.
    if (!stored?.service?.sessionEvents?.content && !stored?.service?.sessionControl?.content) return false;
    return sameSessionEvents(stored.service.sessionEvents, current.service?.sessionEvents)
      && sameSessionControl(stored.service.sessionControl, current.service?.sessionControl);
  }
  if (capability === 'sessionControl') {
    return Boolean(stored?.service?.sessionControl) && sameSessionControl(stored.service.sessionControl, current.service?.sessionControl);
  }
  if (capability === 'links') {
    const a = stored?.links;
    const b = current.links;
    return Boolean(a && b && a.action === b.action && a.origin === b.origin && a.identifier === b.identifier
      && sameList(a.keys, b.keys) && sameList(a.urls, b.urls));
  }
  if (capability === 'filesystem') {
    return Boolean(stored?.filesystem) && sameList(stored.filesystem, current.filesystem ?? []);
  }
  if (capability === 'origins') {
    return Boolean(stored?.origins) && sameList(stored.origins, current.origins ?? []);
  }
  if (capability === 'wake') {
    return Boolean(stored?.wake) && sameList(stored.wake, current.wake ?? []);
  }
  if (capability === 'network') {
    return Boolean(stored?.apiOrigin)
      && stored.apiOrigin === current.apiOrigin
      && sameOauth(stored.oauth, current.oauth);
  }
  if (capability === 'service') {
    return Boolean(stored?.service)
      && sameList(stored.service.exec, current.service?.exec ?? [])
      && sameList(stored.service.sockets, current.service?.sockets ?? [])
      && sameSourceControl(stored.service.sourceControl, current.service?.sourceControl)
      && sameSessionEvents(stored.service.sessionEvents, current.service?.sessionEvents)
      && sameNotifications(stored.service.notifications, current.service?.notifications)
      && sameTracker(stored.service.tracker, current.service?.tracker)
      && sameQuota(stored.service.quota, current.service?.quota)
      && Boolean(stored.service.keepRunning) === Boolean(current.service?.keepRunning)
      && sameList(stored.service.schedule ?? [], current.service?.schedule ?? [])
      && Boolean(stored.service.mentions) === Boolean(current.service?.mentions)
      && sameSessionControl(stored.service.sessionControl, current.service?.sessionControl);
  }
  return true;
});
