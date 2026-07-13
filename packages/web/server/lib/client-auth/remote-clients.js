const STORE_VERSION = 1;
const TOKEN_PREFIX = 'oc_client_';
const TOKEN_BYTES = 32;
const MAX_LABEL_LENGTH = 80;
const LAST_USED_WRITE_INTERVAL_MS = 60_000;

const normalizeLabel = (value) => {
  if (typeof value !== 'string') return 'Remote client';
  const trimmed = value.trim();
  if (!trimmed) return 'Remote client';
  return trimmed.length > MAX_LABEL_LENGTH ? trimmed.slice(0, MAX_LABEL_LENGTH) : trimmed;
};

const normalizeTimestamp = (value) => {
  if (typeof value !== 'string') return null;
  const trimmed = value.trim();
  if (!trimmed) return null;
  const time = Date.parse(trimmed);
  return Number.isFinite(time) ? new Date(time).toISOString() : null;
};

const normalizeOptionalString = (value) => {
  if (typeof value !== 'string') return null;
  const trimmed = value.trim();
  return trimmed.length > 0 ? trimmed : null;
};

const normalizeMetadata = (client) => ({
  authMethod: normalizeOptionalString(client.authMethod),
  pairingId: normalizeOptionalString(client.pairingId),
  deviceName: normalizeOptionalString(client.deviceName),
  devicePlatform: normalizeOptionalString(client.devicePlatform),
  deviceModel: normalizeOptionalString(client.deviceModel),
  appVersion: normalizeOptionalString(client.appVersion),
});

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

export const createRemoteClientAuthRuntime = ({ fsPromises, path, crypto, storePath }) => {
  const hashToken = (token) => crypto.createHash('sha256').update(token).digest('hex');
  const nowIso = () => new Date().toISOString();
  const generateId = () => crypto.randomBytes(12).toString('hex');
  const generateToken = () => `${TOKEN_PREFIX}${crypto.randomBytes(TOKEN_BYTES).toString('base64url')}`;
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
    clients: Array.isArray(payload?.clients)
      ? payload.clients
        .filter((client) => client && typeof client === 'object')
        .map((client) => ({
          id: typeof client.id === 'string' ? client.id : generateId(),
          label: normalizeLabel(client.label),
          tokenHash: typeof client.tokenHash === 'string' ? client.tokenHash : '',
          createdAt: typeof client.createdAt === 'string' ? client.createdAt : nowIso(),
          lastUsedAt: typeof client.lastUsedAt === 'string' ? client.lastUsedAt : null,
          revokedAt: typeof client.revokedAt === 'string' ? client.revokedAt : null,
          expiresAt: normalizeTimestamp(client.expiresAt),
          clientKind: normalizeOptionalString(client.clientKind),
          dedupeKey: normalizeOptionalString(client.dedupeKey),
          usesRelay: client.usesRelay === true,
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

  const publicClient = (client) => ({
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
    lastTransport: client.lastTransport ?? null,
  });

  const listClients = async () => {
    return withStoreMutation(async () => {
      const store = await readStore();
      return store.clients.map(publicClient);
    });
  };

  // Relay-transport demand from paired devices: any non-revoked, non-expired
  // client that was paired over the relay.
  const hasActiveRelayClients = async () => {
    return withStoreMutation(async () => {
      const store = await readStore();
      const now = Date.now();
      return store.clients.some((client) => {
        if (client.usesRelay !== true) return false;
        if (client.revokedAt) return false;
        const expires = Date.parse(client.expiresAt || '');
        return !Number.isFinite(expires) || expires > now;
      });
    });
  };

  const createClient = async ({
    label,
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
  } = {}) => {
    return withStoreMutation(async () => {
      const store = await readStore();
      const normalizedDedupeKey = normalizeOptionalString(dedupeKey);
      const token = generateToken();
      const client = {
        id: generateId(),
        label: normalizeLabel(label),
        tokenHash: hashToken(token),
        createdAt: nowIso(),
        lastUsedAt: null,
        revokedAt: null,
        expiresAt: normalizeTimestamp(expiresAt),
        clientKind: normalizeOptionalString(clientKind),
        dedupeKey: normalizedDedupeKey,
        authMethod: normalizeOptionalString(authMethod),
        pairingId: normalizeOptionalString(pairingId),
        deviceName: normalizeOptionalString(deviceName),
        devicePlatform: normalizeOptionalString(devicePlatform),
        deviceModel: normalizeOptionalString(deviceModel),
        appVersion: normalizeOptionalString(appVersion),
        usesRelay: usesRelay === true,
      };
      if (normalizedDedupeKey) {
        store.clients = store.clients.filter((entry) => entry.dedupeKey !== normalizedDedupeKey);
        // Migrate pre-clientKind desktop tokens: a deduped, kind-tagged mint
        // supersedes legacy records with the same label that carry neither a
        // kind nor a dedupe key — those tokens can no longer pass the
        // desktop-local client-create gate and would otherwise linger forever.
        if (client.clientKind) {
          store.clients = store.clients.filter((entry) =>
            !(entry.label === client.label && !entry.clientKind && !entry.dedupeKey));
        }
      }
      store.clients.push(client);
      await writeStore(store);
      return { client: publicClient(client), token };
    });
  };

  const revokeClient = async (id) => {
    if (typeof id !== 'string' || id.trim().length === 0) {
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

  const authenticateBearerToken = async (token, req) => {
    if (typeof token !== 'string' || !token.startsWith(TOKEN_PREFIX)) {
      return null;
    }
    // Which transport carried this request: the relay tunnel proxy stamps every
    // forwarded request with x-openchamber-relay-connection; anything else is a
    // direct (local/LAN/tunnel-URL) request. Display-only device metadata.
    const transport = req?.headers?.['x-openchamber-relay-connection'] ? 'relay' : 'direct';
    return withStoreMutation(async () => {
      const tokenHash = hashToken(token);
      const store = await readStore();
      const client = store.clients.find((entry) => !entry.revokedAt && constantTimeEqual(entry.tokenHash, tokenHash, crypto));
      if (!client) return null;
      if (client.expiresAt && Date.parse(client.expiresAt) <= Date.now()) return null;
      const now = Date.now();
      const lastUsedAt = Date.parse(client.lastUsedAt || '');
      // Write on the throttle interval — or immediately when the transport
      // changed, so a LAN⇄relay switch is visible right away, not a minute late.
      if (!Number.isFinite(lastUsedAt) || now - lastUsedAt >= LAST_USED_WRITE_INTERVAL_MS || client.lastTransport !== transport) {
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
