
import { sessionKeyFor, withHashedSessionKeys } from './session-key.js';
import { parsePushKey, sealPushContent } from './push-seal.js';
import {
  getOrCreateRelaySigningKeypair,
  signRelayMessage as signRelayMessageShared,
} from '../relay/signing-key.js';

const APNS_TOKENS_VERSION = 1;
const APNS_HOST_PRODUCTION = 'https://api.push.apple.com';
const APNS_HOST_SANDBOX = 'https://api.sandbox.push.apple.com';
// external: https://developer.apple.com/documentation/usernotifications/establishing-a-token-based-connection-to-apns APNs rejects authentication tokens older than 1 hour.
const JWT_TTL_MS = 50 * 60 * 1000;
const DEFAULT_BUNDLE_ID = 'com.openchamber.app';
const DEFAULT_RELAY_URL = 'https://api.openchamber.dev/v1/push/send';
const MAX_TOKENS_PER_SESSION = 10;
const MAX_CLEAR_TAGS = 20;
const MAX_CLEAR_ENTRY_LENGTH = 100;
const DEAD_TOKEN_REASONS = new Set(['BadDeviceToken', 'Unregistered', 'DeviceTokenNotForTopic']);
const RELAY_TIMEOUT_MS = 15_000;
const RELAY_RETRY_DELAY_MS = 5_000;
const RELAY_NOT_SENT_CODES = new Set([
  'ECONNREFUSED',
  'ENOTFOUND',
  'EAI_AGAIN',
  'ENETUNREACH',
  'EHOSTUNREACH',
  'UND_ERR_CONNECT_TIMEOUT',
]);
const relayErrorCode = (error) => error?.cause?.code ?? error?.code;

const describeRelayError = (error) => {
  if (error?.name === 'TimeoutError') {
    return `no answer in ${RELAY_TIMEOUT_MS / 1000} s, not retried`;
  }
  const code = relayErrorCode(error);
  const message = error?.message ?? String(error);
  return code && !message.includes(code) ? `${message} (${code})` : message;
};

const postToRelay = async (url, body, label) => {
  const attempt = () =>
    fetch(url, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body,
      signal: AbortSignal.timeout(RELAY_TIMEOUT_MS),
    });
  try {
    return await attempt();
  } catch (error) {
    if (!RELAY_NOT_SENT_CODES.has(relayErrorCode(error))) throw error;
    console.warn(`${label} unreachable (${relayErrorCode(error)}), retrying in ${RELAY_RETRY_DELAY_MS / 1000} s`);
    await new Promise((resolve) => setTimeout(resolve, RELAY_RETRY_DELAY_MS));
    return attempt();
  }
};

const trimmedEnv = (name) => {
  const value = process.env[name];
  return typeof value === 'string' && value.trim().length > 0 ? value.trim() : null;
};

const normalizePem = (value) => (typeof value === 'string' ? value.replace(/\\n/g, '\n').trim() : '');

export const createApnsRuntime = (deps) => {
  const {
    fsPromises,
    path,
    crypto,
    http2,
    APNS_TOKENS_FILE_PATH,
    readSettingsFromDiskMigrated,
    relayKeyStore,
    getInvalidSessionKeys = async () => new Set(),
  } = deps;

  let persistLock = Promise.resolve();
  let legacyKeysScrubQueued = false;
  let cachedJwt = null;
  let cachedRelayKey = null;
  let warnedUnconfigured = false;


  const getOrCreateRelayKeypair = async () => {
    const generation = relayKeyStore.generation();
    if (cachedRelayKey?.generation === generation) return cachedRelayKey.keypair;
    const keypair = await getOrCreateRelaySigningKeypair({ crypto, relayKeyStore });
    cachedRelayKey = { generation, keypair };
    return keypair;
  };

  const signRelayMessage = (privateKey, message) => signRelayMessageShared({ crypto }, privateKey, message);

  const relayPublicJwk = (publicJwk) => ({
    kty: publicJwk.kty,
    crv: publicJwk.crv,
    x: publicJwk.x,
    y: publicJwk.y,
  });

  const registerTokenWithRelay = async (token, platform = 'ios') => {
    const relay = resolveRelayConfig();
    if (!relay) return;
    try {
      const { privateKey, publicJwk } = await getOrCreateRelayKeypair();
      const ts = Date.now();
      const sig = signRelayMessage(privateKey, `${ts}.${token}.${platform}`);
      const res = await postToRelay(
        relay.registerUrl,
        JSON.stringify({ token, platform, publicKeyJwk: relayPublicJwk(publicJwk), ts, sig }),
        '[Push relay] register-token',
      );
      if (!res.ok) console.warn(`[Push relay] register-token failed status=${res.status}`);
    } catch (error) {
      console.warn('[Push relay] register-token request failed:', describeRelayError(error));
    }
  };


  const emptyStore = () => ({ version: APNS_TOKENS_VERSION, tokensBySession: {} });

  const readTokensFromDisk = async () => {
    try {
      const raw = await fsPromises.readFile(APNS_TOKENS_FILE_PATH, 'utf8');
      const parsed = JSON.parse(raw);
      if (!parsed || typeof parsed !== 'object' || parsed.version !== APNS_TOKENS_VERSION) {
        return emptyStore();
      }
      const stored =
        parsed.tokensBySession && typeof parsed.tokensBySession === 'object' ? parsed.tokensBySession : {};
      const { bySession: tokensBySession, changed } = withHashedSessionKeys(stored);
      if (changed && !legacyKeysScrubQueued) {
        legacyKeysScrubQueued = true;
        void persistTokenUpdate((current) => current).catch((error) => {
          console.warn('Failed to rewrite APNs tokens with hashed session keys:', error);
        });
      }
      return { version: APNS_TOKENS_VERSION, tokensBySession };
    } catch (error) {
      if (error && typeof error === 'object' && error.code === 'ENOENT') {
        return emptyStore();
      }
      console.warn('Failed to read APNs tokens file:', error);
      return emptyStore();
    }
  };

  const writeTokensToDisk = async (data) => {
    await fsPromises.mkdir(path.dirname(APNS_TOKENS_FILE_PATH), { recursive: true });
    await fsPromises.writeFile(APNS_TOKENS_FILE_PATH, JSON.stringify(data, null, 2), { encoding: 'utf8', mode: 0o600 });
  };

  const persistTokenUpdate = async (mutate) => {
    const result = persistLock.then(async () => {
      const current = await readTokensFromDisk();
      const next = mutate({ version: APNS_TOKENS_VERSION, tokensBySession: current.tokensBySession || {} });
      await writeTokensToDisk(next);
      return next;
    });
    persistLock = result.catch(() => {});
    return result;
  };

  const normalizeTokens = (record) => {
    if (!Array.isArray(record)) return [];
    return record
      .map((entry) => {
        if (!entry || typeof entry !== 'object') return null;
        const deviceToken = entry.deviceToken;
        if (typeof deviceToken !== 'string' || deviceToken.trim().length === 0) return null;
        return {
          deviceToken: deviceToken.trim(),
          createdAt: typeof entry.createdAt === 'number' ? entry.createdAt : null,
          lastSeenAt: typeof entry.lastSeenAt === 'number' ? entry.lastSeenAt : null,
          userAgent: typeof entry.userAgent === 'string' ? entry.userAgent : undefined,
          platform: entry.platform === 'android' ? 'android' : 'ios',
          environment: entry.environment === 'sandbox' ? 'sandbox' : 'production',
          pushKey: parsePushKey(entry.pushKey) ?? undefined,
        };
      })
      .filter(Boolean);
  };

  const normalizePlatform = (platform) => (platform === 'android' ? 'android' : 'ios');

  const normalizeEnvironment = (environment) => (environment === 'sandbox' ? 'sandbox' : 'production');

  const addOrUpdateApnsToken = async (uiSessionToken, deviceToken, userAgent, platform, environment, pushKey) => {
    if (!uiSessionToken || typeof deviceToken !== 'string' || deviceToken.trim().length === 0) return;
    const token = deviceToken.trim();
    const sessionKey = sessionKeyFor(uiSessionToken);
    const tokenPlatform = normalizePlatform(platform);
    const tokenEnvironment = normalizeEnvironment(environment);
    const now = Date.now();

    await persistTokenUpdate((current) => {
      const tokensBySession = { ...(current.tokensBySession || {}) };
      const existing = normalizeTokens(tokensBySession[sessionKey]);
      const filtered = existing.filter((entry) => entry.deviceToken !== token);
      filtered.unshift({
        deviceToken: token,
        createdAt: now,
        lastSeenAt: now,
        userAgent: typeof userAgent === 'string' && userAgent.length > 0 ? userAgent : undefined,
        platform: tokenPlatform,
        environment: tokenEnvironment,
        pushKey: parsePushKey(pushKey) ?? undefined,
      });
      tokensBySession[sessionKey] = filtered.slice(0, MAX_TOKENS_PER_SESSION);
      return { version: APNS_TOKENS_VERSION, tokensBySession };
    });

    await registerTokenWithRelay(token, tokenPlatform);
  };

  const removeApnsToken = async (uiSessionToken, deviceToken) => {
    if (!uiSessionToken || !deviceToken) return;
    const sessionKey = sessionKeyFor(uiSessionToken);
    await persistTokenUpdate((current) => {
      const tokensBySession = { ...(current.tokensBySession || {}) };
      const filtered = normalizeTokens(tokensBySession[sessionKey]).filter(
        (entry) => entry.deviceToken !== deviceToken,
      );
      if (filtered.length === 0) delete tokensBySession[sessionKey];
      else tokensBySession[sessionKey] = filtered;
      return { version: APNS_TOKENS_VERSION, tokensBySession };
    });
  };

  const removeApnsTokenFromAllSessions = async (deviceToken) => {
    if (!deviceToken) return;
    await persistTokenUpdate((current) => {
      const tokensBySession = { ...(current.tokensBySession || {}) };
      for (const [session, entries] of Object.entries(tokensBySession)) {
        const filtered = normalizeTokens(entries).filter((entry) => entry.deviceToken !== deviceToken);
        if (filtered.length === 0) delete tokensBySession[session];
        else tokensBySession[session] = filtered;
      }
      return { version: APNS_TOKENS_VERSION, tokensBySession };
    });
  };

  const removeApnsDevicesOfSessions = async (sessionKeys, keep) => {
    await persistTokenUpdate((current) => {
      const tokensBySession = { ...(current.tokensBySession || {}) };
      const deviceTokens = new Set(
        sessionKeys.flatMap((key) => normalizeTokens(tokensBySession[key]).map((entry) => entry.deviceToken)),
      );
      for (const [session, entries] of Object.entries(tokensBySession)) {
        if (keep.has(session)) continue;
        const filtered = normalizeTokens(entries).filter((entry) => !deviceTokens.has(entry.deviceToken));
        if (filtered.length === 0) delete tokensBySession[session];
        else tokensBySession[session] = filtered;
      }
      return { version: APNS_TOKENS_VERSION, tokensBySession };
    });
  };


  const resolveApnsConfig = async () => {
    let keyId = trimmedEnv('OPENCHAMBER_APNS_KEY_ID');
    let teamId = trimmedEnv('OPENCHAMBER_APNS_TEAM_ID');
    let bundleId = trimmedEnv('OPENCHAMBER_APNS_BUNDLE_ID');
    let environment = (trimmedEnv('OPENCHAMBER_APNS_ENVIRONMENT') || '').toLowerCase();
    let p8 = normalizePem(process.env.OPENCHAMBER_APNS_P8 || '');

    const p8Path = trimmedEnv('OPENCHAMBER_APNS_P8_PATH');
    if (!p8 && p8Path) {
      try {
        p8 = (await fsPromises.readFile(p8Path, 'utf8')).trim();
      } catch (error) {
        console.warn('[APNs] Failed to read OPENCHAMBER_APNS_P8_PATH:', error?.message ?? error);
      }
    }

    if (!keyId || !teamId || !p8) {
      try {
        const settings = await readSettingsFromDiskMigrated();
        const stored = settings?.apnsConfig;
        if (stored && typeof stored === 'object') {
          keyId = keyId || (typeof stored.keyId === 'string' ? stored.keyId.trim() : null);
          teamId = teamId || (typeof stored.teamId === 'string' ? stored.teamId.trim() : null);
          bundleId = bundleId || (typeof stored.bundleId === 'string' ? stored.bundleId.trim() : null);
          environment = environment || (typeof stored.environment === 'string' ? stored.environment.toLowerCase() : '');
          if (!p8 && typeof stored.p8 === 'string') p8 = normalizePem(stored.p8);
        }
      } catch {
        // settings unavailable — fall through to the unconfigured result
      }
    }

    if (!keyId || !teamId || !p8) return null;

    return {
      keyId,
      teamId,
      p8,
      bundleId: bundleId || DEFAULT_BUNDLE_ID,
      environment: environment === 'sandbox' ? 'sandbox' : environment === 'production' ? 'production' : null,
    };
  };


  const signApnsJwt = (config) => {
    const header = Buffer.from(JSON.stringify({ alg: 'ES256', kid: config.keyId })).toString('base64url');
    const claims = Buffer.from(
      JSON.stringify({ iss: config.teamId, iat: Math.floor(Date.now() / 1000) }),
    ).toString('base64url');
    const signingInput = `${header}.${claims}`;
    const signature = crypto
      .sign('sha256', Buffer.from(signingInput), { key: config.p8, dsaEncoding: 'ieee-p1363' })
      .toString('base64url');
    return `${signingInput}.${signature}`;
  };

  const getJwt = (config) => {
    const now = Date.now();
    if (cachedJwt && cachedJwt.keyId === config.keyId && now - cachedJwt.issuedAtMs < JWT_TTL_MS) {
      return cachedJwt.token;
    }
    const token = signApnsJwt(config);
    cachedJwt = { token, issuedAtMs: now, keyId: config.keyId };
    return token;
  };

  const buildBody = (payload) => {
    const data = payload && typeof payload.data === 'object' && payload.data ? payload.data : {};
    return JSON.stringify({
      aps: {
        alert: {
          title: typeof payload?.title === 'string' ? payload.title : undefined,
          body: typeof payload?.body === 'string' ? payload.body : undefined,
        },
        badge: Number.isFinite(payload?.badge) && payload.badge >= 0 ? Math.trunc(payload.badge) : undefined,
        sound: 'default',
        'thread-id': typeof payload?.tag === 'string' ? payload.tag : undefined,
        'mutable-content': 1,
      },
      ...data,
    });
  };

  // external: https://developer.apple.com/documentation/usernotifications/pushing-background-updates-to-your-app Background pushes use content-available without alert keys and priority 5.
  const buildClearBody = ({ tags, badge }) => JSON.stringify({
    aps: { 'content-available': 1 },
    clear: tags.join(','),
    badge: Number.isFinite(badge) && badge >= 0 ? Math.trunc(badge) : undefined,
  });

  const sendOne = (client, deviceToken, body, jwt, config) =>
    new Promise((resolve) => {
      const background = config.pushType === 'background';
      const headers = {
        ':method': 'POST',
        ':path': `/3/device/${deviceToken}`,
        authorization: `bearer ${jwt}`,
        'apns-topic': config.bundleId,
        'apns-push-type': background ? 'background' : 'alert',
        'apns-priority': background ? '5' : '10',
      };
      // external: https://developer.apple.com/library/archive/documentation/NetworkingInternet/Conceptual/RemoteNotificationsPG/CommunicatingwithAPNs.html APNs limits apns-collapse-id to 64 bytes.
      const collapseId = typeof config.tag === 'string' ? config.tag.slice(0, 64) : undefined;
      if (collapseId) headers['apns-collapse-id'] = collapseId;

      let req;
      try {
        req = client.request(headers);
      } catch (error) {
        console.warn('[APNs] request open failed:', error?.message ?? error);
        resolve();
        return;
      }

      let status = 0;
      let responseBody = '';
      req.on('response', (resHeaders) => {
        status = Number(resHeaders[':status']) || 0;
      });
      req.setEncoding('utf8');
      req.on('data', (chunk) => {
        responseBody += chunk;
      });
      req.on('end', async () => {
        if (status === 200) {
          resolve();
          return;
        }
        let reason = '';
        try {
          reason = JSON.parse(responseBody)?.reason || '';
        } catch {
          // non-JSON error body
        }
        if (status === 410 || DEAD_TOKEN_REASONS.has(reason)) {
          await removeApnsTokenFromAllSessions(deviceToken);
        } else {
          console.warn(`[APNs] push failed status=${status} reason=${reason || 'unknown'}`);
        }
        resolve();
      });
      req.on('error', (error) => {
        console.warn('[APNs] request error:', error?.message ?? error);
        resolve();
      });
      req.end(body);
    });

  const resolveRelayConfig = () => {
    if (trimmedEnv('OPENCHAMBER_PUSH_RELAY_DISABLED') === 'true') return null;
    const url = trimmedEnv('OPENCHAMBER_PUSH_RELAY_URL') || DEFAULT_RELAY_URL;
    const override = (trimmedEnv('OPENCHAMBER_APNS_ENVIRONMENT') || '').toLowerCase();
    return {
      url,
      registerUrl: url.replace(/\/send$/, '/register-token'),
      clearUrl: url.replace(/\/send$/, '/clear'),
      environment: override === 'sandbox' ? 'sandbox' : override === 'production' ? 'production' : null,
    };
  };

  const sendViaRelay = async (deviceTokens, payload, relay, environment) => {
    const tokens = deviceTokens.slice(0, 100);
    const title = typeof payload?.title === 'string' && payload.title.length > 0 ? payload.title : 'OpenChamber';
    const { privateKey, publicJwk } = await getOrCreateRelayKeypair();
    const ts = Date.now();
    const sig = signRelayMessage(privateKey, `${ts}.${[...tokens].sort().join(',')}.${title}`);
    const requestBody = JSON.stringify({
      tokens,
      title,
      body: typeof payload?.body === 'string' ? payload.body : '',
      badge: Number.isFinite(payload?.badge) && payload.badge >= 0 ? Math.trunc(payload.badge) : undefined,
      collapseId: typeof payload?.tag === 'string' ? payload.tag.slice(0, 64) : undefined,
      env: environment,
      data: payload?.data && typeof payload.data === 'object' ? payload.data : undefined,
      publicKeyJwk: relayPublicJwk(publicJwk),
      ts,
      sig,
    });
    try {
      const res = await postToRelay(relay.url, requestBody, '[APNs relay]');
      if (!res.ok) {
        console.warn(`[APNs relay] send failed status=${res.status}`);
        return;
      }
      const data = await res.json().catch(() => null);
      const results = Array.isArray(data?.results) ? data.results : [];
      for (const result of results) {
        if (result && result.drop === true && typeof result.token === 'string') {
          await removeApnsTokenFromAllSessions(result.token);
        }
      }
    } catch (error) {
      console.warn('[APNs relay] request failed:', describeRelayError(error));
    }
  };

  const sendViaDirectApns = async (tokenGroups, { body, tag, pushType }) => {
    const config = await resolveApnsConfig();
    if (!config) {
      if (!warnedUnconfigured) {
        warnedUnconfigured = true;
        console.warn(
          '[APNs] Relay disabled and no direct config; set OPENCHAMBER_APNS_KEY_ID / OPENCHAMBER_APNS_TEAM_ID / OPENCHAMBER_APNS_P8 for direct send.',
        );
      }
      return;
    }

    const jwt = getJwt(config);
    const sendConfig = { ...config, tag, pushType };

    for (const [environment, deviceTokens] of tokenGroups) {
      const effectiveEnvironment = config.environment ?? environment;
      const host = effectiveEnvironment === 'sandbox' ? APNS_HOST_SANDBOX : APNS_HOST_PRODUCTION;

      let client;
      try {
        client = http2.connect(host);
      } catch (error) {
        console.warn('[APNs] connect failed:', error?.message ?? error);
        continue;
      }

      await new Promise((resolve) => {
        let settled = false;
        const finish = () => {
          if (settled) return;
          settled = true;
          try {
            client.close();
          } catch {
            // ignore close errors
          }
          resolve();
        };
        client.on('error', (error) => {
          console.warn('[APNs] session error:', error?.message ?? error);
          finish();
        });
        Promise.all(
          deviceTokens.map((token) => sendOne(client, token, body, jwt, sendConfig)),
        ).finally(finish);
      });
    }
  };

  const readDeliverableDevices = async () => {
    const store = await readTokensFromDisk();
    const invalidSessionKeys = await getInvalidSessionKeys();
    const devices = [];
    const seen = new Set();
    for (const [sessionKey, record] of Object.entries(store.tokensBySession || {})) {
      if (invalidSessionKeys.has(sessionKey)) continue;
      for (const entry of normalizeTokens(record)) {
        if (seen.has(entry.deviceToken)) continue;
        seen.add(entry.deviceToken);
        devices.push(entry);
      }
    }
    return devices;
  };

  const groupByEnvironment = (devices) => {
    const tokensByEnvironment = new Map();
    for (const entry of devices) {
      const group = tokensByEnvironment.get(entry.environment) || [];
      group.push(entry.deviceToken);
      tokensByEnvironment.set(entry.environment, group);
    }
    return tokensByEnvironment;
  };

  const directAlertRequest = (payload) => ({
    body: buildBody(payload),
    tag: payload?.tag,
    pushType: 'alert',
  });

  const sendApnsToAllUiSessions = async ({ sealed, ...payload } = {}, _options = {}) => {
    const sealedContent = sealed ?? { title: payload.title, body: payload.body };
    const devices = await readDeliverableDevices();
    if (devices.length === 0) return;
    const sealedDevices = devices.filter((entry) => entry.pushKey);
    const tokensByEnvironment = groupByEnvironment(devices.filter((entry) => !entry.pushKey));

    const relay = resolveRelayConfig();
    if (relay) {
      await Promise.all([
        ...[...tokensByEnvironment].map(([environment, deviceTokens]) =>
          sendViaRelay(deviceTokens, payload, relay, relay.environment ?? environment)),
        ...sealedDevices.map((entry) =>
          sendViaRelay([entry.deviceToken], sealedPayloadFor(payload, sealedContent, entry.pushKey), relay, relay.environment ?? entry.environment)),
      ]);
      return;
    }
    await sendViaDirectApns(tokensByEnvironment, directAlertRequest(payload));
    for (const entry of sealedDevices) {
      await sendViaDirectApns(
        new Map([[entry.environment, [entry.deviceToken]]]),
        directAlertRequest(sealedPayloadFor(payload, sealedContent, entry.pushKey)),
      );
    }
  };

  let warnedRelayCannotClear = false;

  const clearViaRelay = async (deviceTokens, { tags, badge }, relay, environment) => {
    const tokens = deviceTokens.slice(0, 100);
    const { privateKey, publicJwk } = await getOrCreateRelayKeypair();
    const ts = Date.now();
    const sig = signRelayMessage(privateKey, `${ts}.${[...tokens].sort().join(',')}.clear.${tags.join(',')}`);
    const requestBody = JSON.stringify({
      tokens,
      tags,
      badge: Number.isFinite(badge) && badge >= 0 ? Math.trunc(badge) : undefined,
      env: environment,
      publicKeyJwk: relayPublicJwk(publicJwk),
      ts,
      sig,
    });
    try {
      const res = await postToRelay(relay.clearUrl, requestBody, '[APNs relay] clear');
      if (res.status === 404) {
        if (!warnedRelayCannotClear) {
          warnedRelayCannotClear = true;
          console.warn('[APNs relay] the relay cannot clear notifications yet; phones drop them with the next push');
        }
        return;
      }
      if (!res.ok) {
        console.warn(`[APNs relay] clear failed status=${res.status}`);
        return;
      }
      const data = await res.json().catch(() => null);
      for (const result of Array.isArray(data?.results) ? data.results : []) {
        if (result?.drop === true && result.token) {
          await removeApnsTokenFromAllSessions(result.token);
        }
      }
    } catch (error) {
      console.warn('[APNs relay] clear request failed:', describeRelayError(error));
    }
  };

  const clearApnsNotifications = async ({ tags, badge } = {}) => {
    const clearTags = (Array.isArray(tags) ? tags : [])
      .filter((tag) => tag && tag.length <= MAX_CLEAR_ENTRY_LENGTH)
      .slice(0, MAX_CLEAR_TAGS);
    if (clearTags.length === 0) return;
    const devices = await readDeliverableDevices();
    if (devices.length === 0) return;
    const tokensByEnvironment = groupByEnvironment(devices);
    const request = { tags: clearTags, badge };

    const relay = resolveRelayConfig();
    if (relay) {
      await Promise.all([...tokensByEnvironment].map(([environment, deviceTokens]) =>
        clearViaRelay(deviceTokens, request, relay, relay.environment ?? environment)));
      return;
    }
    await sendViaDirectApns(tokensByEnvironment, { body: buildClearBody(request), pushType: 'background' });
  };

  const sealedPayloadFor = (payload, content, pushKey) => ({
    ...payload,
    body: '',
    data: {
      ...(payload?.data && typeof payload.data === 'object' ? payload.data : {}),
      enc: sealPushContent(pushKey, { title: content.title, body: content.body }),
    },
  });

  return {
    addOrUpdateApnsToken,
    removeApnsToken,
    removeApnsTokenFromAllSessions,
    removeApnsDevicesOfSessions,
    sendApnsToAllUiSessions,
    clearApnsNotifications,
    resolveApnsConfig,
    signApnsJwt,
  };
};
