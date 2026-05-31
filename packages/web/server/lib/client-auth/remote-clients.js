const STORE_VERSION = 1;
const TOKEN_PREFIX = 'oc_client_';
const TOKEN_BYTES = 32;
const MAX_LABEL_LENGTH = 80;

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
    await fsPromises.mkdir(path.dirname(storePath), { recursive: true });
    await fsPromises.writeFile(storePath, JSON.stringify(normalizeStore(store), null, 2));
  };

  const publicClient = (client) => ({
    id: client.id,
    label: client.label,
    createdAt: client.createdAt,
    lastUsedAt: client.lastUsedAt,
    revokedAt: client.revokedAt,
    expiresAt: client.expiresAt,
  });

  const listClients = async () => {
    const store = await readStore();
    return store.clients.map(publicClient);
  };

  const createClient = async ({ label, expiresAt } = {}) => {
    const store = await readStore();
    const token = generateToken();
    const client = {
      id: generateId(),
      label: normalizeLabel(label),
      tokenHash: hashToken(token),
      createdAt: nowIso(),
      lastUsedAt: null,
      revokedAt: null,
      expiresAt: normalizeTimestamp(expiresAt),
    };
    store.clients.push(client);
    await writeStore(store);
    return { client: publicClient(client), token };
  };

  const revokeClient = async (id) => {
    if (typeof id !== 'string' || id.trim().length === 0) {
      return { revoked: false };
    }
    const store = await readStore();
    const client = store.clients.find((entry) => entry.id === id);
    if (!client) return { revoked: false };
    if (!client.revokedAt) client.revokedAt = nowIso();
    await writeStore(store);
    return { revoked: true, client: publicClient(client) };
  };

  const purgeRevokedClients = async () => {
    const store = await readStore();
    const before = store.clients.length;
    store.clients = store.clients.filter((entry) => !entry.revokedAt);
    const purged = before - store.clients.length;
    if (purged > 0) {
      await writeStore(store);
    }
    return { purged };
  };

  const authenticateBearerToken = async (token) => {
    if (typeof token !== 'string' || !token.startsWith(TOKEN_PREFIX)) {
      return null;
    }
    const tokenHash = hashToken(token);
    const store = await readStore();
    const client = store.clients.find((entry) => !entry.revokedAt && constantTimeEqual(entry.tokenHash, tokenHash, crypto));
    if (!client) return null;
    if (client.expiresAt && Date.parse(client.expiresAt) <= Date.now()) return null;
    client.lastUsedAt = nowIso();
    await writeStore(store);
    return { ok: true, clientId: client.id, sessionToken: client.id, client: publicClient(client) };
  };

  return {
    authenticateBearerToken,
    createClient,
    listClients,
    purgeRevokedClients,
    revokeClient,
  };
};
