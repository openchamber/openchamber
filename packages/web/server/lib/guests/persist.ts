import fsSync from 'node:fs';
import fs from 'node:fs/promises';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import { z } from 'zod';

import { GUEST_CAPABILITIES } from '@openchamber/sdk';
import type { GuestCapability } from '@openchamber/sdk';
import { withSourceControlFileLock } from '../source-control/file-lock.js';

const GUEST_SOURCES = ['path', 'zip', 'git'] as const;

const storeSchema = z.object({
  paths: z.array(z.string().min(1).refine((entry) => !entry.includes('\0'))),
  sources: z.record(z.string(), z.enum(GUEST_SOURCES)).optional(),
  gitOrigins: z.record(z.string(), z.unknown()).optional(),
  capabilityGrants: z.record(z.string(), z.array(z.string())).optional(),
  capabilityScopes: z.record(z.string(), z.unknown()).optional(),
  disabledGuests: z.record(z.string(), z.literal(true)).optional(),
  guestFolders: z.record(z.string(), z.array(z.string().min(1).refine((entry) => !entry.includes('\0')))).optional(),
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

export type CapabilityScope = z.infer<typeof capabilityScopeSchema>;

const knownScopesOnly = (scopes: NonNullable<z.infer<typeof storeSchema>['capabilityScopes']>) => {
  const cleaned: Record<string, CapabilityScope> = {};
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

export type GitOrigin = z.infer<typeof gitOriginSchema>;

const knownGitOriginsOnly = (origins: NonNullable<z.infer<typeof storeSchema>['gitOrigins']>) => {
  const cleaned: Record<string, GitOrigin> = {};
  for (const [installPath, raw] of Object.entries(origins)) {
    const parsed = gitOriginSchema.safeParse(raw);
    if (!parsed.success) {
      continue;
    }
    cleaned[installPath] = parsed.data;
  }
  return cleaned;
};

const knownStorageIdsOnly = (storageIds: NonNullable<z.infer<typeof storeSchema>['storageIds']>) => Object.fromEntries(
  Object.entries(storageIds).filter(([, storageId]) => z.string().uuid().safeParse(storageId).success),
);

const parseStore = (raw: string) => {
  try {
    const parsed = storeSchema.safeParse(JSON.parse(raw));
    return parsed.success ? parsed.data : null;
  } catch {
    return null;
  }
};

const dataDirSchema = z.string().min(1).refine((entry) => !entry.includes('\0') && path.isAbsolute(entry));

export const extensionsPersistPath = (dataDir: string) => {
  const parsed = dataDirSchema.safeParse(dataDir);
  if (!parsed.success) {
    throw new Error('Guest persist needs an absolute OpenChamber data dir');
  }
  return path.join(parsed.data, 'extensions.json');
};

export const guestCopiesDir = (persistPath: string) => path.join(path.dirname(persistPath), 'extensions');

export const withGuestCheckoutLock = async <Result>(persistPath: string, operation: () => Promise<Result>, { waitMs = 10_000 } = {}) => {
  let completed: { result: Result } | undefined;
  try {
    return await withSourceControlFileLock(`${persistPath}.checkouts.lock`, async () => {
      completed = { result: await operation() };
      return completed.result;
    }, { waitMs });
  } catch (error) {
    if (!completed) throw error;
    console.warn('[guests] Could not release the checkout lock.');
    return completed.result;
  }
};

const realOrResolved = (value: string) => {
  try {
    return fsSync.realpathSync(value);
  } catch {
    return path.resolve(value);
  }
};

export const isCopiedGuestRoot = (root: string, persistPath: string) => {
  const copies = realOrResolved(guestCopiesDir(persistPath));
  const resolved = realOrResolved(root);
  return resolved === copies || resolved.startsWith(`${copies}${path.sep}`);
};

export type ExtensionStore = {
  paths: string[];
  sources: Record<string, 'path' | 'zip' | 'git'>;
  gitOrigins: Record<string, GitOrigin>;
  capabilityGrants: Record<string, GuestCapability[]>;
  capabilityScopes: Record<string, CapabilityScope>;
  disabledGuests: Record<string, true>;
  guestFolders: Record<string, string[]>;
  serviceSocketOverrides: Record<string, Record<string, string>>;
  storageIds?: NonNullable<z.infer<typeof storeSchema>['storageIds']>;
};
type StoreWrite = Pick<ExtensionStore, 'paths'> & Partial<Omit<ExtensionStore, 'paths'>>;

const emptyStore = (): ExtensionStore => ({
  paths: [],
  sources: {},
  gitOrigins: {},
  capabilityGrants: {},
  capabilityScopes: {},
  disabledGuests: {},
  guestFolders: {},
  serviceSocketOverrides: {},
});

const knownCapabilities = new Set(GUEST_CAPABILITIES);

const isKnownCapability = (capability: string): capability is GuestCapability => [...knownCapabilities].some((known) => known === capability);

const knownGrantsOnly = (grants: Record<string, string[]>) => Object.fromEntries(
  Object.entries(grants).map(([guestId, list]) => [guestId, list.filter(isKnownCapability)]),
);

export const readExtensionStore = async (persistPath: string): Promise<ExtensionStore> => {
  try {
    const raw = await fs.readFile(persistPath, 'utf8');
    const parsed = parseStore(raw);
    if (!parsed) {
      throw new Error('Invalid extensions store');
    }
    const store: ExtensionStore = {
      paths: parsed.paths,
      sources: parsed.sources ?? {},
      gitOrigins: knownGitOriginsOnly(parsed.gitOrigins ?? {}),
      capabilityGrants: knownGrantsOnly(parsed.capabilityGrants ?? {}),
      capabilityScopes: knownScopesOnly(parsed.capabilityScopes ?? {}),
      disabledGuests: parsed.disabledGuests ?? {},
      guestFolders: parsed.guestFolders ?? {},
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
  persistPath: string,
  {
    paths,
    sources = {},
    gitOrigins = {},
    capabilityGrants = {},
    capabilityScopes = {},
    disabledGuests = {},
    guestFolders = {},
    serviceSocketOverrides = {},
    storageIds = {},
  }: StoreWrite,
) => {
  const cleaned: ExtensionStore['sources'] = {};
  const origins: Record<string, GitOrigin> = {};
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
  const grants: ExtensionStore['capabilityGrants'] = {};
  for (const [id, granted] of Object.entries(capabilityGrants)) {
    if (Array.isArray(granted) && granted.length > 0) {
      grants[id] = [...granted];
    }
  }
  const scopes: ExtensionStore['capabilityScopes'] = {};
  for (const [id, scope] of Object.entries(capabilityScopes)) {
    if (grants[id] && capabilityScopeSchema.safeParse(scope).success) {
      scopes[id] = scope;
    }
  }
  const disabled: ExtensionStore['disabledGuests'] = {};
  for (const [id, isDisabled] of Object.entries(disabledGuests)) {
    if (isDisabled) {
      disabled[id] = true;
    }
  }
  const socketOverrides: ExtensionStore['serviceSocketOverrides'] = {};
  for (const [guestId, bySocket] of Object.entries(serviceSocketOverrides)) {
    const cleanedSockets: Record<string, string> = {};
    for (const [socketId, socketPath] of Object.entries(bySocket ?? {})) {
      if (socketPath.trim() && !socketPath.includes('\0')) {
        cleanedSockets[socketId] = socketPath.trim();
      }
    }
    if (Object.keys(cleanedSockets).length > 0) {
      socketOverrides[guestId] = cleanedSockets;
    }
  }
  const payload: StoreWrite = { paths };
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
  const folders = Object.fromEntries(
    Object.entries(guestFolders).filter(([, list]) => Array.isArray(list) && list.length > 0),
  );
  if (Object.keys(folders).length > 0) {
    payload.guestFolders = folders;
  }
  if (Object.keys(socketOverrides).length > 0) {
    payload.serviceSocketOverrides = socketOverrides;
  }
  const identities: Record<string, string> = {};
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

export const writeExtensionStore = (persistPath: string, store: StoreWrite) => (
  withStoreWriteLock(persistPath, () => writeExtensionStoreUnlocked(persistPath, store))
);

export const updateExtensionStore = (persistPath: string, mutate: (current: ExtensionStore) => Promise<StoreWrite | null> | StoreWrite | null) => (
  withStoreWriteLock(persistPath, async () => {
    const current = await readExtensionStore(persistPath);
    const next = await mutate(current);
    if (next) {
      await writeExtensionStoreUnlocked(persistPath, next);
    }
  })
);

export const ensureGuestStorageIds = async (persistPath: string, descriptors: Array<{ id: string; storedPath: string | null; builtIn: boolean }>) => {
  const resolved: NonNullable<ExtensionStore['storageIds']> = {};
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
const writeListeners = new Set<(persistPath: string) => void>();

export const onExtensionStoreWrite = (listener: (persistPath: string) => void) => {
  writeListeners.add(listener);
  return () => writeListeners.delete(listener);
};
const writeChains = new Map<string, Promise<void>>();

const withStoreWriteLock = (persistPath: string, write: () => Promise<void>) => {
  const previous = writeChains.get(persistPath) ?? Promise.resolve();
  const next = previous.catch(() => undefined).then(write);
  writeChains.set(persistPath, next.finally(() => {
    if (writeChains.get(persistPath) === chained) writeChains.delete(persistPath);
  }));
  const chained = writeChains.get(persistPath);
  return next;
};

export const readExtensionPaths = async (persistPath: string) => {
  const store = await readExtensionStore(persistPath);
  return store.paths;
};

export const writeExtensionPaths = (paths: string[], persistPath: string) => updateExtensionStore(persistPath, (current) => {
  const sources: ExtensionStore['sources'] = {};
  const gitOrigins: ExtensionStore['gitOrigins'] = {};
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

export const withGuestFolders = (current: ExtensionStore['guestFolders'], guestId: string, folders: readonly string[]) => {
  const guestFolders = { ...current };
  if (folders.length > 0) {
    guestFolders[guestId] = [...folders];
  } else {
    delete guestFolders[guestId];
  }
  return guestFolders;
};

export const setGuestFolders = (guestId: string, persistPath: string, folders: readonly string[]) => updateExtensionStore(persistPath, (current) => (
  { ...current, guestFolders: withGuestFolders(current.guestFolders, guestId, folders) }
));

export const setCapabilityGrants = (guestId: string, persistPath: string, granted: GuestCapability[], scope: CapabilityScope | null = null) => updateExtensionStore(persistPath, (current) => {
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
