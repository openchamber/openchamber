import fs from 'node:fs/promises';
import { randomUUID } from 'node:crypto';
import { removeGuestData, removeGuestStorage } from './storage.js';
import https from 'node:https';
import path from 'node:path';
import { z } from 'zod';

import {
  inspectGuestPackage,
  listInstalledGuests,
  resolveGuestPackageRoot,
  toPublicGuest,
} from './catalog.js';
import { forgetServiceFailure, stopGuestService } from './service.js';
import { cloneGitRepository, isAllowedInstallHost, isHttpsZipUrl, parseGitInstallUrl, resolveInstallAddresses } from './clone.js';
import { isReservedBuiltInId } from './builtins.js';
import { enterpriseBlockedCapabilities } from './enterprise.js';
import { extractZipBuffer, unwrapGuestRoot } from './extract-zip.js';
import {
  guestCopiesDir,
  isCopiedGuestRoot,
  readExtensionStore,
  setGuestFolders,
  updateExtensionStore,
  withGuestCheckoutLock,
  withGuestFolders,
} from './persist.js';
import type { GitOrigin, ExtensionStore } from './persist.js';
import type { GuestPackage, JsonValue } from './contracts.js';
import type { PublicGuest } from './catalog.js';
import type { AddressLookup, GuestGitAccounts, ResolvedAddress } from './clone.js';
import type { TcpNetConnectOpts } from 'node:net';
import { isString } from './input-guards.js';

type InstallOptions = { openchamberVersion?: string | undefined; replace?: boolean; folders?: readonly string[] | undefined };
type GitInstallOptions = InstallOptions & {
  gitBinary?: string | undefined;
  gitIdentityId?: string | undefined;
  gitAccounts?: GuestGitAccounts | undefined;
  ref?: string | undefined;
};
type InstallFailure = { ok: false; code: string; id?: string; reason?: string; required?: string; capabilities?: string[] };
type InstallResult = { ok: true; guest: PublicGuest; replaced: boolean } | InstallFailure;
type PrepareResult = { ok: true; root?: string } | InstallFailure;
type CopiedInstallOptions = InstallOptions & {
  source: 'zip' | 'git';
  prepare: (staging: string) => Promise<PrepareResult>;
  persistPath: string;
  origin?: GitOrigin | null;
};

const MAX_ZIP_BYTES = 20 * 1024 * 1024;
const DOWNLOAD_TIMEOUT_MS = 60_000;

const installBodySchema = z.object({
  path: z.string().trim().min(1).optional(),
  url: z.string().trim().min(1).optional(),
  gitIdentityId: z.string().trim().min(1).max(128).optional(),
  replace: z.boolean().optional(),
}).refine((value) => Boolean(value.path) !== Boolean(value.url));

export const parseInstallRequest = (body: JsonValue | undefined) => {
  const parsed = installBodySchema.safeParse(body);
  return parsed.success ? parsed.data : null;
};

const persistGuest = async (guest: GuestPackage, root: string, source: 'path' | 'git' | 'zip', persistPath: string, { replace = false, origin = null, folders }: { replace?: boolean; origin?: GitOrigin | null; folders?: readonly string[] | undefined } = {}): Promise<InstallResult> => {
  if (isReservedBuiltInId(guest.id)) return { ok: false, code: 'reserved-id' };
  const stored = await readExtensionStore(persistPath);
  const storedRoots = await Promise.all(stored.paths.map((entry) => resolveGuestPackageRoot(entry)));
  if (storedRoots.some((entry) => entry === root)) {
    if (!replace) {
      return { ok: false, code: 'already-installed', id: guest.id };
    }
    if (folders) await setGuestFolders(guest.id, persistPath, folders);
    return {
      ok: true,
      replaced: true,
      guest: toPublicGuest({
        ...guest,
        source,
        path: root,
        capabilityGrants: stored.capabilityGrants?.[guest.id] ?? [],
        enabled: !stored.disabledGuests?.[guest.id],
        storageId: stored.storageIds?.[guest.id],
        folders: folders ? [...folders] : stored.guestFolders?.[guest.id],
      }),
    };
  }
  const existing = await listInstalledGuests({ persistPath });
  const clash = existing.find((entry) => entry.id === guest.id);
  if (clash) {
    if (!replace) {
      return { ok: false, code: 'id-taken', id: guest.id };
    }
    const removed = await uninstallGuest(guest.id, persistPath, { preserveStorageId: true });
    if (!removed.ok) {
      return removed;
    }
  }
  let storageId: NonNullable<ExtensionStore['storageIds']>[string];
  let savedFolders: string[] | undefined;
  await updateExtensionStore(persistPath, (after) => {
    storageId = after.storageIds?.[guest.id] ?? randomUUID();
    const guestFolders = folders ? withGuestFolders(after.guestFolders, guest.id, folders) : after.guestFolders;
    savedFolders = guestFolders?.[guest.id];
    return {
      ...after,
      paths: after.paths.includes(root) ? after.paths : [...after.paths, root],
      sources: { ...after.sources, [root]: source },
      gitOrigins: origin ? { ...after.gitOrigins, [root]: origin } : after.gitOrigins,
      storageIds: { ...after.storageIds, [guest.id]: storageId },
      guestFolders,
    };
  });
  return {
    ok: true,
    replaced: Boolean(clash),
    guest: toPublicGuest({ ...guest, source, path: root, capabilityGrants: [], enabled: true, storageId, folders: savedFolders }),
  };
};

const removeDir = async (dir: string) => {
  await fs.rm(dir, { recursive: true, force: true });
};

const installCopiedGuest = async ({ source, prepare, persistPath, openchamberVersion, replace = false, origin = null, folders }: CopiedInstallOptions): Promise<InstallResult> => {
  const copies = guestCopiesDir(persistPath);
  await fs.mkdir(copies, { recursive: true });
  const staging = path.join(copies, `.tmp-${process.pid}-${Date.now()}`);
  try {
    const prepared = await prepare(staging);
    if (!prepared.ok) {
      await removeDir(staging);
      return prepared;
    }
    const packageRoot = await unwrapGuestRoot(prepared.root ?? staging);
    const inspected = await inspectGuestPackage(packageRoot, { openchamberVersion });
    if (!inspected.ok) {
      await removeDir(staging);
      return inspected;
    }
    if (isReservedBuiltInId(inspected.guest.id)) {
      await removeDir(staging);
      return { ok: false, code: 'reserved-id' };
    }
    const blocked = enterpriseBlockedCapabilities(inspected.guest, { source, gitUrl: origin?.url });
    if (blocked.length > 0) {
      await removeDir(staging);
      return { ok: false, code: 'enterprise-mode', capabilities: blocked };
    }
    const dest = path.join(copies, inspected.guest.id);
    const store = await readExtensionStore(persistPath);
    const destReal = await fs.realpath(dest).catch(() => dest);
    const registered = store.paths.some((entry) => path.resolve(entry) === dest || path.resolve(entry) === destReal);
    if (registered) {
      if (!replace) {
        await removeDir(staging);
        return { ok: false, code: 'already-installed', id: inspected.guest.id };
      }
      const removed = await uninstallGuest(inspected.guest.id, persistPath, { preserveStorageId: true });
      if (!removed.ok) {
        await removeDir(staging);
        return removed;
      }
    }
    await removeDir(dest);
    await fs.rename(packageRoot, dest);
    if (packageRoot !== staging) {
      await removeDir(staging);
    }
    const root = await fs.realpath(dest);
    const persisted = await persistGuest(inspected.guest, root, source, persistPath, { replace, origin, folders });
    if (!persisted.ok) {
      await removeDir(dest);
      return persisted;
    }
    return registered ? { ...persisted, replaced: true } : persisted;
  } catch {
    await removeDir(staging);
    return { ok: false, code: source === 'git' ? 'clone-failed' : 'extract-failed' };
  }
};

const isHttpsRedirectUrl = (value: string) => {
  try {
    const parsed = new URL(value);
    return parsed.protocol === 'https:' && parsed.username === '' && parsed.password === '' && isAllowedInstallHost(parsed.hostname);
  } catch {
    return false;
  }
};

const readLocalZip = async (filePath: string) => {
  try {
    const stat = await fs.stat(filePath);
    if (!stat.isFile() || stat.size > MAX_ZIP_BYTES) {
      return null;
    }
    return await fs.readFile(filePath);
  } catch {
    return null;
  }
};

const MAX_ZIP_REDIRECTS = 5;

const requestHttpsPinned = (url: string, target: ResolvedAddress, maxBytes: number) => new Promise<{ status: number; location: string | null; body: Buffer | null }>((resolve, reject) => {
  const parsed = new URL(url);
  const options: https.RequestOptions & Pick<TcpNetConnectOpts, 'autoSelectFamily'> = {
    method: 'GET',
    lookup: (_hostname, options, callback) => (
      options?.all
        ? callback(null, [{ address: target.address, family: target.family }])
        : callback(null, target.address, target.family)
    ),
    autoSelectFamily: false,
    headers: { 'User-Agent': 'openchamber' },
    timeout: DOWNLOAD_TIMEOUT_MS,
  };
  const request = https.request(parsed, options, (response) => {
    const status = response.statusCode ?? 0;
    const location = isString(response.headers.location) ? response.headers.location : null;
    if (status >= 300 && status < 400) {
      response.resume();
      resolve({ status, location, body: null });
      return;
    }
    const declared = Number(response.headers['content-length']);
    if (Number.isFinite(declared) && declared > maxBytes) {
      response.destroy();
      resolve({ status, location, body: null });
      return;
    }
    const chunks: Buffer[] = [];
    let received = 0;
    response.on('data', (chunk) => {
      received += chunk.length;
      if (received > maxBytes) {
        response.destroy();
        resolve({ status, location, body: null });
        return;
      }
      chunks.push(chunk);
    });
    response.on('end', () => resolve({ status, location, body: Buffer.concat(chunks) }));
    response.on('error', reject);
  });
  request.on('timeout', () => request.destroy(new Error('download timed out')));
  request.on('error', reject);
  request.end();
});

export const downloadZip = async (url: string, { request = requestHttpsPinned, lookup }: { request?: typeof requestHttpsPinned; lookup?: AddressLookup } = {}) => {
  let current = url;
  for (let hop = 0; hop <= MAX_ZIP_REDIRECTS; hop += 1) {
    if (!isHttpsZipUrl(current) && !isHttpsRedirectUrl(current)) {
      return null;
    }
    const addresses = await resolveInstallAddresses(new URL(current).hostname, lookup);
    if (!addresses) {
      return null;
    }
    let response = null;
    for (const target of addresses) {
      try {
        response = await request(current, target, MAX_ZIP_BYTES);
        break;
      } catch {
        continue;
      }
    }
    if (!response) {
      return null;
    }
    if (response.status >= 300 && response.status < 400) {
      if (!response.location) {
        return null;
      }
      current = new URL(response.location, current).href;
      continue;
    }
    if (response.status < 200 || response.status >= 300 || !response.body) {
      return null;
    }
    return response.body;
  }
  return null;
};

export const installGuestFromZipBuffer = async (buffer: Buffer, persistPath: string, { openchamberVersion, replace = false, folders }: InstallOptions = {}) => (
  installCopiedGuest({
    source: 'zip',
    persistPath,
    openchamberVersion,
    replace,
    folders,
    prepare: async (staging) => {
      const extracted = await extractZipBuffer(buffer, staging);
      return extracted.ok ? { ok: true, root: staging } : extracted;
    },
  })
);

export const installGuestFromPath = async (rawPath: string, persistPath: string, { openchamberVersion, replace = false, folders }: InstallOptions = {}): Promise<InstallResult> => {
  if (!path.isAbsolute(rawPath)) {
    return { ok: false, code: 'invalid-path' };
  }
  try {
    const stat = await fs.stat(rawPath);
    if (stat.isFile() && rawPath.toLowerCase().endsWith('.zip')) {
      const buffer = await readLocalZip(rawPath);
      if (!buffer) {
        return { ok: false, code: 'not-found' };
      }
      return installGuestFromZipBuffer(buffer, persistPath, { openchamberVersion, replace, folders });
    }
  } catch {
    return { ok: false, code: 'not-found' };
  }

  const root = await resolveGuestPackageRoot(rawPath);
  if (!root) {
    return { ok: false, code: 'not-found' };
  }
  const inspected = await inspectGuestPackage(root, { openchamberVersion });
  if (!inspected.ok) {
    return inspected;
  }
  const blocked = enterpriseBlockedCapabilities(inspected.guest, { source: 'path' });
  if (blocked.length > 0) {
    return { ok: false, code: 'enterprise-mode', capabilities: blocked };
  }
  return persistGuest(inspected.guest, root, 'path', persistPath, { replace, folders });
};

export const installGuestFromUrl = async (rawUrl: string, persistPath: string, { openchamberVersion, replace = false, gitBinary, gitIdentityId, gitAccounts, folders }: GitInstallOptions = {}): Promise<InstallResult> => {
  if (isHttpsZipUrl(rawUrl)) {
    try {
      const buffer = await downloadZip(rawUrl);
      if (!buffer) {
        return { ok: false, code: 'extract-failed' };
      }
      return installGuestFromZipBuffer(buffer, persistPath, { openchamberVersion, replace, folders });
    } catch {
      return { ok: false, code: 'extract-failed' };
    }
  }
  const gitSource = parseGitInstallUrl(rawUrl);
  if (!gitSource) {
    return { ok: false, code: 'invalid-url' };
  }
  return installGuestFromGitSource(gitSource.url, persistPath, { openchamberVersion, replace, gitBinary, ref: gitSource.ref, gitIdentityId, gitAccounts, folders });
};

export const installGuestFromGitSource = async (source: string, persistPath: string, { openchamberVersion, replace = false, gitBinary, ref, gitIdentityId, gitAccounts, folders }: GitInstallOptions = {}) => {
  const origin: GitOrigin = { url: source };
  if (ref) origin.ref = ref;
  if (gitIdentityId) origin.gitIdentityId = gitIdentityId;
  return installCopiedGuest({
    source: 'git',
    persistPath,
    openchamberVersion,
    replace,
    origin,
    folders,
    prepare: async (staging) => {
      const cloned = await cloneGitRepository(source, staging, { gitBinary, ref, gitIdentityId, gitAccounts });
      return cloned.ok ? { ok: true, root: staging } : cloned;
    },
  });
};

export const installGuest = async (request: z.infer<typeof installBodySchema>, persistPath: string, { openchamberVersion, gitBinary, gitAccounts, folders }: GitInstallOptions = {}) => {
  const replace = Boolean(request.replace);
  if (request.url) {
    return installGuestFromUrl(request.url, persistPath, { openchamberVersion, replace, gitBinary, gitIdentityId: request.gitIdentityId, gitAccounts, folders });
  }
  if (request.path === undefined) throw Object.assign(new TypeError('The "path" argument must be of type string. Received undefined'), { code: 'ERR_INVALID_ARG_TYPE' });
  return installGuestFromPath(request.path, persistPath, { openchamberVersion, replace, folders });
};

const unregisterGuest = async (id: string, persistPath: string, preserveStorageId: boolean): Promise<{ ok: true; root: string } | InstallFailure> => {
  const existing = await listInstalledGuests({ persistPath, underCheckoutLock: true });
  const guest = existing.find((entry) => entry.id === id);
  if (!guest) {
    return { ok: false, code: 'not-found' };
  }
  if (guest.source === 'bundled') {
    return { ok: false, code: 'bundled' };
  }

  let removedRoot: string | null = null;
  await updateExtensionStore(persistPath, async (stored) => {
    const kept = [];
    const sources: ExtensionStore['sources'] = {};
    const gitOrigins: ExtensionStore['gitOrigins'] = {};
    for (const entry of stored.paths) {
      const root = await resolveGuestPackageRoot(entry);
      if (root === guest.packageRoot) {
        removedRoot = root;
        continue;
      }
      kept.push(entry);
      if (stored.sources[entry]) {
        sources[entry] = stored.sources[entry];
      }
      if (stored.gitOrigins[entry]) {
        gitOrigins[entry] = stored.gitOrigins[entry];
      }
    }
    if (!removedRoot) return null;
    const capabilityGrants = { ...(stored.capabilityGrants ?? {}) };
    delete capabilityGrants[id];
    const capabilityScopes = { ...(stored.capabilityScopes ?? {}) };
    delete capabilityScopes[id];
    const disabledGuests = { ...(stored.disabledGuests ?? {}) };
    delete disabledGuests[id];
    const guestFolders = { ...(stored.guestFolders ?? {}) };
    if (!preserveStorageId) delete guestFolders[id];
    const serviceSocketOverrides = { ...(stored.serviceSocketOverrides ?? {}) };
    delete serviceSocketOverrides[id];
    const storageIds = { ...(stored.storageIds ?? {}) };
    if (!preserveStorageId) delete storageIds[id];
    return { paths: kept, sources, gitOrigins, capabilityGrants, capabilityScopes, disabledGuests, guestFolders, serviceSocketOverrides, storageIds };
  });
  if (!removedRoot) return { ok: false, code: 'not-found' };
  return { ok: true, root: removedRoot };
};

export const uninstallGuest = async (id: string, persistPath: string, { preserveStorageId = false } = {}): Promise<{ ok: true } | InstallFailure> => {
  const unregistered = await withGuestCheckoutLock(persistPath, () => unregisterGuest(id, persistPath, preserveStorageId));
  if (!unregistered.ok) return unregistered;
  await stopGuestService(id);
  forgetServiceFailure(id);
  await removeGuestStorage(persistPath, id);
  if (!preserveStorageId) await removeGuestData(persistPath, id);
  if (isCopiedGuestRoot(unregistered.root, persistPath)) {
    await fs.rm(unregistered.root, { recursive: true, force: true });
  }
  return { ok: true };
};
