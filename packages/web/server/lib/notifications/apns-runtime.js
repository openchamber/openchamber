// APNs (Apple Push Notification service) runtime for the native iOS mobile app.
//
// Mirrors push-runtime.js (web push / VAPID) but speaks APNs over HTTP/2 with no extra
// dependency: device tokens are persisted per UI session, and pushes are sent with a
// token-based JWT (ES256) signed by Node's built-in crypto. Wired into the same trigger
// fanout as web push (see runtime.js), so notification content / dedup tags / focus
// suppression are shared.

const APNS_TOKENS_VERSION = 1;
const APNS_HOST_PRODUCTION = 'https://api.push.apple.com';
const APNS_HOST_SANDBOX = 'https://api.sandbox.push.apple.com';
// APNs rejects auth tokens older than 1h; refresh well inside that window.
const JWT_TTL_MS = 50 * 60 * 1000;
const DEFAULT_BUNDLE_ID = 'com.openchamber.app';
const MAX_TOKENS_PER_SESSION = 10;
// APNs reasons that mean the token is permanently invalid → drop it.
const DEAD_TOKEN_REASONS = new Set(['BadDeviceToken', 'Unregistered', 'DeviceTokenNotForTopic']);

const trimmedEnv = (name) => {
  const value = process.env[name];
  return typeof value === 'string' && value.trim().length > 0 ? value.trim() : null;
};

// Env vars commonly store the .p8 with literal "\n" sequences; restore real newlines.
const normalizePem = (value) => (typeof value === 'string' ? value.replace(/\\n/g, '\n').trim() : '');

export const createApnsRuntime = (deps) => {
  const {
    fsPromises,
    path,
    crypto,
    http2,
    APNS_TOKENS_FILE_PATH,
    readSettingsFromDiskMigrated,
    isAnyUiVisible,
  } = deps;

  let persistLock = Promise.resolve();
  let cachedJwt = null; // { token, issuedAtMs, keyId }
  let warnedUnconfigured = false;

  // ---------------------------------------------------------------------------
  // Token persistence (same shape + write-lock pattern as push-runtime.js)
  // ---------------------------------------------------------------------------

  const emptyStore = () => ({ version: APNS_TOKENS_VERSION, tokensBySession: {} });

  const readTokensFromDisk = async () => {
    try {
      const raw = await fsPromises.readFile(APNS_TOKENS_FILE_PATH, 'utf8');
      const parsed = JSON.parse(raw);
      if (!parsed || typeof parsed !== 'object' || parsed.version !== APNS_TOKENS_VERSION) {
        return emptyStore();
      }
      const tokensBySession =
        parsed.tokensBySession && typeof parsed.tokensBySession === 'object' ? parsed.tokensBySession : {};
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
    await fsPromises.writeFile(APNS_TOKENS_FILE_PATH, JSON.stringify(data, null, 2), 'utf8');
  };

  const persistTokenUpdate = async (mutate) => {
    persistLock = persistLock.then(async () => {
      const current = await readTokensFromDisk();
      const next = mutate({ version: APNS_TOKENS_VERSION, tokensBySession: current.tokensBySession || {} });
      await writeTokensToDisk(next);
      return next;
    });
    return persistLock;
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
        };
      })
      .filter(Boolean);
  };

  const addOrUpdateApnsToken = async (uiSessionToken, deviceToken, userAgent) => {
    if (!uiSessionToken || typeof deviceToken !== 'string' || deviceToken.trim().length === 0) return;
    const token = deviceToken.trim();
    const now = Date.now();

    await persistTokenUpdate((current) => {
      const tokensBySession = { ...(current.tokensBySession || {}) };
      const existing = normalizeTokens(tokensBySession[uiSessionToken]);
      const filtered = existing.filter((entry) => entry.deviceToken !== token);
      filtered.unshift({
        deviceToken: token,
        createdAt: now,
        lastSeenAt: now,
        userAgent: typeof userAgent === 'string' && userAgent.length > 0 ? userAgent : undefined,
      });
      tokensBySession[uiSessionToken] = filtered.slice(0, MAX_TOKENS_PER_SESSION);
      return { version: APNS_TOKENS_VERSION, tokensBySession };
    });
  };

  const removeApnsToken = async (uiSessionToken, deviceToken) => {
    if (!uiSessionToken || !deviceToken) return;
    await persistTokenUpdate((current) => {
      const tokensBySession = { ...(current.tokensBySession || {}) };
      const filtered = normalizeTokens(tokensBySession[uiSessionToken]).filter(
        (entry) => entry.deviceToken !== deviceToken,
      );
      if (filtered.length === 0) delete tokensBySession[uiSessionToken];
      else tokensBySession[uiSessionToken] = filtered;
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

  // ---------------------------------------------------------------------------
  // Config (env first, then settings.apnsConfig) — mirrors resolveVapidSubject
  // ---------------------------------------------------------------------------

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
      environment: environment === 'production' ? 'production' : 'sandbox',
    };
  };

  // ---------------------------------------------------------------------------
  // JWT (ES256, JOSE/raw signature) + HTTP/2 send
  // ---------------------------------------------------------------------------

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
        sound: 'default',
        'thread-id': typeof payload?.tag === 'string' ? payload.tag : undefined,
      },
      ...data,
    });
  };

  const sendOne = (client, deviceToken, body, jwt, config) =>
    new Promise((resolve) => {
      const headers = {
        ':method': 'POST',
        ':path': `/3/device/${deviceToken}`,
        authorization: `bearer ${jwt}`,
        'apns-topic': config.bundleId,
        'apns-push-type': 'alert',
        'apns-priority': '10',
      };
      // collapse-id dedups like web-push tags; APNs caps it at 64 bytes.
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

  const sendApnsToAllUiSessions = async (payload, options = {}) => {
    const requireNoSse = options.requireNoSse === true;
    if (requireNoSse && typeof isAnyUiVisible === 'function' && isAnyUiVisible()) {
      return;
    }

    const config = await resolveApnsConfig();
    if (!config) {
      if (!warnedUnconfigured) {
        warnedUnconfigured = true;
        console.warn(
          '[APNs] Not configured; set OPENCHAMBER_APNS_KEY_ID / OPENCHAMBER_APNS_TEAM_ID / OPENCHAMBER_APNS_P8 (or settings.apnsConfig) to enable native iOS push.',
        );
      }
      return;
    }

    const store = await readTokensFromDisk();
    const deviceTokens = new Set();
    for (const record of Object.values(store.tokensBySession || {})) {
      for (const entry of normalizeTokens(record)) deviceTokens.add(entry.deviceToken);
    }
    if (deviceTokens.size === 0) return;

    const host = config.environment === 'production' ? APNS_HOST_PRODUCTION : APNS_HOST_SANDBOX;
    const jwt = getJwt(config);
    const body = buildBody(payload);
    const sendConfig = { ...config, tag: typeof payload?.tag === 'string' ? payload.tag : undefined };

    let client;
    try {
      client = http2.connect(host);
    } catch (error) {
      console.warn('[APNs] connect failed:', error?.message ?? error);
      return;
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
        Array.from(deviceTokens).map((token) => sendOne(client, token, body, jwt, sendConfig)),
      ).finally(finish);
    });
  };

  return {
    addOrUpdateApnsToken,
    removeApnsToken,
    removeApnsTokenFromAllSessions,
    sendApnsToAllUiSessions,
    resolveApnsConfig,
    // exposed for tests
    signApnsJwt,
  };
};
