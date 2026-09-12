import fs from 'node:fs/promises';
import path from 'node:path';
import { z } from 'zod';

import {
  inspectGuestPackage,
  listInstalledGuests,
  resolveGuestPackageRoot,
  toPublicGuest,
} from './catalog.js';
import { stopGuestService } from './service.js';
import { cloneGitRepository, isHttpsGitUrl, isHttpsZipUrl, parseGitInstallUrl } from './clone.js';
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
  replace: z.boolean().optional(),
}).refine((value) => Boolean(value.path) !== Boolean(value.url));

export const parseInstallRequest = (body) => {
  const parsed = installBodySchema.safeParse(body);
  return parsed.success ? parsed.data : null;
};

const persistGuest = async (guest, root, source, persistPath, { replace = false, origin = null } = {}) => {
  const stored = await readExtensionStore(persistPath);
  const storedRoots = await Promise.all(stored.paths.map((entry) => resolveGuestPackageRoot(entry)));
  if (storedRoots.some((entry) => entry === root)) {
    if (!replace) {
      return { ok: false, code: 'already-installed', id: guest.id };
    }
    return {
      ok: true,
      replaced: true,
      guest: toPublicGuest({
        ...guest,
        source,
        path: root,
        capabilityGrants: stored.capabilityGrants?.[guest.id] ?? [],
        enabled: !stored.disabledGuests?.[guest.id],
      }),
    };
  }
  const existing = await listInstalledGuests({ persistPath });
  const clash = existing.find((entry) => entry.id === guest.id);
  if (clash) {
    if (!replace) {
      return { ok: false, code: 'id-taken', id: guest.id };
    }
    const removed = await uninstallGuest(guest.id, persistPath);
    if (!removed.ok) {
      return removed;
    }
  }
  const after = await readExtensionStore(persistPath);
  await writeExtensionStore(persistPath, {
    paths: [...after.paths, root],
    sources: { ...after.sources, [root]: source },
    gitOrigins: origin ? { ...after.gitOrigins, [root]: origin } : after.gitOrigins,
    capabilityGrants: after.capabilityGrants,
    disabledGuests: after.disabledGuests,
    serviceSocketOverrides: after.serviceSocketOverrides,
  });
  return {
    ok: true,
    replaced: Boolean(clash),
    guest: toPublicGuest({ ...guest, source, path: root, capabilityGrants: [], enabled: true }),
  };
};

const removeDir = async (dir) => {
  await fs.rm(dir, { recursive: true, force: true });
};

const installCopiedGuest = async ({ source, prepare, persistPath, openchamberVersion, replace = false, origin = null }) => {
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
    const store = await readExtensionStore(persistPath);
    const registered = store.paths.some((entry) => path.resolve(entry) === dest);
    if (registered) {
      if (!replace) {
        await removeDir(staging);
        return { ok: false, code: 'id-taken', id: inspected.guest.id };
      }
      const removed = await uninstallGuest(inspected.guest.id, persistPath);
      if (!removed.ok) {
        await removeDir(staging);
        return removed;
      }
    }
    // A copy on disk that the store does not know about is a leftover from an
    // install that died between the move and the persist. It would otherwise
    // block this id forever, so it is replaced rather than reported.
    await removeDir(dest);
    await fs.rename(packageRoot, dest);
    if (packageRoot !== staging) {
      await removeDir(staging);
    }
    const root = await fs.realpath(dest);
    const persisted = await persistGuest(inspected.guest, root, source, persistPath, { replace, origin });
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
  // A public URL can redirect to a private one; the final hop is checked too.
  if (response.url && !isHttpsZipUrl(response.url) && !isHttpsGitUrl(response.url)) {
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

/**
 * Install from zip bytes already in memory. Local `.zip` paths, https zip
 * URLs, and browser uploads (`POST /api/guests/upload`) all land here, so the
 * archive limits, unwrap, inspection, and store write are one path. The
 * archive size cap is the caller's job: path and URL installs stop at
 * `MAX_ZIP_BYTES`, the upload route at its own configured limit.
 */
export const installGuestFromZipBuffer = async (buffer, persistPath, { openchamberVersion, replace = false } = {}) => (
  installCopiedGuest({
    source: 'zip',
    persistPath,
    openchamberVersion,
    replace,
    prepare: async (staging) => {
      const extracted = await extractZipBuffer(buffer, staging);
      return extracted.ok ? { ok: true, root: staging } : extracted;
    },
  })
);

export const installGuestFromPath = async (rawPath, persistPath, { openchamberVersion, replace = false } = {}) => {
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
      return installGuestFromZipBuffer(buffer, persistPath, { openchamberVersion, replace });
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
  return persistGuest(inspected.guest, root, 'path', persistPath, { replace });
};

export const installGuestFromUrl = async (rawUrl, persistPath, { openchamberVersion, replace = false, gitBinary } = {}) => {
  if (isHttpsZipUrl(rawUrl)) {
    try {
      const buffer = await downloadZip(rawUrl);
      if (!buffer) {
        return { ok: false, code: 'extract-failed' };
      }
      return installGuestFromZipBuffer(buffer, persistPath, { openchamberVersion, replace });
    } catch {
      return { ok: false, code: 'extract-failed' };
    }
  }
  const gitSource = parseGitInstallUrl(rawUrl);
  if (!gitSource) {
    return { ok: false, code: 'invalid-url' };
  }
  return installGuestFromGitSource(gitSource.url, persistPath, { openchamberVersion, replace, gitBinary, ref: gitSource.ref });
};

/**
 * `source` is the clone URL without its `#ref` fragment; `ref` is the branch
 * or tag to pin (omitted means the remote default branch). Both are stored
 * as the guest's origin so Settings → Extensions can check for updates later.
 */
export const installGuestFromGitSource = async (source, persistPath, { openchamberVersion, replace = false, gitBinary, ref } = {}) => (
  installCopiedGuest({
    source: 'git',
    persistPath,
    openchamberVersion,
    replace,
    origin: ref ? { url: source, ref } : { url: source },
    prepare: async (staging) => {
      const cloned = await cloneGitRepository(source, staging, { gitBinary, ref });
      return cloned.ok ? { ok: true, root: staging } : cloned;
    },
  })
);

export const installGuest = async (request, persistPath, { openchamberVersion, gitBinary } = {}) => {
  const replace = Boolean(request.replace);
  if (request.url) {
    return installGuestFromUrl(request.url, persistPath, { openchamberVersion, replace, gitBinary });
  }
  return installGuestFromPath(request.path, persistPath, { openchamberVersion, replace });
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
  const gitOrigins = {};
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
    if (stored.gitOrigins[entry]) {
      gitOrigins[entry] = stored.gitOrigins[entry];
    }
  }
  const capabilityGrants = { ...(stored.capabilityGrants ?? {}) };
  delete capabilityGrants[id];
  const disabledGuests = { ...(stored.disabledGuests ?? {}) };
  delete disabledGuests[id];
  const serviceSocketOverrides = { ...(stored.serviceSocketOverrides ?? {}) };
  delete serviceSocketOverrides[id];
  await writeExtensionStore(persistPath, {
    paths: kept,
    sources,
    gitOrigins,
    capabilityGrants,
    disabledGuests,
    serviceSocketOverrides,
  });
  await stopGuestService(id);
  if (removedRoot && isCopiedGuestRoot(removedRoot, persistPath)) {
    await fs.rm(removedRoot, { recursive: true, force: true });
  }
  return { ok: true };
};
