// Host and window identity for notification clicks and session links. A
// notification or link names the runtime that owns its session; the desktop
// shell resolves that runtime to a host entry so it can open the session on the
// owning instance, and reuses the window that already shows it.

import { z } from 'zod';

const HOST_RUNTIME_KEY_PREFIX = 'host:';
const URL_RUNTIME_KEY_PREFIX = 'url:';

// The id doubles as the host-window tag (main.mjs __ocHostWindowId), so a
// local-instance window is reused like any host window.
const LOCAL_HOST_ENTRY_ID = 'local';

// Renderer IPC and persisted host entries arrive untyped: only a primitive
// string decodes, trimmed so a padded value still matches.
const optionalString = z.string().catch('').transform((value) => value.trim());

/** Trim a string read from an untyped boundary; '' for anything else. */
export const readTrimmedString = (value) => optionalString.parse(value);

// A notification input is a plain object or an array — both spread into the
// flat shape; anything else decodes to an empty input.
const notificationInput = z.union([z.looseObject({}), z.array(z.unknown())]);

// Mirrors the renderer's runtime key normalization (runtime-switch.ts) so a
// URL-bound window's key can be matched back to the host entry its API URL
// came from: hash and search stripped, trailing slash removed, 'url:' prefix.
const runtimeKeyForHostUrl = (raw) => {
  const trimmed = readTrimmedString(raw);
  if (!trimmed) return '';
  try {
    const url = new URL(trimmed);
    url.hash = '';
    url.search = '';
    return `${URL_RUNTIME_KEY_PREFIX}${url.toString().replace(/\/+$/, '')}`;
  } catch {
    return '';
  }
};

export const resolveHostEntryForRuntimeKey = (rawKey, { hosts, localUrl, localClientToken }) => {
  const key = readTrimmedString(rawKey);
  if (!key) return null;
  if (key === LOCAL_HOST_ENTRY_ID) {
    // Without a local server (e.g. skip-local-server desktop) there is no
    // local instance to route to.
    if (!localUrl) return null;
    return { id: LOCAL_HOST_ENTRY_ID, url: localUrl, clientToken: localClientToken || '', requestHeaders: {} };
  }
  if (key.startsWith(HOST_RUNTIME_KEY_PREFIX)) {
    const hostId = key.slice(HOST_RUNTIME_KEY_PREFIX.length);
    return (Array.isArray(hosts) ? hosts : []).find((entry) => entry?.id === hostId) || null;
  }
  if (key.startsWith(URL_RUNTIME_KEY_PREFIX)) {
    // Windows that bind a host API URL without a host tag of their own (a
    // mini-chat bound to a host session) name their runtime in this form;
    // match it back to the host entry the URL belongs to.
    return (Array.isArray(hosts) ? hosts : []).find((entry) => runtimeKeyForHostUrl(entry?.apiUrl || entry?.url) === key) || null;
  }
  return null;
};

// Which open window already shows a host, as seen by openHostWindow's reuse
// lookup. Windows are plain descriptors: { runtimeKey, hostWindowId } for what
// each window reports now and what it was created for, or null once destroyed.
// The reported key is authoritative because a window can switch instance in
// place, which leaves its creation-time tag stale. A window that has not
// reported yet is still booting, so its tag is the best identity it has. A
// reported key that resolves to no host claims nothing: the stale tag must not
// take over again. Reported matches are preferred over booting ones so a ready
// window is reused before one that still has to load the route.
export const findReusableHostWindowIndex = (windows, hostId, { hosts, localUrl, localClientToken }) => {
  let tagMatch = -1;
  for (let index = 0; index < windows.length; index += 1) {
    const window = windows[index];
    if (!window) continue;
    const reported = readTrimmedString(window.runtimeKey);
    if (reported) {
      if (resolveHostEntryForRuntimeKey(reported, { hosts, localUrl, localClientToken })?.id === hostId) return index;
      continue;
    }
    if (tagMatch < 0 && readTrimmedString(window.hostWindowId) === hostId) tagMatch = index;
  }
  return tagMatch;
};

// A session deep link names its owning host by id (`?host=<id>`, 'local' for
// this app's server). It travels as the runtime key a notification click
// carries, so the receiving window routes both the same way. The prefix is
// always added: a crafted id cannot pose as a 'url:' key.
export const runtimeKeyForDeepLinkHost = (rawHostId) => {
  const hostId = readTrimmedString(rawHostId);
  if (!hostId) return '';
  return hostId === LOCAL_HOST_ENTRY_ID ? LOCAL_HOST_ENTRY_ID : `${HOST_RUNTIME_KEY_PREFIX}${hostId}`;
};

// The host a forwarding window shows, for stamping its notifications. Same
// identity rules as the reuse lookup: the runtime the window reported wins, so
// a window opened for a host and switched in place since stamps the instance
// it shows now; its creation-time tag answers only while it has not reported.
// A reported key that resolves to no host gives no id, and the stale tag must
// not take over.
export const resolveSenderHostId = ({ runtimeKey, hostWindowId }, { hosts, localUrl, localClientToken }) => {
  const reported = readTrimmedString(runtimeKey);
  if (!reported) return readTrimmedString(hostWindowId) || null;
  return resolveHostEntryForRuntimeKey(reported, { hosts, localUrl, localClientToken })?.id || null;
};

// A forwarded notification must name the owning runtime in the resolver's
// vocabulary ('local' | 'host:<id>'). The forwarding window's host is
// authoritative: a direct host window's renderer computes an unroutable
// 'url:<origin>' key or inherits a stale one, while the shell knows which
// host the window shows. Windows without a host keep the renderer-provided
// key.
export const resolveForwardedNotificationRuntimeKey = ({ runtimeKey, hostWindowId }) => {
  const hostId = readTrimmedString(hostWindowId);
  if (hostId) return runtimeKeyForDeepLinkHost(hostId);
  return readTrimmedString(runtimeKey);
};

// Flattens a desktop notification input: the UI IPC path wraps fields in
// { payload: {...} }, other paths are flat. Nested payload fields win over
// top-level ones.
export const normalizeNotificationInput = (raw) => {
  const input = notificationInput.catch({}).parse(raw);
  const payload = notificationInput.safeParse(input.payload);
  return payload.success ? { ...input, ...payload.data } : input;
};

// Builds the notification input for a renderer-forwarded desktop_notify:
// flatten the wrapped payload, strip the nested copy, and stamp the runtime
// key with the forwarding window's tag taking precedence. Stripping the
// nested payload matters: maybeShowNativeNotification normalizes again, and
// a surviving nested runtimeKey would shadow the stamp.
export const stampForwardedNotification = (rawInput, hostWindowId) => {
  const { payload: _nested, ...flat } = normalizeNotificationInput(rawInput);
  return {
    ...flat,
    runtimeKey: resolveForwardedNotificationRuntimeKey({
      runtimeKey: flat.runtimeKey,
      hostWindowId,
    }),
  };
};
