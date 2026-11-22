
import {
  preserveMalformedJsonFile,
  readDurableJsonFile,
  writeDurableJsonFile,
} from '../shared/durable-json-store.js';
import { sessionKeyFor, withHashedSessionKeys } from './session-key.js';
import { parsePushKey, sealPushContent } from './push-seal.js';
import { readBoundedResponseText } from '../shared/response-body.js';
import { readBoundedFile } from '../shared/bounded-file-read.js';
import {
  deriveServerId,
  getOrCreateRelaySigningKeypair,
  signRelayMessage as signRelayMessageShared,
} from '../relay/signing-key.js';
import type { KeyObject } from 'node:crypto';
import type { ClientHttp2Session, OutgoingHttpHeaders } from 'node:http2';
import type { RelayKeyStore, RelayPublicJwk } from '../relay/key-store.js';
import type { RelaySigningKeypair } from '../relay/signing-key.js';
import type { JsonValue, SessionRecords } from './contracts.js';
import type { PushContent } from './push-seal.js';
import { hasErrorProperties, isIncludesMessage, isJsonObject, isNumber, isString } from './inputs.js';
import type { NotificationFailure } from './inputs.js';

type ApnsEnvironment = 'sandbox' | 'production';

interface ApnsStore {
  version: number;
  tokensBySession: SessionRecords;
}

type ApnsDevice = {
  deviceToken: string;
  createdAt: number | null;
  lastSeenAt: number | null;
  userAgent: string | undefined;
  platform: 'android' | 'ios';
  environment: ApnsEnvironment;
  pushKey: string | undefined;
};

export interface ApnsPayload {
  title?: string | undefined;
  body?: string | undefined;
  badge?: number | undefined;
  tag?: string | undefined;
  data?: { [key: string]: JsonValue | undefined } | undefined;
  sealed?: PushContent | undefined;
}

export interface ApnsClearRequest {
  tags?: string[];
  badge?: number | undefined;
}

interface ApnsConfig {
  keyId: string;
  teamId: string;
  p8: string;
  bundleId: string;
  environment: ApnsEnvironment | null;
}

interface RelayConfig {
  url: string;
  registerUrl: string;
  unregisterUrl: string;
  clearUrl: string;
  environment: ApnsEnvironment | null;
}

interface DirectRequest {
  body: string;
  tag?: string | undefined;
  pushType: 'alert' | 'background';
}

interface ApnsDependencies {
  fsPromises: Pick<typeof import('node:fs/promises'), 'readFile' | 'mkdir' | 'writeFile'>;
  path: Pick<typeof import('node:path'), 'dirname'>;
  crypto: typeof import('node:crypto');
  http2: Pick<typeof import('node:http2'), 'connect'>;
  APNS_TOKENS_FILE_PATH: string;
  readSettingsFromDiskMigrated: () => Promise<{ apnsConfig?: JsonValue }>;
  relayKeyStore: RelayKeyStore;
  getInvalidSessionKeys?: () => Promise<Set<string>>;
}

const APNS_TOKENS_VERSION = 1;
const APNS_HOST_PRODUCTION = 'https://api.push.apple.com';
const APNS_HOST_SANDBOX = 'https://api.sandbox.push.apple.com';
const JWT_TTL_MS = 50 * 60 * 1000;
const DEFAULT_BUNDLE_ID = 'today.developing.openchamber';
const DEFAULT_RELAY_URL = 'https://api.openchamber.dev/v1/push/send';
const MAX_TOKENS_PER_SESSION = 10;
// A real APNs .p8 signing key is a few hundred bytes; the cap carries
// generous headroom while keeping the key-file read bounded like every
// other read in this module (#1777).
const APNS_P8_MAX_BYTES = 64 * 1024;
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
const relayErrorCode = (error: NotificationFailure | undefined) =>
  (hasErrorProperties(error?.cause) ? error.cause.code : undefined) ?? error?.code;

const describeRelayError = (error: NotificationFailure) => {
  if (error?.name === 'TimeoutError') {
    return `no answer in ${RELAY_TIMEOUT_MS / 1000} s, not retried`;
  }
  const code = relayErrorCode(error);
  const message = error?.message ?? String(error);
  if (!code) return message;
  if (!isIncludesMessage(message)) throw new TypeError('message.includes is not a function');
  const included: unknown = Function.prototype.call.call(message.includes, message, code);
  return !included ? `${message} (${code})` : message;
};

const postToRelay = async (url: string, body: string, label: string) => {
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
    const code = relayErrorCode(hasErrorProperties(error) ? error : undefined);
    if (!isString(code) || !RELAY_NOT_SENT_CODES.has(code)) throw error;
    console.warn(`${label} unreachable (${code}), retrying in ${RELAY_RETRY_DELAY_MS / 1000} s`);
    await new Promise((resolve) => setTimeout(resolve, RELAY_RETRY_DELAY_MS));
    return attempt();
  }
};

// Every outbound APNs path carries a deadline: a stalled relay or APNs
// stream settles (warn-and-continue) instead of hanging token registration
// or the push fanout. The relay POST is bounded by RELAY_TIMEOUT_MS in
// postToRelay; APNs answers are normally sub-second, so the direct bound
// below only fires on a genuine wedge.
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

const APNS_COLLAPSE_ID_MAX_BYTES = 64;

// APNs caps apns-collapse-id at 64 BYTES, not characters: truncate by UTF-8
// bytes, stopping on a code-point boundary, so a multi-byte tag never
// produces an over-cap header value and never ends in a lone surrogate.
// ASCII tags are byte-identical to a plain slice.
const truncateToUtf8Bytes = (value: string, maxBytes: number) => {
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

const collapseIdForTag = (tag: unknown) => (typeof tag === 'string' ? truncateToUtf8Bytes(tag, APNS_COLLAPSE_ID_MAX_BYTES) : undefined);

const trimmedEnv = (name: string) => {
  const value = process.env[name];
  return isString(value) && value.trim().length > 0 ? value.trim() : null;
};

const normalizePem = (value: string) => (value.replace(/\\n/g, '\n').trim());

export const createApnsRuntime = (deps: ApnsDependencies) => {
  const {
    fsPromises,
    crypto,
    http2,
    APNS_TOKENS_FILE_PATH,
    readSettingsFromDiskMigrated,
    relayKeyStore,
    getInvalidSessionKeys = async () => new Set<string>(),
  } = deps;

  let persistLock: Promise<unknown> = Promise.resolve();
  let legacyKeysScrubQueued = false;
  let cachedJwt: { token: string; issuedAtMs: number; keyId: string } | null = null;
  let cachedRelayKey: { generation: number; keypair: RelaySigningKeypair } | null = null;
  let warnedUnconfigured = false;


  const getOrCreateRelayKeypair = async () => {
    const generation = relayKeyStore.generation();
    if (cachedRelayKey?.generation === generation) return cachedRelayKey.keypair;
    const keypair = await getOrCreateRelaySigningKeypair({ crypto, relayKeyStore });
    cachedRelayKey = { generation, keypair };
    return keypair;
  };

  const signRelayMessage = (privateKey: KeyObject, message: string) => signRelayMessageShared({ crypto }, privateKey, message);

  const getServerId = async () => deriveServerId({ crypto }, (await getOrCreateRelayKeypair()).publicJwk);

  const relayPublicJwk = (publicJwk: RelayPublicJwk) => ({
    kty: publicJwk.kty,
    crv: publicJwk.crv,
    x: publicJwk.x,
    y: publicJwk.y,
  });

  const registerTokenWithRelay = async (token: string, platform = 'ios') => {
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
      console.warn('[Push relay] register-token request failed:', hasErrorProperties(error) ? describeRelayError(error) : String(error));
    }
  };


  let warnedRelayCannotUnregister = false;

  const unregisterTokenFromRelay = async (token: string) => {
    const relay = resolveRelayConfig();
    if (!relay) return;
    try {
      const { privateKey, publicJwk } = await getOrCreateRelayKeypair();
      const ts = Date.now();
      const sig = signRelayMessage(privateKey, `unregister.${ts}.${token}`);
      const res = await postToRelay(
        relay.unregisterUrl,
        JSON.stringify({ token, publicKeyJwk: relayPublicJwk(publicJwk), ts, sig }),
        '[Push relay] unregister-token',
      );
      if (res.status === 404) {
        if (!warnedRelayCannotUnregister) {
          warnedRelayCannotUnregister = true;
          console.warn('[Push relay] the relay cannot unregister tokens yet; the binding stays until the token dies');
        }
        return;
      }
      if (!res.ok) console.warn(`[Push relay] unregister-token failed status=${res.status}`);
    } catch (error) {
      console.warn('[Push relay] unregister-token request failed:', hasErrorProperties(error) ? describeRelayError(error) : String(error));
    }
  };

  const emptyStore = (): ApnsStore => ({ version: APNS_TOKENS_VERSION, tokensBySession: {} });

  // This store rides the shared durable-store primitive (#976, phase 2
  // #978). The value judgement is the one this store always made: a JSON
  // object at APNS_TOKENS_VERSION. Anything else on disk (unparseable
  // bytes, another shape, another version) is malformed, and malformed
  // bytes are device-token state, not an empty store: the primitive
  // preserves them aside under its collision-proof name before any write
  // can replace them. Parse errors are never logged: they can quote the
  // file, and the file holds device tokens.
  const isApnsTokensValue = (value: unknown) => isJsonObject(value) && value.version === APNS_TOKENS_VERSION;
  const durableOptions = () => ({ fs: fsPromises, validateValue: isApnsTokensValue });

  // Answers the preserve outcome ('preserved' | 'replaced' | 'missing' |
  // 'failed'); the serialized spelling throws on 'failed' instead.
  const handleCorruptApnsTokensFile = async (serialized: boolean) => {
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
    const queued = persistLock.then(run, run);
    persistLock = queued;
    return queued;
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

  const writeTokensToDisk = async (data: ApnsStore) => {
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

  const persistTokenUpdate = async (mutate: (store: ApnsStore) => ApnsStore) => {
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

  const normalizeTokens = (record: JsonValue | undefined): ApnsDevice[] => {
    if (!Array.isArray(record)) return [];
    return record
      .map((entry: JsonValue): ApnsDevice | null => {
        if (!isJsonObject(entry)) return null;
        const deviceToken = entry.deviceToken;
        if (!isString(deviceToken) || deviceToken.trim().length === 0) return null;
        return {
          deviceToken: deviceToken.trim(),
          createdAt: isNumber(entry.createdAt) ? entry.createdAt : null,
          lastSeenAt: isNumber(entry.lastSeenAt) ? entry.lastSeenAt : null,
          userAgent: isString(entry.userAgent) ? entry.userAgent : undefined,
          platform: entry.platform === 'android' ? 'android' : 'ios',
          environment: entry.environment === 'sandbox' ? 'sandbox' : 'production',
          pushKey: parsePushKey(entry.pushKey) ?? undefined,
        };
      })
      .filter((entry) => entry !== null);
  };

  const normalizePlatform = (platform: string | undefined) => (platform === 'android' ? 'android' : 'ios');

  const normalizeEnvironment = (environment: string | undefined) => (environment === 'sandbox' ? 'sandbox' : 'production');

  const addOrUpdateApnsToken = async (uiSessionToken: string, deviceToken: string, userAgent?: string, platform?: string, environment?: string, pushKey?: JsonValue) => {
    if (!uiSessionToken || deviceToken.trim().length === 0) return;
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
        userAgent: userAgent && userAgent.length > 0 ? userAgent : undefined,
        platform: tokenPlatform,
        environment: tokenEnvironment,
        pushKey: parsePushKey(pushKey) ?? undefined,
      });
      tokensBySession[sessionKey] = filtered.slice(0, MAX_TOKENS_PER_SESSION);
      return { version: APNS_TOKENS_VERSION, tokensBySession };
    });

    await registerTokenWithRelay(token, tokenPlatform);
  };

  const removeApnsToken = async (uiSessionToken: string, deviceToken: string) => {
    if (!uiSessionToken || !deviceToken) return;
    const sessionKey = sessionKeyFor(uiSessionToken);
    let removed = false;
    const next = await persistTokenUpdate((current) => {
      const tokensBySession = { ...(current.tokensBySession || {}) };
      const existing = normalizeTokens(tokensBySession[sessionKey]);
      const filtered = existing.filter((entry) => entry.deviceToken !== deviceToken);
      removed = filtered.length < existing.length;
      if (filtered.length === 0) delete tokensBySession[sessionKey];
      else tokensBySession[sessionKey] = filtered;
      return { version: APNS_TOKENS_VERSION, tokensBySession };
    });
    if (!removed) return;
    const stillRegistered = Object.values(next.tokensBySession)
      .some((entries) => normalizeTokens(entries).some((entry) => entry.deviceToken === deviceToken));
    if (!stillRegistered) await unregisterTokenFromRelay(deviceToken);
  };

  const removeApnsTokenFromAllSessions = async (deviceToken: JsonValue | undefined) => {
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

  const removeApnsDevicesOfSessions = async (sessionKeys: string[], keep: Set<string>) => {
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


  const resolveApnsConfig = async (): Promise<ApnsConfig | null> => {
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
        console.warn('[APNs] Failed to read OPENCHAMBER_APNS_P8_PATH:', hasErrorProperties(error) ? error.message ?? error : error);
      }
    }

    if (!keyId || !teamId || !p8) {
      try {
        const settings = await readSettingsFromDiskMigrated();
        const stored = settings?.apnsConfig;
        if (isJsonObject(stored)) {
          keyId = keyId || (isString(stored.keyId) ? stored.keyId.trim() : null);
          teamId = teamId || (isString(stored.teamId) ? stored.teamId.trim() : null);
          bundleId = bundleId || (isString(stored.bundleId) ? stored.bundleId.trim() : null);
          environment = environment || (isString(stored.environment) ? stored.environment.toLowerCase() : '');
          if (!p8 && isString(stored.p8)) p8 = normalizePem(stored.p8);
        }
      } catch {
        void 0;
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


  const signApnsJwt = (config: Pick<ApnsConfig, 'keyId' | 'teamId' | 'p8'>) => {
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

  const getJwt = (config: ApnsConfig) => {
    const now = Date.now();
    if (cachedJwt && cachedJwt.keyId === config.keyId && now - cachedJwt.issuedAtMs < JWT_TTL_MS) {
      return cachedJwt.token;
    }
    const token = signApnsJwt(config);
    cachedJwt = { token, issuedAtMs: now, keyId: config.keyId };
    return token;
  };

  const buildBody = (payload: ApnsPayload) => {
    const data = payload.data ?? {};
    return JSON.stringify({
      aps: {
        alert: {
          title: payload?.title,
          body: payload?.body,
        },
        badge: Number.isFinite(payload?.badge) && payload.badge !== undefined && payload.badge >= 0 ? Math.trunc(payload.badge) : undefined,
        sound: 'default',
        // thread-id keeps the FULL tag on purpose: it is a JSON payload
        // string, not a header, so the 64-byte apns-collapse-id cap does not
        // apply to it — truncating it would change banner grouping for long
        // caller tags for no protocol reason.
        'thread-id': payload?.tag,
        'mutable-content': 1,
      },
      ...data,
    });
  };

  const buildClearBody = ({ tags, badge }: { tags: string[]; badge: number | undefined }) => JSON.stringify({
    aps: { 'content-available': 1 },
    clear: tags.join(','),
    badge: Number.isFinite(badge) && badge !== undefined && badge >= 0 ? Math.trunc(badge) : undefined,
  });

  const sendOne = (client: ClientHttp2Session, deviceToken: string, body: string, jwt: string, config: ApnsConfig & Omit<DirectRequest, 'body'>) =>
    new Promise<void>((resolve) => {
      const background = config.pushType === 'background';
      const headers: OutgoingHttpHeaders = {
        ':method': 'POST',
        ':path': `/3/device/${deviceToken}`,
        authorization: `bearer ${jwt}`,
        'apns-topic': config.bundleId,
        'apns-push-type': background ? 'background' : 'alert',
        'apns-priority': background ? '5' : '10',
      };
      const collapseId = collapseIdForTag(config.tag);
      if (collapseId) headers['apns-collapse-id'] = collapseId;

      let req;
      try {
        req = client.request(headers);
      } catch (error) {
        console.warn('[APNs] request open failed:', hasErrorProperties(error) ? error.message ?? error : error);
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
        let reason: JsonValue | undefined = '';
        try {
          const parsed: JsonValue = JSON.parse(responseBody);
          reason = (isJsonObject(parsed) ? parsed.reason : undefined) || '';
        } catch {
          void 0;
        }
        if (status === 410 || (isString(reason) && DEAD_TOKEN_REASONS.has(reason))) {
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

  const resolveRelayConfig = (): RelayConfig | null => {
    if (trimmedEnv('OPENCHAMBER_PUSH_RELAY_DISABLED') === 'true') return null;
    const url = trimmedEnv('OPENCHAMBER_PUSH_RELAY_URL') || DEFAULT_RELAY_URL;
    const override = (trimmedEnv('OPENCHAMBER_APNS_ENVIRONMENT') || '').toLowerCase();
    return {
      url,
      registerUrl: url.replace(/\/send$/, '/register-token'),
      unregisterUrl: url.replace(/\/send$/, '/unregister-token'),
      clearUrl: url.replace(/\/send$/, '/clear'),
      environment: override === 'sandbox' ? 'sandbox' : override === 'production' ? 'production' : null,
    };
  };

  const sendViaRelay = async (deviceTokens: string[], payload: ApnsPayload, relay: RelayConfig, environment: ApnsEnvironment) => {
    // The relay accepts at most 100 tokens per request. Chunk the group and
    // send every chunk: slicing to the first 100 silently dropped the rest.
    for (let offset = 0; offset < deviceTokens.length; offset += 100) {
      await sendViaRelayChunk(deviceTokens.slice(offset, offset + 100), payload, relay, environment);
    }
  };

  const sendViaRelayChunk = async (tokens: string[], payload: ApnsPayload, relay: RelayConfig, environment: ApnsEnvironment) => {
    const title = payload?.title && payload.title.length > 0 ? payload.title : 'OpenChamber';
    const { privateKey, publicJwk } = await getOrCreateRelayKeypair();
    const ts = Date.now();
    const sig = signRelayMessage(privateKey, `${ts}.${[...tokens].sort().join(',')}.${title}`);
    const requestBody = JSON.stringify({
      tokens,
      title,
      body: payload?.body ?? '',
      badge: Number.isFinite(payload?.badge) && payload.badge !== undefined && payload.badge >= 0 ? Math.trunc(payload.badge) : undefined,
      collapseId: collapseIdForTag(payload?.tag),
      env: environment,
      data: payload?.data,
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
      // Read the body through the bounded reader, not res.json(): the
      // deadline bounds time, not bytes. An over-cap or malformed body keeps
      // the null fallback: data stays null and no results are acted on.
      const read = await readBoundedResponseText(res, APNS_RELAY_RESPONSE_MAX_BYTES);
      let data: JsonValue = null;
      if (!read.tooLarge) {
        try {
          data = JSON.parse(read.text.charCodeAt(0) === 0xfeff ? read.text.slice(1) : read.text);
        } catch {
          data = null;
        }
      }
      const results = isJsonObject(data) && Array.isArray(data.results) ? data.results : [];
      for (const result of results) {
        if (isJsonObject(result) && result.drop === true && isString(result.token)) {
          await removeApnsTokenFromAllSessions(result.token);
        }
      }
    } catch (error) {
      console.warn('[APNs relay] request failed:', hasErrorProperties(error) ? describeRelayError(error) : String(error));
    }
  };

  const sendViaDirectApns = async (tokenGroups: Map<ApnsEnvironment, string[]>, { body, tag, pushType }: DirectRequest) => {
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
        console.warn('[APNs] connect failed:', hasErrorProperties(error) ? error.message ?? error : error);
        continue;
      }

      await new Promise<void>((resolve) => {
        let settled = false;
        const finish = () => {
          if (settled) return;
          settled = true;
          try {
            client.close();
          } catch {
            void 0;
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
    const devices: ApnsDevice[] = [];
    const seen = new Set<string>();
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

  const groupByEnvironment = (devices: ApnsDevice[]) => {
    const tokensByEnvironment = new Map<ApnsEnvironment, string[]>();
    for (const entry of devices) {
      const group = tokensByEnvironment.get(entry.environment) || [];
      group.push(entry.deviceToken);
      tokensByEnvironment.set(entry.environment, group);
    }
    return tokensByEnvironment;
  };

  const directAlertRequest = (payload: ApnsPayload): DirectRequest => ({
    body: buildBody(payload),
    tag: payload?.tag,
    pushType: 'alert',
  });

  const withServerId = (payload: ApnsPayload, serverId: string): ApnsPayload => ({
    ...payload,
    data: { ...payload.data, serverId },
  });

  const sendApnsToAllUiSessions = async ({ sealed, ...payload }: ApnsPayload = {}, _options = {}) => {
    const sealedContent = sealed ?? { title: payload.title, body: payload.body };
    const devices = await readDeliverableDevices();
    if (devices.length === 0) return;
    const serverId = await getServerId().catch(() => null);
    const routedPayload = serverId ? withServerId(payload, serverId) : payload;
    const sealedDevices = devices.filter((entry): entry is ApnsDevice & { pushKey: string } => Boolean(entry.pushKey));
    const tokensByEnvironment = groupByEnvironment(devices.filter((entry) => !entry.pushKey));

    const relay = resolveRelayConfig();
    if (relay) {
      await Promise.all([
        ...[...tokensByEnvironment].map(([environment, deviceTokens]) =>
          sendViaRelay(deviceTokens, routedPayload, relay, relay.environment ?? environment)),
        ...sealedDevices.map((entry) =>
          sendViaRelay([entry.deviceToken], sealedPayloadFor(routedPayload, sealedContent, entry.pushKey), relay, relay.environment ?? entry.environment)),
      ]);
      return;
    }
    await sendViaDirectApns(tokensByEnvironment, directAlertRequest(routedPayload));
    for (const entry of sealedDevices) {
      await sendViaDirectApns(
        new Map([[entry.environment, [entry.deviceToken]]]),
        directAlertRequest(sealedPayloadFor(routedPayload, sealedContent, entry.pushKey)),
      );
    }
  };

  let warnedRelayCannotClear = false;

  const clearViaRelay = async (deviceTokens: string[], { tags, badge }: { tags: string[]; badge: number | undefined }, relay: RelayConfig, environment: ApnsEnvironment) => {
    const tokens = deviceTokens.slice(0, 100);
    const { privateKey, publicJwk } = await getOrCreateRelayKeypair();
    const ts = Date.now();
    const sig = signRelayMessage(privateKey, `${ts}.${[...tokens].sort().join(',')}.clear.${tags.join(',')}`);
    const requestBody = JSON.stringify({
      tokens,
      tags,
      badge: Number.isFinite(badge) && badge !== undefined && badge >= 0 ? Math.trunc(badge) : undefined,
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
      const data: JsonValue = await res.json().catch(() => null);
      for (const result of isJsonObject(data) && Array.isArray(data.results) ? data.results : []) {
        if (isJsonObject(result) && result.drop === true && result.token) {
          await removeApnsTokenFromAllSessions(result.token);
        }
      }
    } catch (error) {
      console.warn('[APNs relay] clear request failed:', hasErrorProperties(error) ? describeRelayError(error) : String(error));
    }
  };

  const clearApnsNotifications = async ({ tags, badge }: ApnsClearRequest = {}) => {
    const clearTags = (Array.isArray(tags) ? tags : [])
      .filter((tag) => tag && tag.length <= MAX_CLEAR_ENTRY_LENGTH);
    if (clearTags.length === 0) return;
    const devices = await readDeliverableDevices();
    if (devices.length === 0) return;
    const tokensByEnvironment = groupByEnvironment(devices);
    const relay = resolveRelayConfig();
    for (let offset = 0; offset < clearTags.length; offset += MAX_CLEAR_TAGS) {
      const request = { tags: clearTags.slice(offset, offset + MAX_CLEAR_TAGS), badge };
      if (relay) {
        await Promise.all([...tokensByEnvironment].map(([environment, deviceTokens]) =>
          clearViaRelay(deviceTokens, request, relay, relay.environment ?? environment)));
      } else {
        await sendViaDirectApns(tokensByEnvironment, { body: buildClearBody(request), pushType: 'background' });
      }
    }
  };

  const sealedPayloadFor = (payload: ApnsPayload, content: PushContent, pushKey: string) => ({
    ...payload,
    body: '',
    data: {
      ...payload?.data,
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
