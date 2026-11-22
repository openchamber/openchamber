import {
  isJsonObject,
  preserveMalformedJsonFile,
  readDurableJsonFile,
  writeDurableJsonFile,
} from '../shared/durable-json-store.js';
import { sessionKeyFor, withHashedSessionKeys } from './session-key.js';
import { isLoopbackUrl } from '../security/bind-host.js';

const PUSH_SUBSCRIPTIONS_VERSION = 1;
const UI_VISIBILITY_TTL_MS = 30_000;

const isLoopbackHttpOrigin = (value) => isLoopbackUrl(value);

export const createPushRuntime = (deps) => {
  const {
    fsPromises,
    path,
    // Resolves the web-push module; it is loaded on first use, not with the server.
    loadWebPush,
    PUSH_SUBSCRIPTIONS_FILE_PATH,
    readSettingsFromDiskMigrated,
    writeSettingsToDisk,
  } = deps;

  let persistPushSubscriptionsLock = Promise.resolve();
  let pushInitialized = false;
  let legacyKeysScrubQueued = false;

  const uiVisibilityByToken = new Map();
  const pruneUiVisibility = (now = Date.now()) => {
    for (const [token, state] of uiVisibilityByToken) {
      if (!state || now - state.updatedAt > UI_VISIBILITY_TTL_MS) {
        uiVisibilityByToken.delete(token);
      }
    }
  };

  const emptyStore = () => ({ version: PUSH_SUBSCRIPTIONS_VERSION, subscriptionsBySession: {} });

  // This store rides the shared durable-store primitive (#976, phase 2
  // #978). The value judgement is the one this store always made: a JSON
  // object at PUSH_SUBSCRIPTIONS_VERSION. Anything else on disk
  // (unparseable bytes, another shape, another version) is malformed,
  // and malformed bytes are subscription state, not an empty store: the
  // primitive preserves them aside under its collision-proof name
  // before any write can replace them. Parse errors are never logged:
  // they can quote the file, and the file holds subscription keys.
  const isPushSubscriptionsValue = (value) => isJsonObject(value) && value.version === PUSH_SUBSCRIPTIONS_VERSION;
  const durableOptions = () => ({ fs: fsPromises, validateValue: isPushSubscriptionsValue });

  // Answers the preserve outcome ('preserved' | 'replaced' | 'missing' |
  // 'failed'); the serialized spelling throws on 'failed' instead.
  const handleCorruptPushSubscriptionsFile = async (serialized) => {
    if (serialized) {
      // Already under the persist lock, so preserving inline cannot race
      // an in-process write. A mutation must never overwrite bytes whose
      // preservation just failed: abort instead; the caller can retry
      // once the file is movable.
      const preservation = await preserveMalformedJsonFile(PUSH_SUBSCRIPTIONS_FILE_PATH, durableOptions());
      if (preservation.preserved) {
        console.warn(`Failed to read push subscriptions file: preserved the unreadable file at ${preservation.preservedPath}`);
      } else if (preservation.outcome === 'failed') {
        throw new Error('Failed to preserve the unreadable push subscriptions file; refusing to overwrite it');
      }
      return preservation.outcome;
    }
    // Unlocked reader (the send path): the bytes it read are stale the
    // moment the read returns - a concurrent persist may already have
    // preserved the corrupt file and saved valid state in its place, and
    // renaming the file now would move that saved state aside. Queue the
    // preserve under the persist lock; the primitive re-reads and
    // re-judges the on-disk bytes before renaming anything, so a valid
    // replacement is left in place and reported as 'replaced'.
    const run = async () => {
      const preservation = await preserveMalformedJsonFile(PUSH_SUBSCRIPTIONS_FILE_PATH, durableOptions());
      if (preservation.preserved) {
        console.warn(`Failed to read push subscriptions file: preserved the unreadable file at ${preservation.preservedPath}`);
      } else if (preservation.outcome === 'failed') {
        console.warn('Failed to preserve the unreadable push subscriptions file');
      }
      return preservation.outcome;
    };
    persistPushSubscriptionsLock = persistPushSubscriptionsLock.then(run, run);
    return persistPushSubscriptionsLock;
  };

  const readPushSubscriptionsFromDisk = async ({ serialized = false } = {}) => {
    for (let attempt = 0; attempt < 3; attempt += 1) {
      let result;
      try {
        result = await readDurableJsonFile(PUSH_SUBSCRIPTIONS_FILE_PATH, durableOptions());
      } catch (error) {
        // A read failure other than absence warns and defaults, the
        // behaviour this store always had.
        console.warn('Failed to read push subscriptions file:', error);
        return emptyStore();
      }
      if (result.state === 'missing') return emptyStore();
      if (result.state === 'malformed') {
        const outcome = await handleCorruptPushSubscriptionsFile(serialized);
        // A valid replacement landed while the malformed bytes were
        // being judged: read that file instead of defaulting.
        if (outcome === 'replaced') continue;
        return emptyStore();
      }
      try {
        const stored =
          result.value.subscriptionsBySession && typeof result.value.subscriptionsBySession === 'object'
            ? result.value.subscriptionsBySession
            : {};
        const { bySession: subscriptionsBySession, changed } = withHashedSessionKeys(stored);
        if (changed && !legacyKeysScrubQueued) {
          // Rewrite once so raw tokens leave the disk without waiting for the
          // next subscription change.
          legacyKeysScrubQueued = true;
          void persistPushSubscriptionUpdate((current) => current).catch((error) => {
            console.warn('Failed to rewrite push subscriptions with hashed keys:', error);
          });
        }
        return { version: PUSH_SUBSCRIPTIONS_VERSION, subscriptionsBySession };
      } catch (error) {
        console.warn('Failed to read push subscriptions file:', error);
        return emptyStore();
      }
    }
    return emptyStore();
  };

  const writePushSubscriptionsToDisk = async (data) => {
    // Preserve before replacing, fail-closed (the primitive's contract):
    // the serialized read in the persist path has normally judged the
    // file already, but the write refuses on its own rather than trust
    // that. A valid file, an absent file, and an empty file need no
    // preservation and the write proceeds.
    const preservation = await preserveMalformedJsonFile(PUSH_SUBSCRIPTIONS_FILE_PATH, durableOptions());
    if (preservation.outcome === 'failed') {
      throw new Error('Failed to preserve the unreadable push subscriptions file; refusing to overwrite it');
    }
    if (preservation.preserved) {
      console.warn(`Failed to read push subscriptions file: preserved the unreadable file at ${preservation.preservedPath}`);
    }
    // Atomic so a crash mid-write leaves the previous store intact, and
    // 0600 because the store holds subscription keys.
    await writeDurableJsonFile(PUSH_SUBSCRIPTIONS_FILE_PATH, JSON.stringify(data, null, 2), {
      fs: fsPromises,
      mode: 0o600,
    });
  };

  const persistPushSubscriptionUpdate = async (mutate) => {
    const run = async () => {
      await fsPromises.mkdir(path.dirname(PUSH_SUBSCRIPTIONS_FILE_PATH), { recursive: true });
      const current = await readPushSubscriptionsFromDisk({ serialized: true });
      const next = mutate({
        version: PUSH_SUBSCRIPTIONS_VERSION,
        subscriptionsBySession: current.subscriptionsBySession || {},
      });
      await writePushSubscriptionsToDisk(next);
      return next;
    };
    // The failing caller still sees the rejection through the returned
    // promise, but the queue itself must recover: chaining later updates
    // onto a rejected lock would wedge every subsequent registration and
    // removal behind one preservation failure (Codex, PR #890).
    const result = persistPushSubscriptionsLock.then(run, run);
    persistPushSubscriptionsLock = result.catch(() => {});
    return result;
  };

  const getOrCreateVapidKeys = async () => {
    const settings = await readSettingsFromDiskMigrated();
    const existing = settings?.vapidKeys;
    if (existing && typeof existing.publicKey === 'string' && typeof existing.privateKey === 'string') {
      return { publicKey: existing.publicKey, privateKey: existing.privateKey };
    }

    const webPush = await loadWebPush();
    const generated = webPush.generateVAPIDKeys();
    const next = {
      ...settings,
      vapidKeys: {
        publicKey: generated.publicKey,
        privateKey: generated.privateKey,
      },
    };

    await writeSettingsToDisk(next);
    return { publicKey: generated.publicKey, privateKey: generated.privateKey };
  };

  const normalizePushSubscriptions = (record) => {
    if (!Array.isArray(record)) return [];
    return record
      .map((entry) => {
        if (!entry || typeof entry !== 'object') return null;
        const endpoint = entry.endpoint;
        const p256dh = entry.p256dh;
        const auth = entry.auth;
        if (typeof endpoint !== 'string' || typeof p256dh !== 'string' || typeof auth !== 'string') {
          return null;
        }
        return {
          endpoint,
          p256dh,
          auth,
          createdAt: typeof entry.createdAt === 'number' ? entry.createdAt : null,
          platform: typeof entry.platform === 'string' ? entry.platform : undefined,
        };
      })
      .filter(Boolean);
  };

  const addOrUpdatePushSubscription = async (uiSessionToken, subscription, userAgent, platform) => {
    if (!uiSessionToken) {
      return;
    }
    const sessionKey = sessionKeyFor(uiSessionToken);

    await ensurePushInitialized();

    const now = Date.now();

    await persistPushSubscriptionUpdate((current) => {
      const subsBySession = { ...(current.subscriptionsBySession || {}) };
      const existing = Array.isArray(subsBySession[sessionKey]) ? subsBySession[sessionKey] : [];

      const filtered = existing.filter((entry) => entry && typeof entry.endpoint === 'string' && entry.endpoint !== subscription.endpoint);

      const previous = existing.find((entry) => entry && entry.endpoint === subscription.endpoint);
      filtered.unshift({
        endpoint: subscription.endpoint,
        p256dh: subscription.p256dh,
        auth: subscription.auth,
        createdAt: now,
        lastSeenAt: now,
        userAgent: typeof userAgent === 'string' && userAgent.length > 0 ? userAgent : undefined,
        // Platform lets the sender route mobile PWA push through the same presence gate as APNs.
        platform:
          typeof platform === 'string' && platform
            ? platform
            : typeof previous?.platform === 'string'
              ? previous.platform
              : undefined,
      });

      subsBySession[sessionKey] = filtered.slice(0, 10);

      return { version: PUSH_SUBSCRIPTIONS_VERSION, subscriptionsBySession: subsBySession };
    });
  };

  const removePushSubscription = async (uiSessionToken, endpoint) => {
    if (!uiSessionToken || !endpoint) return;
    const sessionKey = sessionKeyFor(uiSessionToken);

    await ensurePushInitialized();

    await persistPushSubscriptionUpdate((current) => {
      const subsBySession = { ...(current.subscriptionsBySession || {}) };
      const existing = Array.isArray(subsBySession[sessionKey]) ? subsBySession[sessionKey] : [];
      const filtered = existing.filter((entry) => entry && typeof entry.endpoint === 'string' && entry.endpoint !== endpoint);
      if (filtered.length === 0) {
        delete subsBySession[sessionKey];
      } else {
        subsBySession[sessionKey] = filtered;
      }
      return { version: PUSH_SUBSCRIPTIONS_VERSION, subscriptionsBySession: subsBySession };
    });
  };

  const removePushSubscriptionFromAllSessions = async (endpoint) => {
    if (!endpoint) return;

    await ensurePushInitialized();

    await persistPushSubscriptionUpdate((current) => {
      const subsBySession = { ...(current.subscriptionsBySession || {}) };
      for (const [token, entries] of Object.entries(subsBySession)) {
        if (!Array.isArray(entries)) continue;
        const filtered = entries.filter((entry) => entry && typeof entry.endpoint === 'string' && entry.endpoint !== endpoint);
        if (filtered.length === 0) {
          delete subsBySession[token];
        } else {
          subsBySession[token] = filtered;
        }
      }
      return { version: PUSH_SUBSCRIPTIONS_VERSION, subscriptionsBySession: subsBySession };
    });
  };

  const sendPushToSubscription = async (sub, payload) => {
    await ensurePushInitialized();
    const body = JSON.stringify(payload);

    const pushSubscription = {
      endpoint: sub.endpoint,
      keys: {
        p256dh: sub.p256dh,
        auth: sub.auth,
      },
    };

    try {
      const webPush = await loadWebPush();
      await webPush.sendNotification(pushSubscription, body);
    } catch (error) {
      const statusCode = typeof error?.statusCode === 'number' ? error.statusCode : null;
      if (statusCode === 410 || statusCode === 404) {
        await removePushSubscriptionFromAllSessions(sub.endpoint);
        return;
      }
      console.warn('[Push] Failed to send notification:', error);
    }
  };

  const sendPushToAllUiSessions = async (payload, options = {}) => {
    const requireNoSse = options.requireNoSse === true;
    const store = await readPushSubscriptionsFromDisk();
    const sessions = store.subscriptionsBySession || {};
    const subscriptionsByEndpoint = new Map();

    for (const record of Object.values(sessions)) {
      const subscriptions = normalizePushSubscriptions(record);
      if (subscriptions.length === 0) continue;

      for (const sub of subscriptions) {
        if (!subscriptionsByEndpoint.has(sub.endpoint)) {
          subscriptionsByEndpoint.set(sub.endpoint, sub);
        }
      }
    }

    await Promise.all(Array.from(subscriptionsByEndpoint.values()).map(async (sub) => {
      if (requireNoSse) {
        // Mobile PWA subscriptions follow the same presence model as native push: suppress only
        // when an interactive (desktop/web) client is visible. The phone PWA's own foreground is
        // handled in the service worker (focused-client check), so it won't double-notify.
        // Non-mobile (desktop/web) subscriptions keep the existing any-visible gate.
        const suppressed = isMobilePlatform(sub.platform) ? isAnyInteractiveClientVisible() : isAnyUiVisible();
        if (suppressed) return;
      }
      await sendPushToSubscription(sub, payload);
    }));
  };

  // A client is "mobile" if it reports a native mobile platform. Anything else (web, desktop,
  // vscode, or an older client that doesn't report a platform) is treated as interactive — i.e.
  // a surface where the user would actually see the in-app notification.
  const MOBILE_PLATFORMS = new Set(['ios', 'android']);
  const isMobilePlatform = (platform) => typeof platform === 'string' && MOBILE_PLATFORMS.has(platform);

  const updateUiVisibility = (token, visible, platform) => {
    if (!token) return;
    const now = Date.now();
    const nextVisible = Boolean(visible);
    const existing = uiVisibilityByToken.get(token);
    // Keep the last known platform if this beacon didn't carry one (e.g. a heartbeat).
    const nextPlatform = typeof platform === 'string' && platform ? platform : existing?.platform;
    uiVisibilityByToken.set(token, { visible: nextVisible, updatedAt: now, platform: nextPlatform });
  };

  const isAnyUiVisible = () => {
    const now = Date.now();
    pruneUiVisibility(now);
    for (const state of uiVisibilityByToken.values()) {
      if (state.visible === true && now - state.updatedAt <= UI_VISIBILITY_TTL_MS) {
        return true;
      }
    }
    return false;
  };

  // True when at least one NON-mobile client (desktop/web/vscode) is currently visible. Used to
  // suppress native push to the phone: an active desktop already shows the notification, so the
  // phone doesn't need it. Deliberately based on the desktop's visibility (reliable), never the
  // phone's own (a backgrounded WKWebView can't report "hidden" before iOS suspends it).
  const isAnyInteractiveClientVisible = () => {
    const now = Date.now();
    pruneUiVisibility(now);
    for (const state of uiVisibilityByToken.values()) {
      if (
        state.visible === true &&
        now - state.updatedAt <= UI_VISIBILITY_TTL_MS &&
        !isMobilePlatform(state.platform)
      ) {
        return true;
      }
    }
    return false;
  };

  const isUiVisible = (token) => {
    const now = Date.now();
    pruneUiVisibility(now);
    const state = uiVisibilityByToken.get(token);
    return state?.visible === true && now - state.updatedAt <= UI_VISIBILITY_TTL_MS;
  };

  const resolveVapidSubject = async () => {
    const configured = process.env.OPENCHAMBER_VAPID_SUBJECT;
    if (typeof configured === 'string' && configured.trim().length > 0) {
      return configured.trim();
    }

    const originEnv = process.env.OPENCHAMBER_PUBLIC_ORIGIN;
    if (typeof originEnv === 'string' && originEnv.trim().length > 0) {
      const trimmed = originEnv.trim();
      if (isLoopbackHttpOrigin(trimmed)) {
        return 'mailto:openchamber@localhost';
      }
      return trimmed;
    }

    try {
      const settings = await readSettingsFromDiskMigrated();
      const stored = settings?.publicOrigin;
      if (typeof stored === 'string' && stored.trim().length > 0) {
        const trimmed = stored.trim();
        if (isLoopbackHttpOrigin(trimmed)) {
          return 'mailto:openchamber@localhost';
        }
        return trimmed;
      }
    } catch {
    }

    return 'mailto:openchamber@localhost';
  };

  const ensurePushInitialized = async () => {
    if (pushInitialized) return;
    const keys = await getOrCreateVapidKeys();
    const subject = await resolveVapidSubject();

    if (subject === 'mailto:openchamber@localhost') {
      console.warn('[Push] No public origin configured for VAPID; set OPENCHAMBER_VAPID_SUBJECT or enable push once from a real origin.');
    }

    const webPush = await loadWebPush();
    webPush.setVapidDetails(subject, keys.publicKey, keys.privateKey);
    pushInitialized = true;
  };

  const setPushInitialized = (value) => {
    pushInitialized = value === true;
  };

  return {
    getOrCreateVapidKeys,
    addOrUpdatePushSubscription,
    removePushSubscription,
    sendPushToAllUiSessions,
    updateUiVisibility,
    isAnyUiVisible,
    isAnyInteractiveClientVisible,
    isUiVisible,
    ensurePushInitialized,
    setPushInitialized,
  };
};
