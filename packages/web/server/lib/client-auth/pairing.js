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

// The operator's typed device label, capped. Returns null when unset so callers
// can distinguish "no name given" from a real name.
const normalizeStoredLabel = (value) => {
  const normalized = normalizeOptionalString(value);
  if (!normalized) return null;
  return normalized.length > MAX_LABEL_LENGTH ? normalized.slice(0, MAX_LABEL_LENGTH) : normalized;
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

const safeJsonParse = (raw) => {
  try {
    return JSON.parse(raw);
  } catch {
    return null;
  }
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
          expiresAt: normalizeTimestamp(session.expiresAt) || new Date(Date.now() + ttlMs).toISOString(),
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

  const readStore = async () => {
    try {
      const raw = await fsPromises.readFile(storePath, 'utf8');
      return normalizeStore(safeJsonParse(raw));
    } catch (error) {
      if (error?.code === 'ENOENT') return normalizeStore(null);
      throw error;
    }
  };

  const writeStore = async (store) => {
    await fsPromises.mkdir(path.dirname(storePath), { recursive: true, mode: 0o700 });
    await fsPromises.writeFile(storePath, JSON.stringify(normalizeStore(store), null, 2), { mode: 0o600 });
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
      return !Number.isFinite(expiresAt) || expiresAt > now;
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
      if (Date.parse(session.expiresAt) <= Date.now()) throw redeemError();
      if (!session.allowedClientKinds.includes(normalizedKind)) throw redeemError();
      if (!constantTimeEqual(session.secretHash, hashSecret(normalizedSecret), crypto)) throw redeemError();

      // The operator's typed pairing label is THIS server's name for the device
      // (shown in the device list). It wins over the device's self-reported
      // label; fall back to that only when no pairing label was set.
      const label = normalizeOptionalString(session.label)
        || normalizeOptionalString(clientLabel)
        || normalizeOptionalString(deviceName)
        || 'Remote client';
      const result = await remoteClientAuthRuntime.createClient({
        label,
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
