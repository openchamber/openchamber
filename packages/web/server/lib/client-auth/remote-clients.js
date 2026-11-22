import {
  preserveMalformedJsonFile,
  readDurableJsonFile,
  writeDurableJsonFile,
} from '../shared/durable-json-store.js';

const STORE_VERSION = 1;
const TOKEN_PREFIX = 'oc_client_';
const TOKEN_BYTES = 32;
const MAX_LABEL_LENGTH = 80;
const LAST_USED_WRITE_INTERVAL_MS = 60_000;

// A plain slice at the cap can land between the halves of a surrogate pair,
// leaving a lone high surrogate that encodes as U+FFFD. On disk that becomes a
// literal \ud83d escape and the operator sees a corrupted device name on every
// surface that reads the store; move the cut back to the pair boundary.
const clipPairSafe = (text, limit) => {
  if (text.length <= limit) return text;
  const clipped = text.slice(0, limit);
  const last = clipped.charCodeAt(clipped.length - 1);
  return last >= 0xd800 && last <= 0xdbff ? clipped.slice(0, -1) : clipped;
};

const normalizeLabel = (value) => {
  if (typeof value !== 'string') return 'Remote client';
  const trimmed = value.trim();
  if (!trimmed) return 'Remote client';
  return clipPairSafe(trimmed, MAX_LABEL_LENGTH);
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

  // This store rides the shared durable-store primitive (design #976):
  // the strict reader judges the file, the preserve helper moves a
  // malformed file aside under the collision-proof preserve name, and
  // the writer is mode-explicit. A torn or otherwise unparseable file is
  // paired-device auth state, not an empty store: its bytes are
  // preserved before any later write can overwrite them, and the loss
  // stays recoverable. The value judgement stays the one this store
  // always made - any parsed JSON reaches normalizeStore, which
  // tolerates every shape - so only unparseable bytes are malformed
  // here. The preserve helper re-reads and re-judges the on-disk bytes
  // before renaming anything, so a valid replacement that landed in
  // the meantime is never moved aside (Codex, PR #890); a 'replaced'
  // outcome re-reads that valid file instead (bounded - repeated
  // replacement is a race no read should chase). A mutation must never
  // overwrite bytes whose preservation failed: they are the only copy
  // of the paired clients, so the read fails closed instead.
  const readStore = async (replacements = 0) => {
    const result = await readDurableJsonFile(storePath, { fs: fsPromises });
    if (result.state === 'valid') return normalizeStore(result.value);
    // The primitive collapses an absent file and an EXISTING empty or
    // whitespace-only file into the same 'missing' answer. Only the
    // absent file is the first-run case: empty bytes are unparseable,
    // and the pre-migration reader revalidated them before treating
    // the store as empty - another process sharing this file can
    // replace the empty bytes with valid state while this read is in
    // flight, and returning an empty store here would let a mutation
    // overwrite that replacement and drop its clients (Codex, PR
    // #1019). So a 'missing' verdict goes through the preserve helper
    // too: it re-reads and re-judges the on-disk bytes, answers
    // 'replaced' for a valid replacement (re-read below), 'missing'
    // for a truly absent file (the first-run return) or for
    // still-empty bytes (which hold no clients, so there is nothing
    // to preserve), and 'preserved' if the re-read bytes are malformed.
    const preservation = await preserveMalformedJsonFile(storePath, { fs: fsPromises });
    if (preservation.preserved) {
      console.warn(`Failed to read remote clients store: preserved the unreadable file at ${preservation.preservedPath}`);
      return normalizeStore(null);
    }
    if (preservation.outcome === 'missing') return normalizeStore(null);
    if (preservation.outcome === 'replaced' && replacements < 3) {
      return readStore(replacements + 1);
    }
    throw new Error('Failed to preserve the unreadable remote clients store; refusing to overwrite it');
  };

  const writeStore = async (store) => {
    // The directory mode stays stated here: the primitive's writer
    // creates the directory without a mode, and this store has always
    // made its directory 0o700. The file itself is written by the
    // primitive with its mode stated (0o600 - the store holds token
    // hashes), and the chmod keeps the mode true even when the rename
    // landed over an existing file with wider permissions.
    await fsPromises.mkdir(path.dirname(storePath), { recursive: true, mode: 0o700 });
    await writeDurableJsonFile(storePath, JSON.stringify(normalizeStore(store), null, 2), { fs: fsPromises, mode: 0o600 });
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
  // client that was paired over the relay OR was actually observed connecting
  // through the relay tunnel (lastTransport). The observed transport is the
  // authoritative signal — it covers records written before usesRelay existed
  // and devices re-paired via a QR that carried no relay candidate.
  const hasActiveRelayClients = async () => {
    return withStoreMutation(async () => {
      const store = await readStore();
      const now = Date.now();
      return store.clients.some((client) => {
        if (client.usesRelay !== true && client.lastTransport !== 'relay') return false;
        if (client.revokedAt) return false;
        const expires = Date.parse(client.expiresAt || '');
        return !Number.isFinite(expires) || expires > now;
      });
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
  } = {}) => {
    return withStoreMutation(async () => {
      const store = await readStore();
      const normalizedDedupeKey = normalizeOptionalString(dedupeKey);
      const token = generateToken();
      // A dedupe-keyed mint REPLACES the previous record for the same device,
      // so an operator-visible name must survive the replacement: an explicit
      // label wins, otherwise the replaced record's label is kept, and only a
      // first-ever mint falls back to the client-reported default.
      const existing = normalizedDedupeKey
        ? store.clients.find((entry) => entry.dedupeKey === normalizedDedupeKey)
        : null;
      const client = {
        id: generateId(),
        label: normalizeLabel(normalizeOptionalString(label) || existing?.label || fallbackLabel),
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
    // direct (local/LAN/tunnel-URL) request. Feeds device display AND relay
    // demand (hasActiveRelayClients), so a relay request must never be
    // misclassified as direct.
    const transport = req?.headers?.['x-openchamber-relay-connection'] ? 'relay' : 'direct';
    return withStoreMutation(async () => {
      const tokenHash = hashToken(token);
      const store = await readStore();
      const client = store.clients.find((entry) => !entry.revokedAt && constantTimeEqual(entry.tokenHash, tokenHash, crypto));
      if (!client) return null;
      if (client.expiresAt && Date.parse(client.expiresAt) <= Date.now()) return null;
      const now = Date.now();
      const lastUsedAt = Date.parse(client.lastUsedAt || '');
      // Self-heal the paired-over-relay flag from the authoritative signal: a
      // request that arrived through the tunnel proves this device uses the
      // relay, regardless of what the pairing-time snapshot recorded. Sticky on
      // purpose — a later LAN request must not turn the relay host off again.
      const healUsesRelay = transport === 'relay' && client.usesRelay !== true;
      if (healUsesRelay) client.usesRelay = true;
      // Write on the throttle interval — or immediately when the transport
      // changed, so a LAN⇄relay switch is visible right away, not a minute late.
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
