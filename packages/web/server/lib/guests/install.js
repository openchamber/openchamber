import fs from 'node:fs/promises';
import { removeGuestStorage } from './storage.js';
import https from 'node:https';
import path from 'node:path';
import { z } from 'zod';

import {
  inspectGuestPackage,
  listInstalledGuests,
  resolveGuestPackageRoot,
  toPublicGuest,
} from './catalog.js';
import { stopGuestService } from './service.js';
import { cloneGitRepository, isHttpsZipUrl, isPublicHostname, parseGitInstallUrl, publicAddressesOf } from './clone.js';
import { extractZipBuffer, unwrapGuestRoot } from './extract-zip.js';
import {
  guestCopiesDir,
  isCopiedGuestRoot,
  readExtensionStore,
  updateExtensionStore,
} from './persist.js';

const MAX_ZIP_BYTES = 20 * 1024 * 1024;
const DOWNLOAD_TIMEOUT_MS = 60_000;

const installBodySchema = z.object({
  path: z.string().trim().min(1).optional(),
  url: z.string().trim().min(1).optional(),
  gitIdentityId: z.string().trim().min(1).max(128).optional(),
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
  await updateExtensionStore(persistPath, (after) => ({
    ...after,
    paths: after.paths.includes(root) ? after.paths : [...after.paths, root],
    sources: { ...after.sources, [root]: source },
    gitOrigins: origin ? { ...after.gitOrigins, [root]: origin } : after.gitOrigins,
  }));
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
    // The store holds the copy's realpath (on macOS /tmp is a symlink, so
    // that differs from `dest` as spelled); either spelling is the same
    // package already installed, not another folder claiming the id.
    const destReal = await fs.realpath(dest).catch(() => dest);
    const registered = store.paths.some((entry) => path.resolve(entry) === dest || path.resolve(entry) === destReal);
    if (registered) {
      if (!replace) {
        await removeDir(staging);
        return { ok: false, code: 'already-installed', id: inspected.guest.id };
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
      return persisted;
    }
    // A registered copy was uninstalled above before this one took its place.
    return registered ? { ...persisted, replaced: true } : persisted;
  } catch {
    await removeDir(staging);
    return { ok: false, code: source === 'git' ? 'clone-failed' : 'extract-failed' };
  }
};

// A redirect hop may land on a signed download URL without a .zip suffix; it
// still has to be https on a public host.
const isHttpsRedirectUrl = (value) => {
  try {
    const parsed = new URL(value);
    return parsed.protocol === 'https:' && parsed.username === '' && parsed.password === '' && isPublicHostname(parsed.hostname);
  } catch {
    return false;
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

const MAX_ZIP_REDIRECTS = 5;

/**
 * One https request pinned to an address the caller already checked. The
 * socket goes to `address`; TLS still verifies the certificate against the
 * URL's hostname. Redirects are not followed: the status and `location` come
 * back for the caller to check. The body is capped while it streams.
 * @param {string} url
 * @param {{ address: string, family: 4 | 6 }} target
 * @param {number} maxBytes
 * @returns {Promise<{ status: number, location: string | null, body: Buffer | null }>}
 */
const requestHttpsPinned = (url, target, maxBytes) => new Promise((resolve, reject) => {
  const parsed = new URL(url);
  const request = https.request(parsed, {
    method: 'GET',
    // Node's connector asks for `all` addresses when it tries families in
    // parallel; either way it only ever gets the one that was checked.
    lookup: (_hostname, options, callback) => (
      options?.all
        ? callback(null, [{ address: target.address, family: target.family }])
        : callback(null, target.address, target.family)
    ),
    autoSelectFamily: false,
    headers: { 'User-Agent': 'openchamber' },
    timeout: DOWNLOAD_TIMEOUT_MS,
  }, (response) => {
    const status = response.statusCode ?? 0;
    const location = typeof response.headers.location === 'string' ? response.headers.location : null;
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
    /** @type {Buffer[]} */
    const chunks = [];
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

/**
 * Fetch the archive by hand, one hop at a time. A public URL can redirect to
 * a private one, so every hop is checked (https, public host, public DNS
 * answer) before the request is made, and the request goes to the address
 * that was checked, not to whatever a second lookup would say.
 * @param {string} url
 * @param {{ request?: typeof requestHttpsPinned, lookup?: Parameters<typeof publicAddressesOf>[1] }} [options]
 */
export const downloadZip = async (url, { request = requestHttpsPinned, lookup } = {}) => {
  let current = url;
  for (let hop = 0; hop <= MAX_ZIP_REDIRECTS; hop += 1) {
    if (!isHttpsZipUrl(current) && !isHttpsRedirectUrl(current)) {
      return null;
    }
    const addresses = await publicAddressesOf(new URL(current).hostname, lookup);
    if (!addresses) {
      return null;
    }
    const response = await request(current, addresses[0], MAX_ZIP_BYTES);
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

export const installGuestFromUrl = async (rawUrl, persistPath, { openchamberVersion, replace = false, gitBinary, gitIdentityId } = {}) => {
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
  return installGuestFromGitSource(gitSource.url, persistPath, { openchamberVersion, replace, gitBinary, ref: gitSource.ref, gitIdentityId });
};

/**
 * `source` is the clone URL without its `#ref` fragment; `ref` is the branch
 * or tag to pin (omitted means the remote default branch). Both are stored
 * as the guest's origin so Settings → Extensions can check for updates later.
 */
export const installGuestFromGitSource = async (source, persistPath, { openchamberVersion, replace = false, gitBinary, ref, gitIdentityId, lookup } = {}) => {
  const origin = { url: source };
  if (ref) origin.ref = ref;
  if (gitIdentityId) origin.gitIdentityId = gitIdentityId;
  return installCopiedGuest({
    source: 'git',
    persistPath,
    openchamberVersion,
    replace,
    origin,
    prepare: async (staging) => {
      const cloned = await cloneGitRepository(source, staging, { gitBinary, ref, gitIdentityId, lookup });
      return cloned.ok ? { ok: true, root: staging } : cloned;
    },
  });
};

export const installGuest = async (request, persistPath, { openchamberVersion, gitBinary } = {}) => {
  const replace = Boolean(request.replace);
  if (request.url) {
    return installGuestFromUrl(request.url, persistPath, { openchamberVersion, replace, gitBinary, gitIdentityId: request.gitIdentityId });
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

  let removedRoot = null;
  await updateExtensionStore(persistPath, async (stored) => {
    const kept = [];
    const sources = {};
    const gitOrigins = {};
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
    const capabilityScopes = { ...(stored.capabilityScopes ?? {}) };
    delete capabilityScopes[id];
    const disabledGuests = { ...(stored.disabledGuests ?? {}) };
    delete disabledGuests[id];
    const serviceSocketOverrides = { ...(stored.serviceSocketOverrides ?? {}) };
    delete serviceSocketOverrides[id];
    return { paths: kept, sources, gitOrigins, capabilityGrants, capabilityScopes, disabledGuests, serviceSocketOverrides };
  });
  await stopGuestService(id);
  await removeGuestStorage(persistPath, id);
  if (removedRoot && isCopiedGuestRoot(removedRoot, persistPath)) {
    await fs.rm(removedRoot, { recursive: true, force: true });
  }
  return { ok: true };
};
