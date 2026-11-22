import {
  preserveMalformedJsonFile,
  readDurableJsonFile,
  writeDurableJsonFile,
} from '../shared/durable-json-store.js';

const STORE_VERSION = 1;
const PAIRING_ID_PREFIX = 'pair_';
const SECRET_BYTES = 32;
const FINGERPRINT_BYTES = 4;
const DEFAULT_TTL_MS = 10 * 60 * 1000;
const MAX_LABEL_LENGTH = 80;
const VALID_CLIENT_KINDS = new Set(['mobile', 'desktop']);
const GENERIC_REDEEM_ERROR = 'Invalid or expired pairing session';

const normalizeOptionalString = (value) => {
  if (typeof value !== 'string') return null;
  const trimmed = value.trim();
  return trimmed.length > 0 ? trimmed : null;
};

// Placeholder shown in the pending-devices list when the operator did not type a
// name. It is a DISPLAY default only — the stored label stays null so redeem can
// fall back to the device's own reported name instead of this placeholder.
const PAIRING_LABEL_PLACEHOLDER = 'Pair new device';

// A plain slice at the cap can land between the halves of a surrogate pair,
// leaving a lone high surrogate that encodes as U+FFFD on disk and in the
// device list; move a cut that lands inside a pair back to the pair boundary.
const clipPairSafe = (text, limit) => {
  if (text.length <= limit) return text;
  const clipped = text.slice(0, limit);
  const last = clipped.charCodeAt(clipped.length - 1);
  return last >= 0xd800 && last <= 0xdbff ? clipped.slice(0, -1) : clipped;
};

// The operator's typed device label, capped. Returns null when unset so callers
// can distinguish "no name given" from a real name.
const normalizeStoredLabel = (value) => {
  const normalized = normalizeOptionalString(value);
  if (!normalized) return null;
  return clipPairSafe(normalized, MAX_LABEL_LENGTH);
};

const normalizeTimestamp = (value) => {
  const normalized = normalizeOptionalString(value);
  if (!normalized) return null;
  const time = Date.parse(normalized);
  return Number.isFinite(time) ? new Date(time).toISOString() : null;
};

const normalizeClientKind = (value) => {
  const normalized = normalizeOptionalString(value);
  return normalized && VALID_CLIENT_KINDS.has(normalized) ? normalized : null;
};

const normalizeAllowedClientKinds = (value) => {
  if (!Array.isArray(value)) return ['mobile', 'desktop'];
  const kinds = value.map(normalizeClientKind).filter(Boolean);
  return kinds.length > 0 ? Array.from(new Set(kinds)) : ['mobile', 'desktop'];
};

const constantTimeEqual = (left, right, crypto) => {
  if (typeof left !== 'string' || typeof right !== 'string') return false;
  const leftBuffer = Buffer.from(left, 'hex');
  const rightBuffer = Buffer.from(right, 'hex');
  if (leftBuffer.length !== rightBuffer.length) return false;
  return crypto.timingSafeEqual(leftBuffer, rightBuffer);
};

const publicSession = (session) => ({
  id: session.id,
  createdAt: session.createdAt,
  expiresAt: session.expiresAt,
  usedAt: session.usedAt,
  cancelledAt: session.cancelledAt,
  clientId: session.clientId,
  label: session.label || PAIRING_LABEL_PLACEHOLDER,
  fingerprint: session.fingerprint,
  allowedClientKinds: session.allowedClientKinds,
  createdByClientId: session.createdByClientId,
  usesRelay: session.usesRelay === true,
});

// A pending session is one that can still be redeemed: not used, not cancelled,
// not expired.
const isPendingSession = (session) => !session.usedAt
  && !session.cancelledAt
  && Number.isFinite(Date.parse(session.expiresAt))
  && Date.parse(session.expiresAt) > Date.now();

const redeemError = () => {
  const error = new Error(GENERIC_REDEEM_ERROR);
  error.statusCode = 400;
  return error;
};

export const createClientPairingRuntime = ({
  fsPromises,
  path,
  crypto,
  storePath,
  remoteClientAuthRuntime,
  ttlMs = DEFAULT_TTL_MS,
} = {}) => {
  if (!fsPromises || !path || !crypto || !storePath || !remoteClientAuthRuntime) {
    throw new Error('createClientPairingRuntime requires fsPromises, path, crypto, storePath, and remoteClientAuthRuntime');
  }

  const nowIso = () => new Date().toISOString();
  const hashSecret = (secret) => crypto.createHash('sha256').update(secret).digest('hex');
  const generateId = () => `${PAIRING_ID_PREFIX}${crypto.randomBytes(12).toString('hex')}`;
  const generateSecret = () => crypto.randomBytes(SECRET_BYTES).toString('base64url');
  const generateFingerprint = () => crypto.randomBytes(FINGERPRINT_BYTES).toString('hex').toUpperCase().replace(/^(.{4})(.{4})$/, '$1-$2');
  let storeMutationQueue = Promise.resolve();

  const withStoreMutation = async (fn) => {
    const previous = storeMutationQueue;
    let release;
    storeMutationQueue = new Promise((resolve) => {
      release = resolve;
    });
    await previous;
    try {
      return await fn();
    } finally {
      release();
    }
  };

  const normalizeStore = (payload) => ({
    version: STORE_VERSION,
    sessions: Array.isArray(payload?.sessions)
      ? payload.sessions
        .filter((session) => session && typeof session === 'object')
        .map((session) => ({
          id: typeof session.id === 'string' ? session.id : generateId(),
          secretHash: typeof session.secretHash === 'string' ? session.secretHash : '',
          createdAt: typeof session.createdAt === 'string' ? session.createdAt : nowIso(),
          // A missing or unparseable expiresAt stays null: such a session is
          // expired everywhere it is judged (pending, relay demand, redeem,
          // sweep). Substituting a fresh TTL here would keep its pairing
          // secret redeemable indefinitely and persist the fabricated stamp.
          expiresAt: normalizeTimestamp(session.expiresAt),
          usedAt: normalizeTimestamp(session.usedAt),
          cancelledAt: normalizeTimestamp(session.cancelledAt),
          clientId: normalizeOptionalString(session.clientId),
          label: normalizeStoredLabel(session.label),
          fingerprint: normalizeOptionalString(session.fingerprint) || generateFingerprint(),
          allowedClientKinds: normalizeAllowedClientKinds(session.allowedClientKinds),
          createdByClientId: normalizeOptionalString(session.createdByClientId),
          usesRelay: session.usesRelay === true,
        }))
        .filter((session) => session.secretHash.length > 0)
      : [],
  });

  // This store rides the shared durable-store primitive (design #976):
  // the strict reader judges the file, the preserve helper moves a
  // malformed file aside under the collision-proof preserve name, and
  // the writer is mode-explicit. A torn or otherwise unparseable file is
  // pairing state, not an empty store: its bytes are preserved before
  // any later write can overwrite them, and the loss stays recoverable.
  // The value judgement stays the one this store always made - any
  // parsed JSON reaches normalizeStore, which tolerates every shape -
  // so only unparseable bytes are malformed here. The preserve helper
  // re-reads and re-judges the on-disk bytes before renaming anything,
  // so a valid replacement that landed in the meantime is never moved
  // aside (Codex, PR #890); a 'replaced' outcome re-reads that valid
  // file instead (bounded - repeated replacement is a race no read
  // should chase). A mutation must never overwrite bytes whose
  // preservation failed: they are the only copy of the pairing
  // sessions, so the read fails closed instead.
  const readStore = async (replacements = 0) => {
    const result = await readDurableJsonFile(storePath, { fs: fsPromises });
    if (result.state === 'valid') return normalizeStore(result.value);
    // The primitive collapses an absent file and an EXISTING empty or
    // whitespace-only file into the same 'missing' answer. Only the
    // absent file is the first-run case: empty bytes are unparseable,
    // and the pre-migration reader revalidated them before treating the
    // store as empty - another process sharing this file can replace
    // the empty bytes with valid state while this read is in flight,
    // and returning an empty store here would let a mutation overwrite
    // that replacement and drop its sessions (Codex, PR #1019). So a
    // 'missing' verdict goes through the preserve helper too: it
    // re-reads and re-judges the on-disk bytes, answers 'replaced' for
    // a valid replacement (re-read below), 'missing' for a truly
    // absent file (the first-run return) or for still-empty bytes
    // (which hold no sessions, so there is nothing to preserve), and
    // 'preserved' if the re-read bytes are malformed.
    const preservation = await preserveMalformedJsonFile(storePath, { fs: fsPromises });
    if (preservation.preserved) {
      console.warn(`Failed to read pairing store: preserved the unreadable file at ${preservation.preservedPath}`);
      return normalizeStore(null);
    }
    if (preservation.outcome === 'missing') return normalizeStore(null);
    if (preservation.outcome === 'replaced' && replacements < 3) {
      return readStore(replacements + 1);
    }
    throw new Error('Failed to preserve the unreadable pairing store; refusing to overwrite it');
  };

  const writeStore = async (store) => {
    // The directory mode stays stated here: the primitive's writer
    // creates the directory without a mode, and this store has always
    // made its directory 0o700. The file itself is written by the
    // primitive with its mode stated (0o600 - the store holds session
    // secret hashes), and the chmod keeps the mode true even when the
    // rename landed over an existing file with wider permissions.
    await fsPromises.mkdir(path.dirname(storePath), { recursive: true, mode: 0o700 });
    await writeDurableJsonFile(storePath, JSON.stringify(normalizeStore(store), null, 2), { fs: fsPromises, mode: 0o600 });
    if (typeof fsPromises.chmod === 'function') {
      await fsPromises.chmod(storePath, 0o600).catch(() => {});
    }
  };

  const sweepExpiredSessionsFromStore = (store) => {
    const now = Date.now();
    const cutoff = now - ttlMs;
    store.sessions = store.sessions.filter((session) => {
      const usedAt = Date.parse(session.usedAt || '');
      const cancelledAt = Date.parse(session.cancelledAt || '');
      const inactiveAt = Number.isFinite(usedAt) ? usedAt : cancelledAt;
      if (Number.isFinite(inactiveAt)) return inactiveAt >= cutoff;
      // Never used or cancelled: drop once the session itself has expired —
      // it can no longer be redeemed and would otherwise sit in the store forever.
      const expiresAt = Date.parse(session.expiresAt || '');
      return Number.isFinite(expiresAt) && expiresAt > now;
    });
  };

  const createPairingSession = async ({ label, allowedClientKinds, createdByClientId, usesRelay } = {}) => {
    return withStoreMutation(async () => {
      const store = await readStore();
      sweepExpiredSessionsFromStore(store);
      const secret = generateSecret();
      const session = {
        id: generateId(),
        secretHash: hashSecret(secret),
        createdAt: nowIso(),
        expiresAt: new Date(Date.now() + ttlMs).toISOString(),
        usedAt: null,
        cancelledAt: null,
        clientId: null,
        label: normalizeStoredLabel(label),
        fingerprint: generateFingerprint(),
        allowedClientKinds: normalizeAllowedClientKinds(allowedClientKinds),
        createdByClientId: normalizeOptionalString(createdByClientId),
        usesRelay: usesRelay === true,
      };
      store.sessions.push(session);
      await writeStore(store);
      return { pairing: { ...publicSession(session), secret } };
    });
  };

  // Sessions that can still be redeemed (link created, device not yet connected).
  const listPendingSessions = async () => withStoreMutation(async () => {
    const store = await readStore();
    return store.sessions.filter(isPendingSession).map(publicSession);
  });

  // Relay-transport demand from pairing: any still-redeemable relay session.
  const hasActiveRelaySession = async () => withStoreMutation(async () => {
    const store = await readStore();
    return store.sessions.some((session) => session.usesRelay === true && isPendingSession(session));
  });

  const getPairingSession = async (id) => {
    const normalizedId = normalizeOptionalString(id);
    if (!normalizedId) return null;
    return withStoreMutation(async () => {
      const store = await readStore();
      const session = store.sessions.find((entry) => entry.id === normalizedId);
      return session ? publicSession(session) : null;
    });
  };

  const cancelPairingSession = async (id) => {
    const normalizedId = normalizeOptionalString(id);
    if (!normalizedId) return { cancelled: false };
    return withStoreMutation(async () => {
      const store = await readStore();
      const session = store.sessions.find((entry) => entry.id === normalizedId);
      if (!session) return { cancelled: false };
      if (!session.cancelledAt) session.cancelledAt = nowIso();
      await writeStore(store);
      return { cancelled: true, pairing: publicSession(session) };
    });
  };

  const redeemPairingSession = async ({
    pairingId,
    secret,
    clientLabel,
    clientKind,
    deviceName,
    devicePlatform,
    deviceModel,
    appVersion,
    dedupeKey,
  } = {}) => {
    const normalizedId = normalizeOptionalString(pairingId);
    const normalizedSecret = normalizeOptionalString(secret);
    const normalizedKind = normalizeClientKind(clientKind) || 'mobile';
    if (!normalizedId || !normalizedSecret) throw redeemError();

    return withStoreMutation(async () => {
      const store = await readStore();
      const session = store.sessions.find((entry) => entry.id === normalizedId);
      if (!session) throw redeemError();
      if (session.cancelledAt || session.usedAt) throw redeemError();
      const expiresAtMs = Date.parse(session.expiresAt);
      if (!Number.isFinite(expiresAtMs) || expiresAtMs <= Date.now()) throw redeemError();
      if (!session.allowedClientKinds.includes(normalizedKind)) throw redeemError();
      if (!constantTimeEqual(session.secretHash, hashSecret(normalizedSecret), crypto)) throw redeemError();

      // The operator's typed pairing label is THIS server's name for the device
      // (shown in the device list) and wins outright. The device's self-reported
      // label is only a fallback: on a re-pair with the same dedupeKey,
      // createClient keeps the replaced record's label over it, so a rescan
      // without a typed name does not reset the device to the app default.
      const result = await remoteClientAuthRuntime.createClient({
        label: normalizeOptionalString(session.label),
        fallbackLabel: normalizeOptionalString(clientLabel)
          || normalizeOptionalString(deviceName)
          || 'Remote client',
        clientKind: normalizedKind,
        dedupeKey: normalizeOptionalString(dedupeKey) || `pairing:${session.id}`,
        authMethod: 'pairing',
        pairingId: session.id,
        deviceName,
        devicePlatform,
        deviceModel,
        appVersion,
        usesRelay: session.usesRelay === true,
      });
      session.usedAt = nowIso();
      session.clientId = result.client?.id || null;
      await writeStore(store);
      return { pairing: publicSession(session), client: result.client, token: result.token };
    });
  };

  const sweepExpiredSessions = async () => withStoreMutation(async () => {
    const store = await readStore();
    const before = store.sessions.length;
    sweepExpiredSessionsFromStore(store);
    const purged = before - store.sessions.length;
    if (purged > 0) await writeStore(store);
    return { purged };
  });

  return {
    createPairingSession,
    getPairingSession,
    listPendingSessions,
    hasActiveRelaySession,
    cancelPairingSession,
    redeemPairingSession,
    sweepExpiredSessions,
  };
};
