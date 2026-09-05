import fs from 'node:fs/promises';
import path from 'node:path';
import { z } from 'zod';

import {
  inspectGuestPackage,
  listInstalledGuests,
  resolveGuestPackageRoot,
  toPublicGuest,
} from './catalog.js';
import { stopGuestAgent } from './agent.js';
import { cloneGitRepository, isHttpsGitUrl, isHttpsZipUrl } from './clone.js';
import { extractZipBuffer, unwrapGuestRoot } from './extract-zip.js';
import {
  guestCopiesDir,
  isCopiedGuestRoot,
  readExtensionStore,
  writeExtensionStore,
} from './persist.js';

const MAX_ZIP_BYTES = 20 * 1024 * 1024;

const installBodySchema = z.object({
  path: z.string().trim().min(1).optional(),
  url: z.string().trim().min(1).optional(),
}).refine((value) => Boolean(value.path) !== Boolean(value.url));

export const parseInstallRequest = (body) => {
  const parsed = installBodySchema.safeParse(body);
  return parsed.success ? parsed.data : null;
};

const persistGuest = async (guest, root, source, persistPath) => {
  const stored = await readExtensionStore(persistPath);
  const storedRoots = await Promise.all(stored.paths.map((entry) => resolveGuestPackageRoot(entry)));
  if (storedRoots.some((entry) => entry === root)) {
    return { ok: false, code: 'already-installed' };
  }
  const existing = await listInstalledGuests({ persistPath });
  if (existing.some((entry) => entry.id === guest.id)) {
    return { ok: false, code: 'id-taken' };
  }
  await writeExtensionStore(persistPath, {
    paths: [...stored.paths, root],
    sources: { ...stored.sources, [root]: source },
    agentGrants: stored.agentGrants,
    disabledGuests: stored.disabledGuests,
    agentSocketOverrides: stored.agentSocketOverrides,
  });
  return {
    ok: true,
    guest: toPublicGuest({ ...guest, source, path: root, agentGranted: false, enabled: true }),
  };
};

const removeDir = async (dir) => {
  await fs.rm(dir, { recursive: true, force: true });
};

const installCopiedGuest = async ({ source, prepare, persistPath, openchamberVersion }) => {
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
    const dest = path.join(copies, inspected.guest.id);
    if (await resolveGuestPackageRoot(dest)) {
      await removeDir(staging);
      return { ok: false, code: 'id-taken' };
    }
    await fs.rename(packageRoot, dest);
    if (packageRoot !== staging) {
      await removeDir(staging);
    }
    const root = await fs.realpath(dest);
    const persisted = await persistGuest(inspected.guest, root, source, persistPath);
    if (!persisted.ok) {
      await removeDir(dest);
    }
    return persisted;
  } catch {
    await removeDir(staging);
    return { ok: false, code: source === 'git' ? 'clone-failed' : 'extract-failed' };
  }
};

const readLocalZip = async (filePath) => {
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

const downloadZip = async (url) => {
  const response = await fetch(url, { redirect: 'follow' });
  if (!response.ok) {
    return null;
  }
  const length = Number(response.headers.get('content-length'));
  if (Number.isFinite(length) && length > MAX_ZIP_BYTES) {
    return null;
  }
  const buffer = Buffer.from(await response.arrayBuffer());
  if (buffer.length > MAX_ZIP_BYTES) {
    return null;
  }
  return buffer;
};

const installFromZipBuffer = async (buffer, persistPath, { openchamberVersion } = {}) => (
  installCopiedGuest({
    source: 'zip',
    persistPath,
    openchamberVersion,
    prepare: async (staging) => {
      const extracted = await extractZipBuffer(buffer, staging);
      return extracted.ok ? { ok: true, root: staging } : extracted;
    },
  })
);

export const installGuestFromPath = async (rawPath, persistPath, { openchamberVersion } = {}) => {
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
      return installFromZipBuffer(buffer, persistPath, { openchamberVersion });
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
  return persistGuest(inspected.guest, root, 'path', persistPath);
};

export const installGuestFromUrl = async (rawUrl, persistPath, { openchamberVersion } = {}) => {
  if (isHttpsZipUrl(rawUrl)) {
    try {
      const buffer = await downloadZip(rawUrl);
      if (!buffer) {
        return { ok: false, code: 'extract-failed' };
      }
      return installFromZipBuffer(buffer, persistPath, { openchamberVersion });
    } catch {
      return { ok: false, code: 'extract-failed' };
    }
  }
  if (!isHttpsGitUrl(rawUrl)) {
    return { ok: false, code: 'invalid-url' };
  }
  return installGuestFromGitSource(rawUrl, persistPath, { openchamberVersion });
};

export const installGuestFromGitSource = async (source, persistPath, { openchamberVersion } = {}) => (
  installCopiedGuest({
    source: 'git',
    persistPath,
    openchamberVersion,
    prepare: async (staging) => {
      const cloned = await cloneGitRepository(source, staging);
      return cloned.ok ? { ok: true, root: staging } : cloned;
    },
  })
);

export const installGuest = async (request, persistPath, { openchamberVersion } = {}) => {
  if (request.url) {
    return installGuestFromUrl(request.url, persistPath, { openchamberVersion });
  }
  return installGuestFromPath(request.path, persistPath, { openchamberVersion });
};

export const uninstallGuest = async (id, persistPath) => {
  const existing = await listInstalledGuests({ persistPath });
  const guest = existing.find((entry) => entry.id === id);
  if (!guest) {
    return { ok: false, code: 'not-found' };
  }
  if (guest.source === 'bundled') {
    return { ok: false, code: 'bundled' };
  }

  const stored = await readExtensionStore(persistPath);
  const kept = [];
  const sources = {};
  let removedRoot = null;
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
  }
  const agentGrants = { ...(stored.agentGrants ?? {}) };
  delete agentGrants[id];
  const disabledGuests = { ...(stored.disabledGuests ?? {}) };
  delete disabledGuests[id];
  const agentSocketOverrides = { ...(stored.agentSocketOverrides ?? {}) };
  delete agentSocketOverrides[id];
  await writeExtensionStore(persistPath, {
    paths: kept,
    sources,
    agentGrants,
    disabledGuests,
    agentSocketOverrides,
  });
  await stopGuestAgent(id);
  if (removedRoot && isCopiedGuestRoot(removedRoot, persistPath)) {
    await fs.rm(removedRoot, { recursive: true, force: true });
  }
  return { ok: true };
};
