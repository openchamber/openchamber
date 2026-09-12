import fsSync from 'node:fs';
import fs from 'node:fs/promises';
import path from 'node:path';
import { z } from 'zod';

import { GUEST_CAPABILITIES } from '@openchamber/sdk';

const GUEST_SOURCES = ['path', 'zip', 'git'];

const storeSchema = z.object({
  paths: z.array(z.string().min(1).refine((entry) => !entry.includes('\0'))),
  sources: z.record(z.string(), z.enum(GUEST_SOURCES)).optional(),
  // Where a git install came from, keyed by install path. Entries are checked
  // one at a time on read so a malformed one drops out instead of hiding the
  // whole catalog.
  gitOrigins: z.record(z.string(), z.unknown()).optional(),
  // Grants are stored as plain strings and filtered on read: a capability
  // that this build no longer knows (renamed, removed) must not invalidate the
  // whole store and hide every installed extension.
  capabilityGrants: z.record(z.string(), z.array(z.string())).optional(),
  disabledGuests: z.record(z.string(), z.literal(true)).optional(),
  serviceSocketOverrides: z.record(
    z.string(),
    z.record(z.string(), z.string().min(1).refine((entry) => !entry.includes('\0'))),
  ).optional(),
});

const gitOriginSchema = z.object({
  url: z.string().min(1).refine((entry) => !entry.includes('\0')),
  ref: z.string().min(1).max(256).refine((entry) => !entry.includes('\0')).optional(),
});

/** @returns {Record<string, { url: string, ref?: string }>} */
const knownGitOriginsOnly = (origins) => {
  /** @type {Record<string, { url: string, ref?: string }>} */
  const cleaned = {};
  for (const [installPath, raw] of Object.entries(origins)) {
    const parsed = gitOriginSchema.safeParse(raw);
    if (!parsed.success) {
      continue;
    }
    cleaned[installPath] = parsed.data.ref
      ? { url: parsed.data.url, ref: parsed.data.ref }
      : { url: parsed.data.url };
  }
  return cleaned;
};

const parseStore = (raw) => {
  try {
    const parsed = storeSchema.safeParse(JSON.parse(raw));
    return parsed.success ? parsed.data : null;
  } catch {
    return null;
  }
};

const dataDirSchema = z.string().min(1).refine((entry) => !entry.includes('\0') && path.isAbsolute(entry));

/** `{openchamberDataDir}/extensions.json`. One catalog per OpenChamber instance. */
export const extensionsPersistPath = (dataDir) => {
  const parsed = dataDirSchema.safeParse(dataDir);
  if (!parsed.success) {
    throw new Error('Guest persist needs an absolute OpenChamber data dir');
  }
  return path.join(parsed.data, 'extensions.json');
};

/** Host-owned zip/git copies. Lives next to `extensions.json` as `{dataDir}/extensions/{id}`. */
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
    return {
      paths: parsed.paths,
      sources: parsed.sources ?? {},
      gitOrigins: knownGitOriginsOnly(parsed.gitOrigins ?? {}),
      capabilityGrants: knownGrantsOnly(parsed.capabilityGrants ?? {}),
      disabledGuests: parsed.disabledGuests ?? {},
      serviceSocketOverrides: parsed.serviceSocketOverrides ?? {},
    };
  } catch (error) {
    if (error instanceof Error && 'code' in error && error.code === 'ENOENT') {
      return emptyStore();
    }
    throw error;
  }
};

export const writeExtensionStore = async (
  persistPath,
  {
    paths,
    sources = {},
    gitOrigins = {},
    capabilityGrants = {},
    disabledGuests = {},
    serviceSocketOverrides = {},
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
    // An origin only means something for a git copy that is still installed.
    const origin = source === 'git' ? gitOrigins[entry] : undefined;
    if (origin && typeof origin.url === 'string' && origin.url) {
      origins[entry] = origin.ref ? { url: origin.url, ref: origin.ref } : { url: origin.url };
    }
  }
  const grants = {};
  for (const [id, granted] of Object.entries(capabilityGrants)) {
    if (Array.isArray(granted) && granted.length > 0) {
      grants[id] = [...granted];
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
  if (Object.keys(disabled).length > 0) {
    payload.disabledGuests = disabled;
  }
  if (Object.keys(socketOverrides).length > 0) {
    payload.serviceSocketOverrides = socketOverrides;
  }
  for (const listener of writeListeners) listener(persistPath);
  await withStoreWriteLock(persistPath, async () => {
    await fs.mkdir(path.dirname(persistPath), { recursive: true });
    const tmp = `${persistPath}.tmp-${process.pid}-${Date.now()}-${(writeSequence += 1)}`;
    await fs.writeFile(tmp, `${JSON.stringify(payload, null, 2)}\n`, 'utf8');
    await fs.rename(tmp, persistPath);
  });
};

let writeSequence = 0;
/** @type {Set<(persistPath: string) => void>} */
const writeListeners = new Set();

/** Called before every store write with the path about to change. */
export const onExtensionStoreWrite = (listener) => {
  writeListeners.add(listener);
  return () => writeListeners.delete(listener);
};
/** @type {Map<string, Promise<void>>} */
const writeChains = new Map();

// Two writers in one process (say, Enable and Allow clicked back to back)
// used to share one temp file: the second truncated it under the first's
// rename and the store came back as half a JSON document. Writes to one path
// now run one after another, each on its own temp file.
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

export const writeExtensionPaths = async (paths, persistPath) => {
  const current = await readExtensionStore(persistPath);
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
  await writeExtensionStore(persistPath, {
    paths,
    sources,
    gitOrigins,
    capabilityGrants: current.capabilityGrants,
    disabledGuests: current.disabledGuests,
    serviceSocketOverrides: current.serviceSocketOverrides,
  });
};

/**
 * Record the user's approval for one guest. `granted` replaces the previous
 * list; an empty list withdraws approval. Callers pass the requested list
 * verbatim, so approval is all-or-nothing per install.
 * @param {string} guestId
 * @param {string} persistPath
 * @param {string[]} granted
 */
export const setCapabilityGrants = async (guestId, persistPath, granted) => {
  const current = await readExtensionStore(persistPath);
  const capabilityGrants = { ...current.capabilityGrants };
  if (granted.length > 0) {
    capabilityGrants[guestId] = [...granted];
  } else {
    delete capabilityGrants[guestId];
  }
  await writeExtensionStore(persistPath, { ...current, capabilityGrants });
};
