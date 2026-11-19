import { resolveIntegrationApi, serviceProvides } from '@openchamber/sdk';
import type { GuestCapability, OpenChamberManifest } from '@openchamber/sdk';
import type { CapabilityScope } from './persist.js';


const sortedUnique = (values: string[]) => [...new Set(values)].sort();

type ServiceScope = NonNullable<CapabilityScope['service']>;
type OptionalScope<T> = T | null | undefined;

export const guestGrantScope = (guest: Partial<OpenChamberManifest['contributes']>) => {
  const scope: CapabilityScope = {};
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
    if (serviceProvides(guest.service, 'source-control') && guest.sourceControl) {
      scope.service.sourceControl = {
        defaultInstances: sortedUnique(guest.sourceControl.instances.defaultInstances),
        custom: guest.sourceControl.instances.custom,
      };
    }
    if (guest.sessionEvents) {
      scope.service.sessionEvents = {
        events: sortedUnique(guest.sessionEvents.events),
        content: guest.sessionEvents.content === true,
      };
    }
    if (serviceProvides(guest.service, 'notifications') && guest.notifications) {
      scope.service.notifications = guest.notifications.instances.kind === 'fixed'
        ? { kind: 'fixed', origin: guest.notifications.instances.origin }
        : { kind: 'user' };
    }
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
    if (serviceProvides(guest.service, 'quota') && guest.quota) {
      scope.service.quota = { providers: sortedUnique(guest.quota.providers) };
    }
    if (guest.service.keepRunning) scope.service.keepRunning = true;
    if (guest.service.schedule) {
      scope.service.schedule = sortedUnique(guest.service.schedule.map((entry) => `${entry.id} ${entry.cron} ${entry.timezone ?? ''}`.trim()));
    }
    if (guest.mentions) scope.service.mentions = true;
    if (guest.sessionControl) scope.service.sessionControl = { content: guest.sessionControl.content === true };
  }
  if (guest.links) {
    scope.links = {
      action: guest.links.action,
      keys: sortedUnique(guest.links.identifier?.keys ?? []),
      origin: guest.links.urls?.origin ?? null,
      identifier: guest.links.urls?.identifier ?? null,
      urls: sortedUnique(guest.links.urls?.item ?? []),
    };
  }
  if (Array.isArray(guest.waits) && guest.waits.length > 0) {
    scope.wake = sortedUnique(guest.waits.map((wait) => wait.id));
  }
  return scope;
};

const sameOauth = (a: OptionalScope<CapabilityScope['oauth']>, b: OptionalScope<CapabilityScope['oauth']>) => (
  (!a && !b) || Boolean(a && b && a.authorizeUrl === b.authorizeUrl && a.tokenUrl === b.tokenUrl)
);

export const sameCredentialTarget = (stored: OptionalScope<CapabilityScope>, current: CapabilityScope) => (
  !!stored?.apiOrigin && stored.apiOrigin === current.apiOrigin && sameOauth(stored.oauth, current.oauth)
);

const sameList = (a: string[], b: string[]) => a.length === b.length && a.every((value, index) => value === b[index]);

const sameSourceControl = (a: ServiceScope['sourceControl'], b: ServiceScope['sourceControl']) => (
  (!a && !b) || Boolean(a && b && a.custom === b.custom && sameList(a.defaultInstances, b.defaultInstances))
);

const sameSessionEvents = (a: ServiceScope['sessionEvents'], b: ServiceScope['sessionEvents']) => (
  (!a && !b) || Boolean(a && b && a.content === b.content && sameList(a.events, b.events))
);

const sameNotifications = (a: ServiceScope['notifications'], b: ServiceScope['notifications']) => (
  (!a && !b) || Boolean(a && b && a.kind === b.kind && ('origin' in a ? a.origin : null) === ('origin' in b ? b.origin : null))
);

const sameTracker = (a: ServiceScope['tracker'], b: ServiceScope['tracker']) => (
  (!a && !b) || Boolean(a && b
    && a.instances.kind === b.instances.kind && ('origin' in a.instances ? a.instances.origin : null) === ('origin' in b.instances ? b.instances.origin : null)
    && sameOauth(a.oauth, b.oauth)
    && sameList(a.urls, b.urls))
);

const sameQuota = (a: ServiceScope['quota'], b: ServiceScope['quota']) => (
  (!a && !b) || Boolean(a && b && sameList(a.providers, b.providers))
);

const sameSessionControl = (a: ServiceScope['sessionControl'], b: ServiceScope['sessionControl']) => (
  (!a && !b) || Boolean(a && b && a.content === b.content)
);

export const effectiveGrants = (granted: GuestCapability[], stored: CapabilityScope | undefined, current: CapabilityScope) => granted.filter((capability) => {
  if (capability === 'transcript') {
    if (!stored?.service?.sessionEvents?.content && !stored?.service?.sessionControl?.content) return false;
    return sameSessionEvents(stored.service.sessionEvents, current.service?.sessionEvents)
      && sameSessionControl(stored.service.sessionControl, current.service?.sessionControl);
  }
  if (capability === 'sessionControl') {
    return !!stored?.service?.sessionControl && sameSessionControl(stored.service.sessionControl, current.service?.sessionControl);
  }
  if (capability === 'links') {
    const a = stored?.links;
    const b = current.links;
    return Boolean(a && b && a.action === b.action && a.origin === b.origin && a.identifier === b.identifier
      && sameList(a.keys, b.keys) && sameList(a.urls, b.urls));
  }
  if (capability === 'filesystem') {
    return !!stored?.filesystem && sameList(stored.filesystem, current.filesystem ?? []);
  }
  if (capability === 'origins') {
    return !!stored?.origins && sameList(stored.origins, current.origins ?? []);
  }
  if (capability === 'wake') {
    return !!stored?.wake && sameList(stored.wake, current.wake ?? []);
  }
  if (capability === 'network') {
    return !!stored?.apiOrigin
      && stored.apiOrigin === current.apiOrigin
      && sameOauth(stored.oauth, current.oauth);
  }
  if (capability === 'service') {
    return !!stored?.service
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
