import fsSync from 'node:fs';
import fs from 'node:fs/promises';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import { z } from 'zod';

import { GUEST_CAPABILITIES } from '@openchamber/sdk';

const GUEST_SOURCES = ['path', 'zip', 'git'];

const storeSchema = z.object({
  paths: z.array(z.string().min(1).refine((entry) => !entry.includes('\0'))),
  sources: z.record(z.string(), z.enum(GUEST_SOURCES)).optional(),
  gitOrigins: z.record(z.string(), z.unknown()).optional(),
  capabilityGrants: z.record(z.string(), z.array(z.string())).optional(),
  capabilityScopes: z.record(z.string(), z.unknown()).optional(),
  disabledGuests: z.record(z.string(), z.literal(true)).optional(),
  serviceSocketOverrides: z.record(
    z.string(),
    z.record(z.string(), z.string().min(1).refine((entry) => !entry.includes('\0'))),
  ).optional(),
  storageIds: z.record(z.string(), z.unknown()).optional(),
});

const capabilityScopeSchema = z.object({
  filesystem: z.array(z.string().min(1)).optional(),
  origins: z.array(z.string().min(1)).optional(),
  wake: z.array(z.string().min(1)).optional(),
  apiOrigin: z.string().min(1).optional(),
  oauth: z.object({
    authorizeUrl: z.string().min(1),
    tokenUrl: z.string().min(1),
  }).optional(),
  service: z.object({
    exec: z.array(z.string().min(1)),
    sockets: z.array(z.string().min(1)),
    sourceControl: z.object({
      defaultInstances: z.array(z.string().min(1)),
      custom: z.boolean(),
    }).optional(),
    sessionEvents: z.object({
      events: z.array(z.string().min(1)),
      content: z.boolean(),
    }).optional(),
    keepRunning: z.literal(true).optional(),
    schedule: z.array(z.string().min(1)).optional(),
    mentions: z.literal(true).optional(),
    sessionControl: z.object({ content: z.boolean() }).optional(),
    notifications: z.union([
      z.object({ kind: z.literal('fixed'), origin: z.string().min(1) }),
      z.object({ kind: z.literal('user') }),
    ]).optional(),
    tracker: z.object({
      instances: z.union([
        z.object({ kind: z.literal('fixed'), origin: z.string().min(1) }),
        z.object({ kind: z.literal('user') }),
      ]),
      oauth: z.object({ authorizeUrl: z.string().min(1), tokenUrl: z.string().min(1) }).nullable(),
      urls: z.array(z.string().min(1)),
    }).optional(),
    quota: z.object({
      providers: z.array(z.string().min(1)),
    }).optional(),
  }).optional(),
  links: z.object({
    action: z.string().min(1),
    keys: z.array(z.string().min(1)),
    origin: z.string().min(1).nullable(),
    identifier: z.string().min(1).nullable(),
    urls: z.array(z.string().min(1)),
  }).optional(),
});

/** @returns {Record<string, { filesystem?: string[], apiOrigin?: string, service?: { exec: string[], sockets: string[], sourceControl?: { defaultInstances: string[], custom: boolean }, sessionEvents?: { events: string[], content: boolean } } }>} */
const knownScopesOnly = (scopes) => {
  const cleaned = {};
  for (const [guestId, raw] of Object.entries(scopes)) {
    const parsed = capabilityScopeSchema.safeParse(raw);
    if (parsed.success) {
      cleaned[guestId] = parsed.data;
    }
  }
  return cleaned;
};

const gitOriginSchema = z.object({
  url: z.string().min(1).refine((entry) => !entry.includes('\0')),
  ref: z.string().min(1).max(256).refine((entry) => !entry.includes('\0')).optional(),
  gitIdentityId: z.string().trim().min(1).max(128).optional(),
});

/** @returns {Record<string, { url: string, ref?: string, gitIdentityId?: string }>} */
const knownGitOriginsOnly = (origins) => {
  /** @type {Record<string, { url: string, ref?: string, gitIdentityId?: string }>} */
  const cleaned = {};
  for (const [installPath, raw] of Object.entries(origins)) {
    const parsed = gitOriginSchema.safeParse(raw);
    if (!parsed.success) {
      continue;
    }
    cleaned[installPath] = parsed.data;
  }
  return cleaned;
};

const knownStorageIdsOnly = (storageIds) => Object.fromEntries(
  Object.entries(storageIds).filter(([, storageId]) => z.string().uuid().safeParse(storageId).success),
);

const parseStore = (raw) => {
  try {
    const parsed = storeSchema.safeParse(JSON.parse(raw));
    return parsed.success ? parsed.data : null;
  } catch {
    return null;
  }
};

const dataDirSchema = z.string().min(1).refine((entry) => !entry.includes('\0') && path.isAbsolute(entry));

export const extensionsPersistPath = (dataDir) => {
  const parsed = dataDirSchema.safeParse(dataDir);
  if (!parsed.success) {
    throw new Error('Guest persist needs an absolute OpenChamber data dir');
  }
  return path.join(parsed.data, 'extensions.json');
};

export const guestCopiesDir = (persistPath) => path.join(path.dirname(persistPath), 'extensions');

const realOrResolved = (value) => {
  try {
    return fsSync.realpathSync(value);
  } catch {
    return path.resolve(value);
  }
};

export const isCopiedGuestRoot = (root, persistPath) => {
  const copies = realOrResolved(guestCopiesDir(persistPath));
  const resolved = realOrResolved(root);
  return resolved === copies || resolved.startsWith(`${copies}${path.sep}`);
};

const emptyStore = () => ({
  paths: [],
  sources: {},
  gitOrigins: {},
  capabilityGrants: {},
  capabilityScopes: {},
  disabledGuests: {},
  serviceSocketOverrides: {},
});

const knownCapabilities = new Set(GUEST_CAPABILITIES);

const knownGrantsOnly = (grants) => Object.fromEntries(
  Object.entries(grants).map(([guestId, list]) => [guestId, list.filter((capability) => knownCapabilities.has(capability))]),
);

export const readExtensionStore = async (persistPath) => {
  try {
    const raw = await fs.readFile(persistPath, 'utf8');
    const parsed = parseStore(raw);
    if (!parsed) {
      throw new Error('Invalid extensions store');
    }
    const store = {
      paths: parsed.paths,
      sources: parsed.sources ?? {},
      gitOrigins: knownGitOriginsOnly(parsed.gitOrigins ?? {}),
      capabilityGrants: knownGrantsOnly(parsed.capabilityGrants ?? {}),
      capabilityScopes: knownScopesOnly(parsed.capabilityScopes ?? {}),
      disabledGuests: parsed.disabledGuests ?? {},
      serviceSocketOverrides: parsed.serviceSocketOverrides ?? {},
    };
    if (parsed.storageIds) store.storageIds = knownStorageIdsOnly(parsed.storageIds);
    return store;
  } catch (error) {
    if (error instanceof Error && 'code' in error && error.code === 'ENOENT') {
      return emptyStore();
    }
    throw error;
  }
};

const writeExtensionStoreUnlocked = async (
  persistPath,
  {
    paths,
    sources = {},
    gitOrigins = {},
    capabilityGrants = {},
    capabilityScopes = {},
    disabledGuests = {},
    serviceSocketOverrides = {},
    storageIds = {},
  },
) => {
  const cleaned = {};
  /** @type {Record<string, { url: string, ref?: string }>} */
  const origins = {};
  for (const entry of paths) {
    const source = sources[entry];
    if (source && source !== 'path') {
      cleaned[entry] = source;
    }
    const origin = source === 'git' ? gitOrigins[entry] : undefined;
    const parsedOrigin = gitOriginSchema.safeParse(origin);
    if (parsedOrigin.success) {
      origins[entry] = parsedOrigin.data;
    }
  }
  const grants = {};
  for (const [id, granted] of Object.entries(capabilityGrants)) {
    if (Array.isArray(granted) && granted.length > 0) {
      grants[id] = [...granted];
    }
  }
  const scopes = {};
  for (const [id, scope] of Object.entries(capabilityScopes)) {
    if (grants[id] && capabilityScopeSchema.safeParse(scope).success) {
      scopes[id] = scope;
    }
  }
  const disabled = {};
  for (const [id, isDisabled] of Object.entries(disabledGuests)) {
    if (isDisabled) {
      disabled[id] = true;
    }
  }
  /** @type {Record<string, Record<string, string>>} */
  const socketOverrides = {};
  for (const [guestId, bySocket] of Object.entries(serviceSocketOverrides)) {
    /** @type {Record<string, string>} */
    const cleanedSockets = {};
    for (const [socketId, socketPath] of Object.entries(bySocket ?? {})) {
      if (typeof socketPath === 'string' && socketPath.trim() && !socketPath.includes('\0')) {
        cleanedSockets[socketId] = socketPath.trim();
      }
    }
    if (Object.keys(cleanedSockets).length > 0) {
      socketOverrides[guestId] = cleanedSockets;
    }
  }
  const payload = { paths };
  if (Object.keys(cleaned).length > 0) {
    payload.sources = cleaned;
  }
  if (Object.keys(origins).length > 0) {
    payload.gitOrigins = origins;
  }
  if (Object.keys(grants).length > 0) {
    payload.capabilityGrants = grants;
  }
  if (Object.keys(scopes).length > 0) {
    payload.capabilityScopes = scopes;
  }
  if (Object.keys(disabled).length > 0) {
    payload.disabledGuests = disabled;
  }
  if (Object.keys(socketOverrides).length > 0) {
    payload.serviceSocketOverrides = socketOverrides;
  }
  const identities = {};
  for (const [guestId, storageId] of Object.entries(storageIds)) {
    const parsedIdentity = z.string().uuid().safeParse(storageId);
    if (parsedIdentity.success) identities[guestId] = parsedIdentity.data;
  }
  if (Object.keys(identities).length > 0) payload.storageIds = identities;
  for (const listener of writeListeners) listener(persistPath);
  await fs.mkdir(path.dirname(persistPath), { recursive: true });
  const tmp = `${persistPath}.tmp-${process.pid}-${Date.now()}-${(writeSequence += 1)}`;
  await fs.writeFile(tmp, `${JSON.stringify(payload, null, 2)}\n`, 'utf8');
  await fs.rename(tmp, persistPath);
  for (const listener of writeListeners) listener(persistPath);
};

export const writeExtensionStore = (persistPath, store) => (
  withStoreWriteLock(persistPath, () => writeExtensionStoreUnlocked(persistPath, store))
);

/**
 * Read, change, and write the store as one step under the write lock, so two
 * changes made at the same time (Allow in one window, Pause in another) both
 * land instead of the second one writing over a stale copy of the first.
 * `mutate` returns the next store, or `null` to leave the file alone.
 * @param {string} persistPath
 * @param {(current: Awaited<ReturnType<typeof readExtensionStore>>) => Promise<object | null> | object | null} mutate
 */
export const updateExtensionStore = (persistPath, mutate) => (
  withStoreWriteLock(persistPath, async () => {
    const current = await readExtensionStore(persistPath);
    const next = await mutate(current);
    if (next) {
      await writeExtensionStoreUnlocked(persistPath, next);
    }
  })
);

export const ensureGuestStorageIds = async (persistPath, descriptors) => {
  const resolved = {};
  await updateExtensionStore(persistPath, (current) => {
    const storageIds = { ...current.storageIds };
    let changed = false;
    for (const { id, storedPath, builtIn } of descriptors) {
      if (!builtIn && (storedPath === null || !current.paths.includes(storedPath))) continue;
      if (!storageIds[id]) {
        storageIds[id] = randomUUID();
        changed = true;
      }
      resolved[id] = storageIds[id];
    }
    return changed ? { ...current, storageIds } : null;
  });
  return resolved;
};

let writeSequence = 0;
/** @type {Set<(persistPath: string) => void>} */
const writeListeners = new Set();

export const onExtensionStoreWrite = (listener) => {
  writeListeners.add(listener);
  return () => writeListeners.delete(listener);
};
/** @type {Map<string, Promise<void>>} */
const writeChains = new Map();

const withStoreWriteLock = (persistPath, write) => {
  const previous = writeChains.get(persistPath) ?? Promise.resolve();
  const next = previous.catch(() => undefined).then(write);
  writeChains.set(persistPath, next.finally(() => {
    if (writeChains.get(persistPath) === chained) writeChains.delete(persistPath);
  }));
  const chained = writeChains.get(persistPath);
  return next;
};

export const readExtensionPaths = async (persistPath) => {
  const store = await readExtensionStore(persistPath);
  return store.paths;
};

export const writeExtensionPaths = (paths, persistPath) => updateExtensionStore(persistPath, (current) => {
  const sources = {};
  const gitOrigins = {};
  for (const entry of paths) {
    if (current.sources[entry]) {
      sources[entry] = current.sources[entry];
    }
    if (current.gitOrigins[entry]) {
      gitOrigins[entry] = current.gitOrigins[entry];
    }
  }
  return { ...current, paths, sources, gitOrigins };
});

/**
 * Record the user's approval for one guest. `granted` replaces the previous
 * list; an empty list withdraws approval. Callers pass the requested list
 * verbatim, so approval is all-or-nothing per install.
 * @param {string} guestId
 * @param {string} persistPath
 * @param {string[]} granted
 */
export const setCapabilityGrants = (guestId, persistPath, granted, scope = null) => updateExtensionStore(persistPath, (current) => {
  const capabilityGrants = { ...current.capabilityGrants };
  const capabilityScopes = { ...current.capabilityScopes };
  if (granted.length > 0) {
    capabilityGrants[guestId] = [...granted];
    if (scope) {
      capabilityScopes[guestId] = scope;
    } else {
      delete capabilityScopes[guestId];
    }
  } else {
    delete capabilityGrants[guestId];
    delete capabilityScopes[guestId];
  }
  return { ...current, capabilityGrants, capabilityScopes };
});
