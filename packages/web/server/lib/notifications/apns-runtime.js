// APNs (Apple Push Notification service) runtime for the native iOS mobile app.
//
// Device tokens are persisted per UI session (mirrors push-runtime.js). Delivery has two
// modes, chosen at send time:
//   - Relay (default): POST tokens + generic text to the central Cloudflare relay, which
//     holds the single project APNs key and signs+sends — so users configure nothing.
//   - Direct (fallback): sign an ES256 JWT with Node crypto and send over HTTP/2 ourselves,
//     for self-hosters who set OPENCHAMBER_APNS_* and OPENCHAMBER_PUSH_RELAY_DISABLED=true.
// Wired into the same trigger fanout as web push (see runtime.js); the relay carries only
// generic, model-based text (no session content) — see APNS.md.

import {
  isJsonObject,
  preserveMalformedJsonFile,
  readDurableJsonFile,
  writeDurableJsonFile,
} from '../shared/durable-json-store.js';
import { sessionKeyFor, withHashedSessionKeys } from './session-key.js';
import { parsePushKey, sealPushContent } from './push-seal.js';
import { readBoundedResponseText } from '../shared/response-body.js';
import { readBoundedFile } from '../shared/bounded-file-read.js';
import {
  getOrCreateRelaySigningKeypair,
  signRelayMessage as signRelayMessageShared,
} from '../relay/signing-key.js';

const APNS_TOKENS_VERSION = 1;
const APNS_HOST_PRODUCTION = 'https://api.push.apple.com';
const APNS_HOST_SANDBOX = 'https://api.sandbox.push.apple.com';
// APNs rejects auth tokens older than 1h; refresh well inside that window.
const JWT_TTL_MS = 50 * 60 * 1000;
const DEFAULT_BUNDLE_ID = 'today.developing.openchamber';
const DEFAULT_RELAY_URL = 'https://api.openchamber.dev/v1/push/send';
const MAX_TOKENS_PER_SESSION = 10;
// A real APNs .p8 signing key is a few hundred bytes; the cap carries
// generous headroom while keeping the key-file read bounded like every
// other read in this module (#1777).
const APNS_P8_MAX_BYTES = 64 * 1024;
// APNs reasons that mean the token is permanently invalid → drop it.
const DEAD_TOKEN_REASONS = new Set(['BadDeviceToken', 'Unregistered', 'DeviceTokenNotForTopic']);

// Every outbound APNs path carries a deadline: a stalled relay or APNs
// stream settles (warn-and-continue) instead of hanging token registration
// or the push fanout. The relay is a small JSON POST and registration is a
// foreground phone request, so its bound is tight; APNs answers are
// normally sub-second, so the direct bound only fires on a genuine wedge.
const APNS_RELAY_REQUEST_TIMEOUT_MS = 10_000;
// The relay answer is only a small results array (drop tokens for at most
// 100 tokens — a few KB at most); cap the body read at 1 MiB (the fleet's
// small-JSON precedent) so an oversized relay body cannot be buffered whole.
const APNS_RELAY_RESPONSE_MAX_BYTES = 1 * 1024 * 1024;
// APNs error bodies are tiny JSON documents ({"reason": "..."}); cap the
// direct-mode body read at the same 1 MiB as the relay path so an oversized
// direct response cannot be buffered whole — the 30s deadline below bounds
// time, not bytes.
const APNS_DIRECT_RESPONSE_MAX_BYTES = 1 * 1024 * 1024;
const APNS_DIRECT_REQUEST_TIMEOUT_MS = 30_000;

// AbortController + explicit timer (the template-runtime.js pattern in this
// folder): the timer is clearable on settle and drivable by test fake timers.
const APNS_COLLAPSE_ID_MAX_BYTES = 64;

// APNs caps apns-collapse-id at 64 BYTES, not characters: truncate by UTF-8
// bytes, stopping on a code-point boundary, so a multi-byte tag never
// produces an over-cap header value and never ends in a lone surrogate.
// ASCII tags are byte-identical to a plain slice.
const truncateToUtf8Bytes = (value, maxBytes) => {
  let bytes = 0;
  let end = 0;
  for (const char of value) {
    const size = Buffer.byteLength(char, 'utf8');
    if (bytes + size > maxBytes) break;
    bytes += size;
    end += char.length;
  }
  return value.slice(0, end);
};

const collapseIdForTag = (tag) => (typeof tag === 'string' ? truncateToUtf8Bytes(tag, APNS_COLLAPSE_ID_MAX_BYTES) : undefined);

const createTimeoutSignal = (timeoutMs) => {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  return { signal: controller.signal, cleanup: () => clearTimeout(timer) };
};

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
    // Host relay identity keys, shared with the private relay (relay/key-store.js).
    relayKeyStore,
  } = deps;

  let persistLock = Promise.resolve();
  let legacyKeysScrubQueued = false;
  let cachedJwt = null; // { token, issuedAtMs, keyId }
  let cachedRelayKey = null; // { generation, keypair: { privateKey, publicJwk } }
  let warnedUnconfigured = false;

  // ---------------------------------------------------------------------------
  // Per-server relay signing identity (ECDSA P-256). Auto-generated + persisted by
  // relay/key-store.js. The relay derives serverId = SHA-256(publicKey), verifies
  // each request's signature, and only delivers to tokens this server registered — so a leaked
  // device token alone can't be used to push. Zero-config: the keypair generates on first use.
  // ---------------------------------------------------------------------------

  // Key access lives in lib/relay/signing-key.js now (shared with the private
  // relay identity — same keypair, same storage, same serverId derivation).
  // Keyed by the store generation: resetting the relay identity mints a new key.
  const getOrCreateRelayKeypair = async () => {
    const generation = relayKeyStore.generation();
    if (cachedRelayKey?.generation === generation) return cachedRelayKey.keypair;
    const keypair = await getOrCreateRelaySigningKeypair({ crypto, relayKeyStore });
    cachedRelayKey = { generation, keypair };
    return keypair;
  };

  const signRelayMessage = (privateKey, message) => signRelayMessageShared({ crypto }, privateKey, message);

  // Trim to the 4 fields the relay's schema accepts (and that feed the serverId hash).
  const relayPublicJwk = (publicJwk) => ({
    kty: publicJwk.kty,
    crv: publicJwk.crv,
    x: publicJwk.x,
    y: publicJwk.y,
  });

  const registerTokenWithRelay = async (token, platform = 'ios') => {
    const relay = resolveRelayConfig();
    if (!relay) return; // direct mode — no relay binding needed
    try {
      const { privateKey, publicJwk } = await getOrCreateRelayKeypair();
      const ts = Date.now();
      // platform is part of the signed message so it can't be tampered en route.
      const sig = signRelayMessage(privateKey, `${ts}.${token}.${platform}`);
      const { signal, cleanup } = createTimeoutSignal(APNS_RELAY_REQUEST_TIMEOUT_MS);
      let res;
      try {
        res = await fetch(relay.registerUrl, {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify({ token, platform, publicKeyJwk: relayPublicJwk(publicJwk), ts, sig }),
          signal,
        });
      } finally {
        cleanup();
      }
      if (!res.ok) console.warn(`[Push relay] register-token failed status=${res.status}`);
    } catch (error) {
      console.warn('[Push relay] register-token request failed:', error?.message ?? error);
    }
  };

  // ---------------------------------------------------------------------------
  // Token persistence (same shape + write-lock pattern as push-runtime.js)
  // ---------------------------------------------------------------------------

  const emptyStore = () => ({ version: APNS_TOKENS_VERSION, tokensBySession: {} });

  // This store rides the shared durable-store primitive (#976, phase 2
  // #978). The value judgement is the one this store always made: a JSON
  // object at APNS_TOKENS_VERSION. Anything else on disk (unparseable
  // bytes, another shape, another version) is malformed, and malformed
  // bytes are device-token state, not an empty store: the primitive
  // preserves them aside under its collision-proof name before any write
  // can replace them. Parse errors are never logged: they can quote the
  // file, and the file holds device tokens.
  const isApnsTokensValue = (value) => isJsonObject(value) && value.version === APNS_TOKENS_VERSION;
  const durableOptions = () => ({ fs: fsPromises, validateValue: isApnsTokensValue });

  // Answers the preserve outcome ('preserved' | 'replaced' | 'missing' |
  // 'failed'); the serialized spelling throws on 'failed' instead.
  const handleCorruptApnsTokensFile = async (serialized) => {
    if (serialized) {
      // Already under the persist lock, so preserving inline cannot race
      // an in-process write. A mutation must never overwrite bytes whose
      // preservation just failed: abort instead; the caller can retry
      // once the file is movable.
      const preservation = await preserveMalformedJsonFile(APNS_TOKENS_FILE_PATH, durableOptions());
      if (preservation.preserved) {
        console.warn(`Failed to read APNs tokens file: preserved the unreadable file at ${preservation.preservedPath}`);
      } else if (preservation.outcome === 'failed') {
        throw new Error('Failed to preserve the unreadable APNs tokens file; refusing to overwrite it');
      }
      return preservation.outcome;
    }
    // Unlocked reader (the send path): the bytes it read are stale the
    // moment the read returns — a concurrent persist may already have
    // preserved the corrupt file and saved valid state in its place, and
    // renaming the file now would move that saved state aside. Queue the
    // preserve under the persist lock; the primitive re-reads and
    // re-judges the on-disk bytes before renaming anything, so a valid
    // replacement is left in place and reported as 'replaced'.
    const run = async () => {
      const preservation = await preserveMalformedJsonFile(APNS_TOKENS_FILE_PATH, durableOptions());
      if (preservation.preserved) {
        console.warn(`Failed to read APNs tokens file: preserved the unreadable file at ${preservation.preservedPath}`);
      } else if (preservation.outcome === 'failed') {
        console.warn('Failed to preserve the unreadable APNs tokens file');
      }
      return preservation.outcome;
    };
    persistLock = persistLock.then(run, run);
    return persistLock;
  };

  const readTokensFromDisk = async ({ serialized = false } = {}) => {
    for (let attempt = 0; attempt < 3; attempt += 1) {
      let result;
      try {
        result = await readDurableJsonFile(APNS_TOKENS_FILE_PATH, durableOptions());
      } catch (error) {
        // A read failure other than absence warns and defaults, the
        // behaviour this store always had.
        console.warn('Failed to read APNs tokens file:', error);
        return emptyStore();
      }
      if (result.state === 'missing') return emptyStore();
      if (result.state === 'malformed') {
        const outcome = await handleCorruptApnsTokensFile(serialized);
        // A valid replacement landed while the malformed bytes were
        // being judged: read that file instead of defaulting.
        if (outcome === 'replaced') continue;
        return emptyStore();
      }
      try {
        const stored =
          result.value.tokensBySession && typeof result.value.tokensBySession === 'object'
            ? result.value.tokensBySession
            : {};
        const { bySession: tokensBySession, changed } = withHashedSessionKeys(stored);
        if (changed && !legacyKeysScrubQueued) {
          // Rewrite once so raw session tokens leave the disk now, not at the
          // next registration.
          legacyKeysScrubQueued = true;
          void persistTokenUpdate((current) => current).catch((error) => {
            console.warn('Failed to rewrite APNs tokens with hashed session keys:', error);
          });
        }
        return { version: APNS_TOKENS_VERSION, tokensBySession };
      } catch (error) {
        console.warn('Failed to read APNs tokens file:', error);
        return emptyStore();
      }
    }
    return emptyStore();
  };

  const writeTokensToDisk = async (data) => {
    // Preserve before replacing, fail-closed (the primitive's contract):
    // the serialized read in the persist path has normally judged the
    // file already, but the write refuses on its own rather than trust
    // that. A valid file, an absent file, and an empty file need no
    // preservation and the write proceeds.
    const preservation = await preserveMalformedJsonFile(APNS_TOKENS_FILE_PATH, durableOptions());
    if (preservation.outcome === 'failed') {
      throw new Error('Failed to preserve the unreadable APNs tokens file; refusing to overwrite it');
    }
    if (preservation.preserved) {
      console.warn(`Failed to read APNs tokens file: preserved the unreadable file at ${preservation.preservedPath}`);
    }
    // Atomic so a crash mid-write leaves the previous store intact, and
    // 0600 because the store holds device tokens.
    await writeDurableJsonFile(APNS_TOKENS_FILE_PATH, JSON.stringify(data, null, 2), {
      fs: fsPromises,
      mode: 0o600,
    });
  };

  const persistTokenUpdate = async (mutate) => {
    const run = async () => {
      const current = await readTokensFromDisk({ serialized: true });
      const next = mutate({ version: APNS_TOKENS_VERSION, tokensBySession: current.tokensBySession || {} });
      await writeTokensToDisk(next);
      return next;
    };
    // Same queue-recovery rule as the push store: the failing caller
    // sees the rejection, later updates must not inherit it (Codex,
    // PR #890).
    const result = persistLock.then(run, run);
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
          // 'ios' (APNs) or 'android' (FCM). Older entries without one are APNs by default.
          platform: entry.platform === 'android' ? 'android' : 'ios',
          // APNs delivery environment for this token. Xcode/dev-signed installs produce
          // sandbox tokens, TestFlight/App Store produce production ones; the client reports
          // which at registration. Older entries without one default to production (matches
          // released builds).
          environment: entry.environment === 'sandbox' ? 'sandbox' : 'production',
          // The device's key for end-to-end sealed text (push-seal.js); absent for
          // apps from before it, which keep getting plain text.
          pushKey: parsePushKey(entry.pushKey) ?? undefined,
        };
      })
      .filter(Boolean);
  };

  // Normalize an incoming platform hint to the two we support; default to APNs/iOS since that
  // was the only registrant before Android/FCM existed.
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

    // (Re)bind this token to our server on the relay so only we can push to it. The device
    // re-sends its token on each launch; this is an idempotent upsert relay-side, and binding
    // every time (not just for new tokens) keeps existing tokens bound after a relay/server
    // upgrade rather than silently going unbound. Platform is bound too so the relay routes
    // it to APNs vs FCM.
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
        // Bounded, handle-judged read (the house standard): an oversized
        // or non-regular file at the path must land in the warn-and-
        // continue path below, never be buffered whole or block the read
        // - this runs on every direct-mode send, with no other deadline.
        const keyFile = await readBoundedFile(p8Path, APNS_P8_MAX_BYTES);
        if (keyFile.ok) {
          p8 = keyFile.buffer.toString('utf8').trim();
        } else {
          console.warn('[APNs] Failed to read OPENCHAMBER_APNS_P8_PATH:', keyFile.code);
        }
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
      // Explicit env/settings value forces every send to that environment; when unset (null),
      // each token is delivered to the environment it registered with.
      environment: environment === 'sandbox' ? 'sandbox' : environment === 'production' ? 'production' : null,
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
        badge: Number.isFinite(payload?.badge) && payload.badge >= 0 ? Math.trunc(payload.badge) : undefined,
        sound: 'default',
        // thread-id keeps the FULL tag on purpose: it is a JSON payload
        // string, not a header, so the 64-byte apns-collapse-id cap does not
        // apply to it — truncating it would change banner grouping for long
        // caller tags for no protocol reason.
        'thread-id': typeof payload?.tag === 'string' ? payload.tag : undefined,
        // Wakes the Notification Service Extension so it can refresh the home/lock-screen
        // widgets (attention count + unread dot) from the push, even when the app is closed.
        // No extra network call — just an extra key on the push we already send.
        'mutable-content': 1,
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
      const collapseId = collapseIdForTag(config.tag);
      if (collapseId) headers['apns-collapse-id'] = collapseId;

      let req;
      try {
        req = client.request(headers);
      } catch (error) {
        console.warn('[APNs] request open failed:', error?.message ?? error);
        resolve();
        return;
      }

      // Bound the request with an own wall-clock timer armed at creation: a
      // stream inactivity timeout may never start behind a session whose
      // connect stalled, so only this settles every case. Destroying the
      // request routes into the error handler below (warn + resolve) — but
      // only when the stream is still live: on a stream APNs already closed
      // (e.g. RST_STREAM CANCEL) destroy() is a no-op and neither 'end' nor
      // 'error' fires, so the 'close' handler below is what settles that case.
      const timeout = setTimeout(() => {
        req.destroy(new Error(`APNs request timed out after ${APNS_DIRECT_REQUEST_TIMEOUT_MS}ms`));
      }, APNS_DIRECT_REQUEST_TIMEOUT_MS);

      let status = 0;
      let responseBody = '';
      let responseBodyBytes = 0;
      let responseOverflow = false;
      req.on('response', (resHeaders) => {
        status = Number(resHeaders[':status']) || 0;
      });
      req.setEncoding('utf8');
      req.on('data', (chunk) => {
        if (responseOverflow) return;
        const text = typeof chunk === 'string' ? chunk : chunk.toString('utf8');
        responseBodyBytes += Buffer.byteLength(text, 'utf8');
        if (responseBodyBytes > APNS_DIRECT_RESPONSE_MAX_BYTES) {
          // Overflow: drop the buffered body (a partial body is never
          // authoritative — in particular it must not trigger dead-token
          // removal) and settle through the existing error terminal
          // handler by destroying the request.
          responseOverflow = true;
          responseBody = '';
          if (typeof req.destroy === 'function') {
            req.destroy(new Error(`APNs response body exceeded ${APNS_DIRECT_RESPONSE_MAX_BYTES} bytes`));
          }
          return;
        }
        responseBody += text;
      });
      let terminal = false;
      req.on('end', async () => {
        terminal = true;
        clearTimeout(timeout);
        if (responseOverflow) {
          console.warn(`[APNs] push failed status=${status} reason=unknown (response body exceeded ${APNS_DIRECT_RESPONSE_MAX_BYTES} bytes)`);
          resolve();
          return;
        }
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
        terminal = true;
        clearTimeout(timeout);
        console.warn('[APNs] request error:', error?.message ?? error);
        resolve();
      });
      req.on('close', () => {
        if (terminal) return;
        terminal = true;
        clearTimeout(timeout);
        console.warn('[APNs] request closed before completing');
        resolve();
      });
      req.end(body);
    });

  // Relay mode (default): the single APNs key lives in the central Cloudflare relay, not on
  // each user's server — so users configure nothing. The server just POSTs device tokens +
  // generic text; the relay signs + sends and reports which tokens to drop. Direct mode (below)
  // is the fallback for self-hosters who set OPENCHAMBER_APNS_* and disable the relay.
  const resolveRelayConfig = () => {
    if (trimmedEnv('OPENCHAMBER_PUSH_RELAY_DISABLED') === 'true') return null;
    const url = trimmedEnv('OPENCHAMBER_PUSH_RELAY_URL') || DEFAULT_RELAY_URL;
    const override = (trimmedEnv('OPENCHAMBER_APNS_ENVIRONMENT') || '').toLowerCase();
    return {
      url,
      registerUrl: url.replace(/\/send$/, '/register-token'),
      // Explicit OPENCHAMBER_APNS_ENVIRONMENT forces every send to that environment; when
      // unset (null), each token is delivered to the environment it registered with.
      environment: override === 'sandbox' ? 'sandbox' : override === 'production' ? 'production' : null,
    };
  };

  const sendViaRelay = async (deviceTokens, payload, relay, environment) => {
    // The relay accepts at most 100 tokens per request. Chunk the group and
    // send every chunk: slicing to the first 100 silently dropped the rest.
    for (let offset = 0; offset < deviceTokens.length; offset += 100) {
      await sendViaRelayChunk(deviceTokens.slice(offset, offset + 100), payload, relay, environment);
    }
  };

  const sendViaRelayChunk = async (tokens, payload, relay, environment) => {
    const title = typeof payload?.title === 'string' && payload.title.length > 0 ? payload.title : 'OpenChamber';
    const { privateKey, publicJwk } = await getOrCreateRelayKeypair();
    const ts = Date.now();
    // Sign over the same canonical form the relay verifies: ts.sortedTokens.title.
    const sig = signRelayMessage(privateKey, `${ts}.${[...tokens].sort().join(',')}.${title}`);
    const requestBody = JSON.stringify({
      tokens,
      title,
      body: typeof payload?.body === 'string' ? payload.body : '',
      badge: Number.isFinite(payload?.badge) && payload.badge >= 0 ? Math.trunc(payload.badge) : undefined,
      collapseId: collapseIdForTag(payload?.tag),
      env: environment,
      data: payload?.data && typeof payload.data === 'object' ? payload.data : undefined,
      publicKeyJwk: relayPublicJwk(publicJwk),
      ts,
      sig,
    });
    const { signal, cleanup } = createTimeoutSignal(APNS_RELAY_REQUEST_TIMEOUT_MS);
    try {
      const res = await fetch(relay.url, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: requestBody,
        signal,
      });
      if (!res.ok) {
        console.warn(`[APNs relay] send failed status=${res.status}`);
        return;
      }
      // Read the body through the bounded reader, not res.json(): the
      // deadline bounds time, not bytes. readBoundedResponseText (not the
      // JSON wrapper) is used so a reader error propagates: the deadline
      // signal stays live until the body is read (see the finally below),
      // so an abort here is a transport failure — the outer catch reports
      // it (#993). An over-cap or malformed body keeps the null fallback:
      // data stays null and no results are acted on.
      const read = await readBoundedResponseText(res, APNS_RELAY_RESPONSE_MAX_BYTES);
      let data = null;
      if (!read.tooLarge) {
        try {
          data = JSON.parse(read.text.charCodeAt(0) === 0xfeff ? read.text.slice(1) : read.text);
        } catch {
          data = null;
        }
      }
      const results = Array.isArray(data?.results) ? data.results : [];
      for (const result of results) {
        if (result && result.drop === true && typeof result.token === 'string') {
          await removeApnsTokenFromAllSessions(result.token);
        }
      }
    } catch (error) {
      console.warn('[APNs relay] request failed:', error?.message ?? error);
    } finally {
      // The signal stays live until the body above has been read: the body
      // read is part of the stall surface.
      cleanup();
    }
  };

  const sendViaDirectApns = async (tokenGroups, payload) => {
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
    const body = buildBody(payload);
    const sendConfig = { ...config, tag: typeof payload?.tag === 'string' ? payload.tag : undefined };

    // One HTTP/2 session per APNs environment; a sandbox token sent to the production host
    // (or vice versa) gets BadDeviceToken and would be wrongly dropped as dead.
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

  // NOT gated on UI visibility (unlike web push). A backgrounded WKWebView can't reliably
  // report "hidden" before iOS suspends it, so a visibility gate wrongly suppressed
  // background push for short responses. Instead we always send, and rely on iOS to NOT
  // display the alert while the app is foreground (presentationOptions: [] in
  // capacitor.config) — so there is no notification when the app is active, with no race.
  // `sealed` is the `{ title, body }` a phone with a key shows; without it the
  // phone opens the same text an app without a key gets in the clear.
  const sendApnsToAllUiSessions = async ({ sealed, ...payload } = {}, _options = {}) => {
    const sealedContent = sealed ?? { title: payload.title, body: payload.body };
    const store = await readTokensFromDisk();
    // Tokens are grouped by their registered APNs environment so each batch goes to the
    // endpoint that actually knows the token (Xcode builds → sandbox, TestFlight/App Store
    // → production). Mixing them gets BadDeviceToken and the token wrongly dropped as dead.
    const tokensByEnvironment = new Map();
    // Devices that gave a push key get their text sealed for them alone, so
    // each is its own send; the rest share one batch per environment.
    const sealedDevices = [];
    const seen = new Set();
    for (const record of Object.values(store.tokensBySession || {})) {
      for (const entry of normalizeTokens(record)) {
        if (seen.has(entry.deviceToken)) continue;
        seen.add(entry.deviceToken);
        if (entry.pushKey) {
          sealedDevices.push(entry);
          continue;
        }
        const group = tokensByEnvironment.get(entry.environment) || [];
        group.push(entry.deviceToken);
        tokensByEnvironment.set(entry.environment, group);
      }
    }
    if (seen.size === 0) return;

    const relay = resolveRelayConfig();
    if (relay) {
      for (const [environment, deviceTokens] of tokensByEnvironment) {
        await sendViaRelay(deviceTokens, payload, relay, relay.environment ?? environment);
      }
      for (const entry of sealedDevices) {
        await sendViaRelay([entry.deviceToken], sealedPayloadFor(payload, sealedContent, entry.pushKey), relay, relay.environment ?? entry.environment);
      }
      return;
    }
    await sendViaDirectApns(tokensByEnvironment, payload);
    for (const entry of sealedDevices) {
      await sendViaDirectApns(new Map([[entry.environment, [entry.deviceToken]]]), sealedPayloadFor(payload, sealedContent, entry.pushKey));
    }
  };

  // What the relay and the push service see for a device with a key: the
  // generic scenario title and an empty body, with the real title and body
  // sealed in `data.enc` for the phone to open.
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
    sendApnsToAllUiSessions,
    resolveApnsConfig,
    // exposed for tests
    signApnsJwt,
  };
};
