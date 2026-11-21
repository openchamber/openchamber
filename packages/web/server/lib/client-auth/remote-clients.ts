import type { BearerRequest, ClientInput, ClientStore, CreatedClient, RemoteClient, StoreDependencies, StoredClient, StoredInput } from './contracts.js';
import { hasRelayProvenance } from '../relay/provenance.js';
import { hasChmod, isInputArray, isMissingFile, isStoreInput, isStoredInput, isString } from './inputs.js';

const STORE_VERSION = 1;
const TOKEN_PREFIX = 'oc_client_';
const TOKEN_BYTES = 32;
const MAX_LABEL_LENGTH = 80;
const LAST_USED_WRITE_INTERVAL_MS = 60_000;

const normalizeLabel = (value: string | null | undefined) => {
  if (value == null) return 'Remote client';
  const trimmed = value.trim();
  if (!trimmed) return 'Remote client';
  return trimmed.length > MAX_LABEL_LENGTH ? trimmed.slice(0, MAX_LABEL_LENGTH) : trimmed;
};

const normalizeTimestamp = (value: string | null | undefined) => {
  if (value == null) return null;
  const trimmed = value.trim();
  if (!trimmed) return null;
  const time = Date.parse(trimmed);
  return Number.isFinite(time) ? new Date(time).toISOString() : null;
};

const normalizeOptionalString = (value: string | null | undefined) => {
  if (value == null) return null;
  const trimmed = value.trim();
  return trimmed.length > 0 ? trimmed : null;
};

const normalizeMetadata = (client: ClientInput) => ({
  authMethod: normalizeOptionalString(isString(client.authMethod) ? client.authMethod : null),
  pairingId: normalizeOptionalString(isString(client.pairingId) ? client.pairingId : null),
  deviceName: normalizeOptionalString(isString(client.deviceName) ? client.deviceName : null),
  devicePlatform: normalizeOptionalString(isString(client.devicePlatform) ? client.devicePlatform : null),
  deviceModel: normalizeOptionalString(isString(client.deviceModel) ? client.deviceModel : null),
  appVersion: normalizeOptionalString(isString(client.appVersion) ? client.appVersion : null),
});

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

export const isActiveClient = (client: Pick<RemoteClient, 'revokedAt' | 'expiresAt'>, now = Date.now()) => {
  if (client.revokedAt) return false;
  const expires = Date.parse(client.expiresAt || '');
  return !Number.isFinite(expires) || expires > now;
};

export const createRemoteClientAuthRuntime = ({ fsPromises, path, crypto, storePath }: StoreDependencies) => {
  const hashToken = (token: string) => crypto.createHash('sha256').update(token).digest('hex');
  const nowIso = () => new Date().toISOString();
  const generateId = () => crypto.randomBytes(12).toString('hex');
  const generateToken = () => `${TOKEN_PREFIX}${crypto.randomBytes(TOKEN_BYTES).toString('base64url')}`;
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

  const normalizeStore = (payload: ReturnType<typeof safeJsonParse>): ClientStore => ({
    version: STORE_VERSION,
    clients: isInputArray(payload?.clients)
      ? payload.clients
        .filter(isStoredInput)
        .map((client: StoredInput): StoredClient => ({
          id: isString(client.id) ? client.id : generateId(),
          label: normalizeLabel(isString(client.label) ? client.label : null),
          tokenHash: isString(client.tokenHash) ? client.tokenHash : '',
          createdAt: isString(client.createdAt) ? client.createdAt : nowIso(),
          lastUsedAt: isString(client.lastUsedAt) ? client.lastUsedAt : null,
          revokedAt: isString(client.revokedAt) ? client.revokedAt : null,
          expiresAt: normalizeTimestamp(isString(client.expiresAt) ? client.expiresAt : null),
          clientKind: normalizeOptionalString(isString(client.clientKind) ? client.clientKind : null),
          dedupeKey: normalizeOptionalString(isString(client.dedupeKey) ? client.dedupeKey : null),
          usesRelay: client.usesRelay === true,
          localOnly: client.localOnly === true,
          lastTransport: client.lastTransport === 'relay' || client.lastTransport === 'direct' ? client.lastTransport : null,
          ...normalizeMetadata(client),
        }))
        .filter((client) => client.tokenHash.length > 0)
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

  const writeStore = async (store: ClientStore) => {
    await fsPromises.mkdir(path.dirname(storePath), { recursive: true, mode: 0o700 });
    await fsPromises.writeFile(storePath, JSON.stringify(normalizeStore(store), null, 2), { mode: 0o600 });
    if (hasChmod(fsPromises)) {
      await fsPromises.chmod(storePath, 0o600).catch(() => {});
    }
  };

  const publicClient = (client: StoredClient): RemoteClient => ({
    id: client.id,
    label: client.label,
    createdAt: client.createdAt,
    lastUsedAt: client.lastUsedAt,
    revokedAt: client.revokedAt,
    expiresAt: client.expiresAt,
    clientKind: client.clientKind,
    authMethod: client.authMethod,
    pairingId: client.pairingId,
    deviceName: client.deviceName,
    devicePlatform: client.devicePlatform,
    deviceModel: client.deviceModel,
    appVersion: client.appVersion,
    usesRelay: client.usesRelay === true,
    localOnly: client.localOnly === true,
    lastTransport: client.lastTransport ?? null,
  });

  const listClients = async () => {
    return withStoreMutation(async () => {
      const store = await readStore();
      return store.clients.map(publicClient);
    });
  };

  const hasActiveRelayClients = async () => {
    return withStoreMutation(async () => {
      const store = await readStore();
      return store.clients.some((client) =>
        (client.usesRelay === true || client.lastTransport === 'relay') && isActiveClient(client));
    });
  };

  const createClient = async ({
    label,
    fallbackLabel,
    expiresAt,
    clientKind,
    dedupeKey,
    authMethod,
    pairingId,
    deviceName,
    devicePlatform,
    deviceModel,
    appVersion,
    usesRelay,
    localOnly,
  }: ClientInput = {}): Promise<CreatedClient> => {
    return withStoreMutation(async () => {
      const store = await readStore();
      const normalizedDedupeKey = normalizeOptionalString(isString(dedupeKey) ? dedupeKey : null);
      const token = generateToken();
      const existing = normalizedDedupeKey
        ? store.clients.find((entry) => entry.dedupeKey === normalizedDedupeKey)
        : null;
      const client: StoredClient = {
        id: generateId(),
        label: normalizeLabel(normalizeOptionalString(isString(label) ? label : null) || existing?.label || (isString(fallbackLabel) ? fallbackLabel : null)),
        tokenHash: hashToken(token),
        createdAt: nowIso(),
        lastUsedAt: null,
        revokedAt: null,
        expiresAt: normalizeTimestamp(isString(expiresAt) ? expiresAt : null),
        clientKind: normalizeOptionalString(isString(clientKind) ? clientKind : null),
        dedupeKey: normalizedDedupeKey,
        ...normalizeMetadata({ authMethod, pairingId, deviceName, devicePlatform, deviceModel, appVersion }),
        usesRelay: usesRelay === true,
        localOnly: localOnly === true,
      };
      const previousClients = store.clients;
      if (normalizedDedupeKey) {
        store.clients = store.clients.filter((entry) => entry.dedupeKey !== normalizedDedupeKey);
        if (client.clientKind) {
          store.clients = store.clients.filter((entry) =>
            !(entry.label === client.label && !entry.clientKind && !entry.dedupeKey));
        }
      }
      const replacedClientIds = previousClients.filter((entry) => !store.clients.includes(entry)).map((entry) => entry.id);
      store.clients.push(client);
      await writeStore(store);
      return { client: publicClient(client), token, replacedClientIds };
    });
  };

  const revokeClient = async (id: string | null | undefined) => {
    if (!isString(id) || id.trim().length === 0) {
      return { revoked: false };
    }
    return withStoreMutation(async () => {
      const store = await readStore();
      const client = store.clients.find((entry) => entry.id === id);
      if (!client) return { revoked: false };
      if (!client.revokedAt) client.revokedAt = nowIso();
      await writeStore(store);
      return { revoked: true, client: publicClient(client) };
    });
  };

  const purgeRevokedClients = async () => {
    return withStoreMutation(async () => {
      const store = await readStore();
      const before = store.clients.length;
      store.clients = store.clients.filter((entry) => !entry.revokedAt);
      const purged = before - store.clients.length;
      if (purged > 0) {
        await writeStore(store);
      }
      return { purged };
    });
  };

  const authenticateBearerToken = async (token: string | null | undefined, req?: BearerRequest) => {
    if (!isString(token) || !token.startsWith(TOKEN_PREFIX)) {
      return null;
    }
    const transport = hasRelayProvenance(req) ? 'relay' : 'direct';
    return withStoreMutation(async () => {
      const tokenHash = hashToken(token);
      const store = await readStore();
      const client = store.clients.find((entry) => !entry.revokedAt && constantTimeEqual(entry.tokenHash, tokenHash, crypto));
      if (!client) return null;
      if (client.expiresAt && Date.parse(client.expiresAt) <= Date.now()) return null;
      const now = Date.now();
      const lastUsedAt = Date.parse(client.lastUsedAt || '');
      const healUsesRelay = transport === 'relay' && (client.usesRelay !== true || client.localOnly === true);
      if (healUsesRelay) {
        client.usesRelay = true;
        client.localOnly = false;
      }
      if (healUsesRelay || !Number.isFinite(lastUsedAt) || now - lastUsedAt >= LAST_USED_WRITE_INTERVAL_MS || client.lastTransport !== transport) {
        client.lastUsedAt = new Date(now).toISOString();
        client.lastTransport = transport;
        await writeStore(store);
      }
      return { ok: true, clientId: client.id, sessionToken: client.id, client: publicClient(client) };
    });
  };

  return {
    authenticateBearerToken,
    createClient,
    listClients,
    hasActiveRelayClients,
    purgeRevokedClients,
    revokeClient,
  };
};
