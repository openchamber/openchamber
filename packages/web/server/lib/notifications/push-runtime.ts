import { sessionKeyFor, withHashedSessionKeys } from './session-key.js';
import { hasStatusCode, isJsonObject, isMissingFile, isNumber, isSessionRecords, isString } from './inputs.js';
import type { JsonValue, PushSettings, SessionRecords } from './contracts.js';

interface PushStore {
  version: number;
  subscriptionsBySession: SessionRecords;
}

interface PushSubscription {
  endpoint: string;
  p256dh: string;
  auth: string;
  createdAt: number | null;
  platform: string | undefined;
}

interface PushDependencies {
  fsPromises: Pick<typeof import('node:fs/promises'), 'readFile' | 'mkdir' | 'writeFile'>;
  path: Pick<typeof import('node:path'), 'dirname'>;
  loadWebPush: () => Promise<{
    generateVAPIDKeys: () => { publicKey: string; privateKey: string };
    setVapidDetails: (subject: string, publicKey: string, privateKey: string) => void;
    sendNotification: (subscription: { endpoint: string; keys: { p256dh: string; auth: string } }, body: string) => Promise<{
      statusCode: number;
      body: string;
      headers: import('node:http').IncomingHttpHeaders;
    }>;
  }>;
  PUSH_SUBSCRIPTIONS_FILE_PATH: string;
  readSettingsFromDiskMigrated: () => Promise<PushSettings>;
  writeSettingsToDisk: (settings: PushSettings) => Promise<void>;
  getInvalidSessionKeys?: () => Promise<Set<string>>;
}

const PUSH_SUBSCRIPTIONS_VERSION = 1;
const UI_VISIBILITY_TTL_MS = 30_000;

const isLoopbackHttpOrigin = (value: string) => {
  return value.startsWith('http://localhost')
    || value.startsWith('http://127.0.0.1')
    || value.startsWith('http://[::1]');
};

export const createPushRuntime = (deps: PushDependencies) => {
  const {
    fsPromises,
    path,
    loadWebPush,
    PUSH_SUBSCRIPTIONS_FILE_PATH,
    readSettingsFromDiskMigrated,
    writeSettingsToDisk,
    getInvalidSessionKeys = async () => new Set(),
  } = deps;

  let persistPushSubscriptionsLock: Promise<void | PushStore> = Promise.resolve();
  let pushInitialized = false;
  let legacyKeysScrubQueued = false;

  const uiVisibilityByToken = new Map<string, { visible: boolean; updatedAt: number; platform: string | undefined }>();
  const pruneUiVisibility = (now = Date.now()) => {
    for (const [token, state] of uiVisibilityByToken) {
      if (!state || now - state.updatedAt > UI_VISIBILITY_TTL_MS) {
        uiVisibilityByToken.delete(token);
      }
    }
  };

  const readPushSubscriptionsFromDisk = async (): Promise<PushStore> => {
    try {
      const raw = await fsPromises.readFile(PUSH_SUBSCRIPTIONS_FILE_PATH, 'utf8');
      const parsed: JsonValue = JSON.parse(raw);
      if (!isJsonObject(parsed)) {
        return { version: PUSH_SUBSCRIPTIONS_VERSION, subscriptionsBySession: {} };
      }
      if (!isNumber(parsed.version) || parsed.version !== PUSH_SUBSCRIPTIONS_VERSION) {
        return { version: PUSH_SUBSCRIPTIONS_VERSION, subscriptionsBySession: {} };
      }

      const stored =
        isSessionRecords(parsed.subscriptionsBySession)
          ? parsed.subscriptionsBySession
          : {};
      const { bySession: subscriptionsBySession, changed } = withHashedSessionKeys(stored);
      if (changed && !legacyKeysScrubQueued) {
        legacyKeysScrubQueued = true;
        void persistPushSubscriptionUpdate((current) => current).catch((error) => {
          console.warn('Failed to rewrite push subscriptions with hashed keys:', error);
        });
      }

      return { version: PUSH_SUBSCRIPTIONS_VERSION, subscriptionsBySession };
    } catch (error) {
      if (isMissingFile(error)) {
        return { version: PUSH_SUBSCRIPTIONS_VERSION, subscriptionsBySession: {} };
      }
      console.warn('Failed to read push subscriptions file:', error);
      return { version: PUSH_SUBSCRIPTIONS_VERSION, subscriptionsBySession: {} };
    }
  };

  const writePushSubscriptionsToDisk = async (data: PushStore) => {
    await fsPromises.mkdir(path.dirname(PUSH_SUBSCRIPTIONS_FILE_PATH), { recursive: true });
    await fsPromises.writeFile(PUSH_SUBSCRIPTIONS_FILE_PATH, JSON.stringify(data, null, 2), { encoding: 'utf8', mode: 0o600 });
  };

  const persistPushSubscriptionUpdate = async (mutate: (store: PushStore) => PushStore) => {
    const result = persistPushSubscriptionsLock.then(async () => {
      await fsPromises.mkdir(path.dirname(PUSH_SUBSCRIPTIONS_FILE_PATH), { recursive: true });
      const current = await readPushSubscriptionsFromDisk();
      const next = mutate({
        version: PUSH_SUBSCRIPTIONS_VERSION,
        subscriptionsBySession: current.subscriptionsBySession || {},
      });
      await writePushSubscriptionsToDisk(next);
      return next;
    });
    persistPushSubscriptionsLock = result.catch(() => {});
    return result;
  };

  const getOrCreateVapidKeys = async () => {
    const settings = await readSettingsFromDiskMigrated();
    const existing = settings?.vapidKeys;
    if (isJsonObject(existing) && isString(existing.publicKey) && isString(existing.privateKey)) {
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

  const normalizePushSubscriptions = (record: JsonValue | undefined): PushSubscription[] => {
    if (!Array.isArray(record)) return [];
    return record
      .map((entry) => {
        if (!isJsonObject(entry)) return null;
        const endpoint = entry.endpoint;
        const p256dh = entry.p256dh;
        const auth = entry.auth;
        if (!isString(endpoint) || !isString(p256dh) || !isString(auth)) {
          return null;
        }
        return {
          endpoint,
          p256dh,
          auth,
          createdAt: isNumber(entry.createdAt) ? entry.createdAt : null,
          platform: isString(entry.platform) ? entry.platform : undefined,
        };
      })
      .filter((entry) => entry !== null);
  };

  const addOrUpdatePushSubscription = async (uiSessionToken: string, subscription: { endpoint: string; p256dh: string; auth: string }, userAgent?: string, platform?: string) => {
    if (!uiSessionToken) {
      return;
    }
    const sessionKey = sessionKeyFor(uiSessionToken);

    await ensurePushInitialized();

    const now = Date.now();

    await persistPushSubscriptionUpdate((current) => {
      const subsBySession = { ...(current.subscriptionsBySession || {}) };
      const record = subsBySession[sessionKey];
      const existing = Array.isArray(record) ? record : [];

      const filtered = existing.filter((entry) => isJsonObject(entry) && isString(entry.endpoint) && entry.endpoint !== subscription.endpoint);

      const previous = existing.find((entry) => isJsonObject(entry) && entry.endpoint === subscription.endpoint);
      filtered.unshift({
        endpoint: subscription.endpoint,
        p256dh: subscription.p256dh,
        auth: subscription.auth,
        createdAt: now,
        lastSeenAt: now,
        userAgent: userAgent && userAgent.length > 0 ? userAgent : undefined,
        platform:
          platform
            ? platform
            : isJsonObject(previous) && isString(previous.platform)
              ? previous.platform
              : undefined,
      });

      subsBySession[sessionKey] = filtered.slice(0, 10);

      return { version: PUSH_SUBSCRIPTIONS_VERSION, subscriptionsBySession: subsBySession };
    });
  };

  const removePushSubscription = async (uiSessionToken: string, endpoint: string) => {
    if (!uiSessionToken || !endpoint) return;
    const sessionKey = sessionKeyFor(uiSessionToken);

    await ensurePushInitialized();

    await persistPushSubscriptionUpdate((current) => {
      const subsBySession = { ...(current.subscriptionsBySession || {}) };
      const record = subsBySession[sessionKey];
      const existing = Array.isArray(record) ? record : [];
      const filtered = existing.filter((entry) => isJsonObject(entry) && isString(entry.endpoint) && entry.endpoint !== endpoint);
      if (filtered.length === 0) {
        delete subsBySession[sessionKey];
      } else {
        subsBySession[sessionKey] = filtered;
      }
      return { version: PUSH_SUBSCRIPTIONS_VERSION, subscriptionsBySession: subsBySession };
    });
  };

  const removePushSubscriptionFromAllSessions = async (endpoint: string) => {
    if (!endpoint) return;

    await ensurePushInitialized();

    await persistPushSubscriptionUpdate((current) => {
      const subsBySession = { ...(current.subscriptionsBySession || {}) };
      for (const [token, entries] of Object.entries(subsBySession)) {
        if (!Array.isArray(entries)) continue;
        const filtered = entries.filter((entry) => isJsonObject(entry) && isString(entry.endpoint) && entry.endpoint !== endpoint);
        if (filtered.length === 0) {
          delete subsBySession[token];
        } else {
          subsBySession[token] = filtered;
        }
      }
      return { version: PUSH_SUBSCRIPTIONS_VERSION, subscriptionsBySession: subsBySession };
    });
  };

  const removePushDevicesOfSessions = async (sessionKeys: string[], keep: Set<string>) => {
    await persistPushSubscriptionUpdate((current) => {
      const subsBySession = { ...(current.subscriptionsBySession || {}) };
      const endpoints = new Set<string | undefined>(
        sessionKeys.flatMap((key) => normalizePushSubscriptions(subsBySession[key]).map((entry) => entry.endpoint)),
      );
      for (const [token, entries] of Object.entries(subsBySession)) {
        if (keep.has(token) || !Array.isArray(entries)) continue;
        const filtered = entries.filter((entry) => !endpoints.has(isJsonObject(entry) && isString(entry.endpoint) ? entry.endpoint : undefined));
        if (filtered.length === 0) {
          delete subsBySession[token];
        } else {
          subsBySession[token] = filtered;
        }
      }
      return { version: PUSH_SUBSCRIPTIONS_VERSION, subscriptionsBySession: subsBySession };
    });
  };

  const sendPushToSubscription = async <Payload>(sub: PushSubscription, payload: Payload) => {
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
      const statusCode = hasStatusCode(error) ? error.statusCode : null;
      if (statusCode === 410 || statusCode === 404) {
        await removePushSubscriptionFromAllSessions(sub.endpoint);
        return;
      }
      console.warn('[Push] Failed to send notification:', error);
    }
  };

  const sendPushToAllUiSessions = async <Payload>(payload: Payload, options: { requireNoSse?: boolean } = {}) => {
    const requireNoSse = options.requireNoSse === true;
    const store = await readPushSubscriptionsFromDisk();
    const invalidSessionKeys = await getInvalidSessionKeys();
    const sessions = store.subscriptionsBySession || {};
    const subscriptionsByEndpoint = new Map<string, PushSubscription>();

    for (const [sessionKey, record] of Object.entries(sessions)) {
      if (invalidSessionKeys.has(sessionKey)) continue;
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
        const suppressed = isMobilePlatform(sub.platform) ? isAnyInteractiveClientVisible() : isAnyUiVisible();
        if (suppressed) return;
      }
      await sendPushToSubscription(sub, payload);
    }));
  };

  const MOBILE_PLATFORMS = new Set(['ios', 'android']);
  const isMobilePlatform = (platform: string | undefined) => platform !== undefined && MOBILE_PLATFORMS.has(platform);

  const updateUiVisibility = (token: string, visible: boolean, platform?: string) => {
    if (!token) return;
    const now = Date.now();
    const nextVisible = Boolean(visible);
    const existing = uiVisibilityByToken.get(token);
    const nextPlatform = platform ? platform : existing?.platform;
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

  const isUiVisible = (token: string) => {
    const now = Date.now();
    pruneUiVisibility(now);
    const state = uiVisibilityByToken.get(token);
    return state?.visible === true && now - state.updatedAt <= UI_VISIBILITY_TTL_MS;
  };

  const resolveVapidSubject = async () => {
    const configured = process.env.OPENCHAMBER_VAPID_SUBJECT;
    if (isString(configured) && configured.trim().length > 0) {
      return configured.trim();
    }

    const originEnv = process.env.OPENCHAMBER_PUBLIC_ORIGIN;
    if (isString(originEnv) && originEnv.trim().length > 0) {
      const trimmed = originEnv.trim();
      if (isLoopbackHttpOrigin(trimmed)) {
        return 'mailto:openchamber@localhost';
      }
      return trimmed;
    }

    try {
      const settings = await readSettingsFromDiskMigrated();
      const stored = settings?.publicOrigin;
      if (isString(stored) && stored.trim().length > 0) {
        const trimmed = stored.trim();
        if (isLoopbackHttpOrigin(trimmed)) {
          return 'mailto:openchamber@localhost';
        }
        return trimmed;
      }
    } catch {
      return 'mailto:openchamber@localhost';
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

  const setPushInitialized = (value: boolean) => {
    pushInitialized = value === true;
  };

  return {
    getOrCreateVapidKeys,
    addOrUpdatePushSubscription,
    removePushSubscription,
    removePushDevicesOfSessions,
    sendPushToAllUiSessions,
    updateUiVisibility,
    isAnyUiVisible,
    isAnyInteractiveClientVisible,
    isUiVisible,
    ensurePushInitialized,
    setPushInitialized,
  };
};
