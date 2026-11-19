import type { PairingClientKind, PairingDependencies, PairingInput, PairingSession, PairingStore, RedemptionInput, StoreDependencies, StoredPairingSession } from './contracts.js';
import { hasChmod, isInputArray, isMissingFile, isStoreInput, isStoredInput, isString } from './inputs.js';

const STORE_VERSION = 1;
const PAIRING_ID_PREFIX = 'pair_';
const SECRET_BYTES = 32;
const FINGERPRINT_BYTES = 4;
const DEFAULT_TTL_MS = 10 * 60 * 1000;
const MAX_LABEL_LENGTH = 80;
const GENERIC_REDEEM_ERROR = 'Invalid or expired pairing session';

const normalizeOptionalString = (value: string | null | undefined) => {
  if (value == null) return null;
  const trimmed = value.trim();
  return trimmed.length > 0 ? trimmed : null;
};

const PAIRING_LABEL_PLACEHOLDER = 'Pair new device';

const normalizeStoredLabel = (value: string | null | undefined) => {
  const normalized = normalizeOptionalString(value);
  if (!normalized) return null;
  return normalized.length > MAX_LABEL_LENGTH ? normalized.slice(0, MAX_LABEL_LENGTH) : normalized;
};

const normalizeTimestamp = (value: string | null | undefined) => {
  const normalized = normalizeOptionalString(value);
  if (!normalized) return null;
  const time = Date.parse(normalized);
  return Number.isFinite(time) ? new Date(time).toISOString() : null;
};

const normalizeClientKind = (value: string | null | undefined): PairingClientKind | null => {
  const normalized = normalizeOptionalString(value);
  return normalized === 'mobile' || normalized === 'desktop' ? normalized : null;
};

const normalizeAllowedClientKinds = (value: readonly string[] | null): PairingClientKind[] => {
  if (!value) return ['mobile', 'desktop'];
  const kinds = value.map(normalizeClientKind).filter((kind) => kind !== null);
  return kinds.length > 0 ? Array.from(new Set(kinds)) : ['mobile', 'desktop'];
};

const safeJsonParse = (raw: string) => {
  try {
    const payload: unknown = JSON.parse(raw);
    return isStoreInput(payload) ? payload : null;
  } catch {
    return null;
  }
};

const constantTimeEqual = (left: string, right: string, crypto: StoreDependencies['crypto']) => {
  const leftBuffer = Buffer.from(left, 'hex');
  const rightBuffer = Buffer.from(right, 'hex');
  if (leftBuffer.length !== rightBuffer.length) return false;
  return crypto.timingSafeEqual(leftBuffer, rightBuffer);
};

const publicSession = (session: StoredPairingSession): PairingSession => ({
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
  localOnly: session.localOnly === true,
});

const isPendingSession = (session: StoredPairingSession) => !session.usedAt
  && !session.cancelledAt
  && Number.isFinite(Date.parse(session.expiresAt))
  && Date.parse(session.expiresAt) > Date.now();

const redeemError = () => {
  const error = Object.assign(new Error(GENERIC_REDEEM_ERROR), { statusCode: 400 });
  return error;
};

export const createClientPairingRuntime = ({
  fsPromises,
  path,
  crypto,
  storePath,
  remoteClientAuthRuntime,
  ttlMs = DEFAULT_TTL_MS,
}: PairingDependencies = {}) => {
  if (!fsPromises || !path || !crypto || !storePath || !remoteClientAuthRuntime) {
    throw new Error('createClientPairingRuntime requires fsPromises, path, crypto, storePath, and remoteClientAuthRuntime');
  }

  const nowIso = () => new Date().toISOString();
  const hashSecret = (secret: string) => crypto.createHash('sha256').update(secret).digest('hex');
  const generateId = () => `${PAIRING_ID_PREFIX}${crypto.randomBytes(12).toString('hex')}`;
  const generateSecret = () => crypto.randomBytes(SECRET_BYTES).toString('base64url');
  const generateFingerprint = () => crypto.randomBytes(FINGERPRINT_BYTES).toString('hex').toUpperCase().replace(/^(.{4})(.{4})$/, '$1-$2');
  let storeMutationQueue = Promise.resolve();

  const withStoreMutation = async <T>(fn: () => Promise<T>): Promise<T> => {
    const previous = storeMutationQueue;
    let release: () => void = () => {};
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

  const normalizeStore = (payload: ReturnType<typeof safeJsonParse>): PairingStore => ({
    version: STORE_VERSION,
    sessions: isInputArray(payload?.sessions)
      ? payload.sessions
        .filter(isStoredInput)
        .map((session): StoredPairingSession => ({
          id: isString(session.id) ? session.id : generateId(),
          secretHash: isString(session.secretHash) ? session.secretHash : '',
          createdAt: isString(session.createdAt) ? session.createdAt : nowIso(),
          expiresAt: normalizeTimestamp(isString(session.expiresAt) ? session.expiresAt : null) || new Date(Date.now() + ttlMs).toISOString(),
          usedAt: normalizeTimestamp(isString(session.usedAt) ? session.usedAt : null),
          cancelledAt: normalizeTimestamp(isString(session.cancelledAt) ? session.cancelledAt : null),
          clientId: normalizeOptionalString(isString(session.clientId) ? session.clientId : null),
          label: normalizeStoredLabel(isString(session.label) ? session.label : null),
          fingerprint: normalizeOptionalString(isString(session.fingerprint) ? session.fingerprint : null) || generateFingerprint(),
          allowedClientKinds: normalizeAllowedClientKinds(isInputArray(session.allowedClientKinds) ? session.allowedClientKinds.filter(isString) : null),
          createdByClientId: normalizeOptionalString(isString(session.createdByClientId) ? session.createdByClientId : null),
          usesRelay: session.usesRelay === true,
          localOnly: session.localOnly === true,
        }))
        .filter((session) => session.secretHash.length > 0)
      : [],
  });

  const readStore = async () => {
    try {
      const raw = await fsPromises.readFile(storePath, 'utf8');
      return normalizeStore(safeJsonParse(raw));
    } catch (error) {
      if (isMissingFile(error)) return normalizeStore(null);
      throw error;
    }
  };

  const writeStore = async (store: PairingStore) => {
    await fsPromises.mkdir(path.dirname(storePath), { recursive: true, mode: 0o700 });
    await fsPromises.writeFile(storePath, JSON.stringify(normalizeStore(store), null, 2), { mode: 0o600 });
    if (hasChmod(fsPromises)) {
      await fsPromises.chmod(storePath, 0o600).catch(() => {});
    }
  };

  const sweepExpiredSessionsFromStore = (store: PairingStore) => {
    const now = Date.now();
    const cutoff = now - ttlMs;
    store.sessions = store.sessions.filter((session) => {
      const usedAt = Date.parse(session.usedAt || '');
      const cancelledAt = Date.parse(session.cancelledAt || '');
      const inactiveAt = Number.isFinite(usedAt) ? usedAt : cancelledAt;
      if (Number.isFinite(inactiveAt)) return inactiveAt >= cutoff;
      const expiresAt = Date.parse(session.expiresAt || '');
      return !Number.isFinite(expiresAt) || expiresAt > now;
    });
  };

  const createPairingSession = async ({ label, allowedClientKinds, createdByClientId, usesRelay, localOnly }: PairingInput = {}) => {
    return withStoreMutation(async () => {
      const store = await readStore();
      sweepExpiredSessionsFromStore(store);
      const secret = generateSecret();
      const session: StoredPairingSession = {
        id: generateId(),
        secretHash: hashSecret(secret),
        createdAt: nowIso(),
        expiresAt: new Date(Date.now() + ttlMs).toISOString(),
        usedAt: null,
        cancelledAt: null,
        clientId: null,
        label: normalizeStoredLabel(isString(label) ? label : null),
        fingerprint: generateFingerprint(),
        allowedClientKinds: normalizeAllowedClientKinds(isInputArray(allowedClientKinds) ? allowedClientKinds.filter(isString) : null),
        createdByClientId: normalizeOptionalString(isString(createdByClientId) ? createdByClientId : null),
        usesRelay: usesRelay === true,
        localOnly: localOnly === true,
      };
      store.sessions.push(session);
      await writeStore(store);
      return { pairing: { ...publicSession(session), secret } };
    });
  };

  const listPendingSessions = async () => withStoreMutation(async () => {
    const store = await readStore();
    return store.sessions.filter(isPendingSession).map(publicSession);
  });

  const hasActiveRelaySession = async () => withStoreMutation(async () => {
    const store = await readStore();
    return store.sessions.some((session) => session.usesRelay === true && isPendingSession(session));
  });

  const getPairingSession = async (id: string | null | undefined) => {
    const normalizedId = normalizeOptionalString(isString(id) ? id : null);
    if (!normalizedId) return null;
    return withStoreMutation(async () => {
      const store = await readStore();
      const session = store.sessions.find((entry) => entry.id === normalizedId);
      return session ? publicSession(session) : null;
    });
  };

  const cancelPairingSession = async (id: string | null | undefined) => {
    const normalizedId = normalizeOptionalString(isString(id) ? id : null);
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
  }: RedemptionInput = {}) => {
    const normalizedId = normalizeOptionalString(isString(pairingId) ? pairingId : null);
    const normalizedSecret = normalizeOptionalString(isString(secret) ? secret : null);
    const normalizedKind = normalizeClientKind(isString(clientKind) ? clientKind : null) || 'mobile';
    if (!normalizedId || !normalizedSecret) throw redeemError();

    return withStoreMutation(async () => {
      const store = await readStore();
      const session = store.sessions.find((entry) => entry.id === normalizedId);
      if (!session) throw redeemError();
      if (session.cancelledAt || session.usedAt) throw redeemError();
      if (Date.parse(session.expiresAt) <= Date.now()) throw redeemError();
      if (!session.allowedClientKinds.includes(normalizedKind)) throw redeemError();
      if (!constantTimeEqual(session.secretHash, hashSecret(normalizedSecret), crypto)) throw redeemError();

      const result = await remoteClientAuthRuntime.createClient({
        label: normalizeOptionalString(session.label),
        fallbackLabel: normalizeOptionalString(isString(clientLabel) ? clientLabel : null)
          || normalizeOptionalString(isString(deviceName) ? deviceName : null)
          || 'Remote client',
        clientKind: normalizedKind,
        dedupeKey: normalizeOptionalString(isString(dedupeKey) ? dedupeKey : null) || `pairing:${session.id}`,
        authMethod: 'pairing',
        pairingId: session.id,
        deviceName,
        devicePlatform,
        deviceModel,
        appVersion,
        usesRelay: session.usesRelay === true,
        localOnly: session.localOnly === true,
      });
      session.usedAt = nowIso();
      session.clientId = result.client?.id || null;
      await writeStore(store);
      return { pairing: publicSession(session), client: result.client, token: result.token, replacedClientIds: result.replacedClientIds ?? [] };
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
