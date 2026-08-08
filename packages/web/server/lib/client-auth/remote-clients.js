const STORE_VERSION = 2;
const TOKEN_PREFIX = 'oc_client_';
const TOKEN_BYTES = 32;
const MAX_LABEL_LENGTH = 80;
const LAST_USED_WRITE_INTERVAL_MS = 60_000;
const REMOTE_CLIENT_CAPABILITIES = Object.freeze([
  'workspace.read',
  'workspace.use',
  'workspace.admin',
  'host.apply',
]);
const REMOTE_CLIENT_CAPABILITY_SET = new Set(REMOTE_CLIENT_CAPABILITIES);
const DEFAULT_REMOTE_CLIENT_CAPABILITIES = Object.freeze(['workspace.read', 'workspace.use']);
const DESKTOP_LOCAL_DEDUPE_KEY = 'desktop-local';

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

const hasNativeDesktopMarkers = (client) =>
  client?.clientKind === 'desktop-local' && client?.authMethod === 'native-electron';

const normalizeCapabilities = (value, client = {}, nativeAttested = false) => {
  if (nativeAttested && hasNativeDesktopMarkers(client)) {
    return [...REMOTE_CLIENT_CAPABILITIES];
  }
  if (client.clientKind === 'desktop-local') {
    return [...DEFAULT_REMOTE_CLIENT_CAPABILITIES];
  }
  if (!Array.isArray(value)) {
    return [...DEFAULT_REMOTE_CLIENT_CAPABILITIES];
  }
  return Array.from(new Set(value.filter((capability) => REMOTE_CLIENT_CAPABILITY_SET.has(capability))));
};

const normalizeClientKind = (client, nativeAttested = false) => {
  const clientKind = normalizeOptionalString(client.clientKind);
  if (clientKind === 'desktop-local' && (!nativeAttested || normalizeOptionalString(client.authMethod) !== 'native-electron')) return null;
  return clientKind;
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
  const nativeDesktopClientIds = new Set();
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
        .map((client) => {
          const nativeAttested = typeof client.id === 'string' && nativeDesktopClientIds.has(client.id);
          const normalizedIdentity = {
            clientKind: normalizeOptionalString(client.clientKind),
            authMethod: normalizeOptionalString(client.authMethod),
          };
          const clientKind = normalizeClientKind(normalizedIdentity, nativeAttested);
          return ({
            id: typeof client.id === 'string' ? client.id : generateId(),
            label: normalizeLabel(client.label),
            tokenHash: typeof client.tokenHash === 'string' ? client.tokenHash : '',
            createdAt: typeof client.createdAt === 'string' ? client.createdAt : nowIso(),
            lastUsedAt: typeof client.lastUsedAt === 'string' ? client.lastUsedAt : null,
            revokedAt: typeof client.revokedAt === 'string' ? client.revokedAt : null,
            expiresAt: normalizeTimestamp(client.expiresAt),
            clientKind,
            capabilities: normalizeCapabilities(client.capabilities, normalizedIdentity, nativeAttested),
            dedupeKey: normalizeOptionalString(client.dedupeKey),
            usesRelay: client.usesRelay === true,
            lastTransport: client.lastTransport === 'relay' || client.lastTransport === 'direct' ? client.lastTransport : null,
            ...normalizeMetadata(client),
          });
        })
        .filter((client) => client.tokenHash.length > 0)
      : [],
  });

  const readStore = async () => {
    try {
      const raw = await fsPromises.readFile(storePath, 'utf8');
      let payload;
      try {
        payload = JSON.parse(raw);
      } catch {
        const error = new Error('Remote client credential store is corrupt');
        error.code = 'CLIENT_STORE_CORRUPT';
        throw error;
      }
      if (!payload || typeof payload !== 'object' || Array.isArray(payload)) {
        const error = new Error('Remote client credential store is corrupt');
        error.code = 'CLIENT_STORE_CORRUPT';
        throw error;
      }
      const supportedVersion = payload.version === 1 || payload.version === STORE_VERSION;
      const clientsValid = Array.isArray(payload.clients)
        && payload.clients.every((client) => client && typeof client === 'object' && !Array.isArray(client)
          && typeof client.id === 'string' && client.id.length > 0
          && typeof client.tokenHash === 'string' && /^[a-f0-9]{64}$/i.test(client.tokenHash));
      const ids = clientsValid ? payload.clients.map((client) => client.id) : [];
      const tokenHashes = clientsValid ? payload.clients.map((client) => client.tokenHash.toLowerCase()) : [];
      if (!supportedVersion || !clientsValid || new Set(ids).size !== ids.length || new Set(tokenHashes).size !== tokenHashes.length) {
        const error = new Error('Remote client credential store is corrupt');
        error.code = 'CLIENT_STORE_CORRUPT';
        throw error;
      }
      const normalized = normalizeStore(payload);
      if (JSON.stringify(payload) !== JSON.stringify(normalized)) {
        await writeStore(normalized);
      }
      return normalized;
    } catch (error) {
      if (error?.code === 'ENOENT') return normalizeStore(null);
      throw error;
    }
  };

  const writeStore = async (store) => {
    const directory = path.dirname(storePath);
    const temporaryPath = `${storePath}.tmp-${process.pid}-${crypto.randomBytes(6).toString('hex')}`;
    await fsPromises.mkdir(directory, { recursive: true, mode: 0o700 });
    let handle;
    try {
      handle = await fsPromises.open(temporaryPath, 'wx', 0o600);
      await handle.writeFile(JSON.stringify(normalizeStore(store), null, 2), 'utf8');
      await handle.sync();
      await handle.close();
      handle = null;
      await fsPromises.rename(temporaryPath, storePath);
      if (typeof fsPromises.chmod === 'function') await fsPromises.chmod(storePath, 0o600);
      try {
        const directoryHandle = await fsPromises.open(directory, 'r');
        try { await directoryHandle.sync(); } finally { await directoryHandle.close(); }
      } catch {
        // Directory fsync is not supported by every platform/filesystem.
      }
    } catch (error) {
      if (handle) await handle.close().catch(() => {});
      await fsPromises.unlink(temporaryPath).catch(() => {});
      throw error;
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
    capabilities: [...client.capabilities],
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

  const createClientInternal = async ({
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
    capabilities,
  } = {}, nativeDesktopRequest = false) => {
    return withStoreMutation(async () => {
      const store = await readStore();
      const normalizedDedupeKey = normalizeOptionalString(dedupeKey);
      if (normalizedDedupeKey === DESKTOP_LOCAL_DEDUPE_KEY && !nativeDesktopRequest) {
        const error = new Error('Desktop local client identity is reserved');
        error.statusCode = 403;
        throw error;
      }
      const token = generateToken();
      const client = {
        id: generateId(),
        label: normalizeLabel(label),
        tokenHash: hashToken(token),
        createdAt: nowIso(),
        lastUsedAt: null,
        revokedAt: null,
        expiresAt: normalizeTimestamp(expiresAt),
        clientKind: normalizeClientKind({ clientKind, authMethod }, nativeDesktopRequest),
        dedupeKey: normalizedDedupeKey,
        authMethod: normalizeOptionalString(authMethod),
        pairingId: normalizeOptionalString(pairingId),
        deviceName: normalizeOptionalString(deviceName),
        devicePlatform: normalizeOptionalString(devicePlatform),
        deviceModel: normalizeOptionalString(deviceModel),
        appVersion: normalizeOptionalString(appVersion),
        usesRelay: usesRelay === true,
      };
      if (nativeDesktopRequest) nativeDesktopClientIds.add(client.id);
      client.capabilities = normalizeCapabilities(capabilities, { clientKind, authMethod }, nativeDesktopRequest);
      const replacedNativeClientIds = [];
      if (normalizedDedupeKey) {
        for (const entry of store.clients) {
          if (entry.dedupeKey === normalizedDedupeKey && nativeDesktopClientIds.has(entry.id)) replacedNativeClientIds.push(entry.id);
        }
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
      try {
        await writeStore(store);
        for (const id of replacedNativeClientIds) nativeDesktopClientIds.delete(id);
        return { client: publicClient(client), token };
      } catch (error) {
        nativeDesktopClientIds.delete(client.id);
        throw error;
      }
    });
  };

  const createClient = (input) => createClientInternal(input);
  const createNativeDesktopClient = (metadata = {}) => createClientInternal({
    ...metadata,
    clientKind: 'desktop-local',
    dedupeKey: DESKTOP_LOCAL_DEDUPE_KEY,
    authMethod: 'native-electron',
  }, true);

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

  const updateClientCapabilities = async (id, { grant = [], revoke = [] } = {}) => {
    if (typeof id !== 'string' || !id.trim()) return { updated: false };
    if (!Array.isArray(grant) || !Array.isArray(revoke)) {
      const error = new Error('Invalid remote client capability');
      error.statusCode = 400;
      throw error;
    }
    const invalid = [...grant, ...revoke].filter((capability) => !REMOTE_CLIENT_CAPABILITY_SET.has(capability));
    if (invalid.length > 0) {
      const error = new Error('Invalid remote client capability');
      error.statusCode = 400;
      throw error;
    }
    return withStoreMutation(async () => {
      const store = await readStore();
      const client = store.clients.find((entry) => entry.id === id);
      if (!client) return { updated: false };
      if (nativeDesktopClientIds.has(client.id) && hasNativeDesktopMarkers(client)) {
        const error = new Error('Native desktop client capabilities are immutable');
        error.statusCode = 409;
        throw error;
      }
      const capabilities = new Set(client.capabilities);
      for (const capability of grant) capabilities.add(capability);
      for (const capability of revoke) capabilities.delete(capability);
      client.capabilities = REMOTE_CLIENT_CAPABILITIES.filter((capability) => capabilities.has(capability));
      await writeStore(store);
      return { updated: true, client: publicClient(client) };
    });
  };

  const purgeRevokedClients = async () => {
    return withStoreMutation(async () => {
      const store = await readStore();
      const before = store.clients.length;
      const purgedNativeClientIds = store.clients
        .filter((entry) => entry.revokedAt && nativeDesktopClientIds.has(entry.id))
        .map((entry) => entry.id);
      store.clients = store.clients.filter((entry) => !entry.revokedAt);
      const purged = before - store.clients.length;
      if (purged > 0) {
        await writeStore(store);
        for (const id of purgedNativeClientIds) nativeDesktopClientIds.delete(id);
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

  const isNativeDesktopLocalClient = (client) =>
    typeof client?.id === 'string' && nativeDesktopClientIds.has(client.id) && hasNativeDesktopMarkers(client);

  return {
    authenticateBearerToken,
    createClient,
    createNativeDesktopClient,
    listClients,
    hasActiveRelayClients,
    isNativeDesktopLocalClient,
    purgeRevokedClients,
    revokeClient,
    updateClientCapabilities,
  };
};
