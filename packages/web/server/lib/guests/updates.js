import crypto from 'node:crypto';
import fs from 'node:fs/promises';
import path from 'node:path';

import { parseManifestJson } from '@openchamber/sdk/schemas';
import { requestedGuestCapabilities } from '@openchamber/sdk';

import { inspectGuestPackage, invalidateGuestCatalog, listInstalledGuests } from './catalog.js';
import { cloneGitRepository, runGit } from './clone.js';
import { unwrapGuestRoot } from './extract-zip.js';
import { guestCopiesDir, isCopiedGuestRoot } from './persist.js';
import { stopGuestService } from './service.js';

/** A remote check runs at most this often per guest unless the user forces it. */
export const UPDATE_CHECK_TTL_MS = 60 * 60 * 1000;
const CHECK_TIMEOUT_MS = 20_000;

const SEMVER = /^(\d+)\.(\d+)\.(\d+)(?:-([0-9A-Za-z.-]+))?(?:\+[0-9A-Za-z.-]+)?$/;

/**
 * @param {string} value
 * @returns {{ core: number[], pre: string[] | null } | null}
 */
const parseSemver = (value) => {
  const match = SEMVER.exec(value.trim());
  if (!match) {
    return null;
  }
  return {
    core: [Number(match[1]), Number(match[2]), Number(match[3])],
    pre: match[4] ? match[4].split('.') : null,
  };
};

const compareIdentifier = (a, b) => {
  const aNumeric = /^\d+$/.test(a);
  const bNumeric = /^\d+$/.test(b);
  if (aNumeric && bNumeric) {
    return Math.sign(Number(a) - Number(b));
  }
  if (aNumeric) return -1;
  if (bNumeric) return 1;
  return a < b ? -1 : a > b ? 1 : 0;
};

/**
 * Semver order: `-1` when `a < b`, `1` when `a > b`, `0` when equal. A
 * prerelease sorts below its release (`1.1.0-beta.1 < 1.1.0`). Build metadata
 * is ignored. Either side not being semver is `null`.
 */
export const compareSemver = (a, b) => {
  const left = parseSemver(a);
  const right = parseSemver(b);
  if (!left || !right) {
    return null;
  }
  for (let index = 0; index < 3; index += 1) {
    if (left.core[index] !== right.core[index]) {
      return left.core[index] < right.core[index] ? -1 : 1;
    }
  }
  if (!left.pre && !right.pre) return 0;
  if (!left.pre) return 1;
  if (!right.pre) return -1;
  const length = Math.min(left.pre.length, right.pre.length);
  for (let index = 0; index < length; index += 1) {
    const order = compareIdentifier(left.pre[index], right.pre[index]);
    if (order !== 0) {
      return order;
    }
  }
  return Math.sign(left.pre.length - right.pre.length);
};

/**
 * Ask the installed clone's remote for its current `package.json` and compare
 * the version with what is on disk. Runs inside the installed copy so the
 * clone's own credentials-free remote is used; nothing is written. Every
 * failure is `{ available: false, error }`; nothing throws to the route.
 *
 * @param {{ guest: { version?: string, packageRoot: string }, origin: { url: string, ref?: string }, gitBinary?: string, timeoutMs?: number }} input
 * @returns {Promise<{ available: true, version: string, requested: string[] } | { available: false, version?: string, error?: string }>}
 */
export const checkGuestUpdate = async ({ guest, origin, gitBinary, timeoutMs = CHECK_TIMEOUT_MS }) => {
  if (!origin?.url) {
    return { available: false, error: 'not-git' };
  }
  if (!guest.version) {
    return { available: false, error: 'invalid-manifest' };
  }
  const cwd = guest.packageRoot;
  const fetched = await runGit(
    ['fetch', '--depth', '1', '--', 'origin', origin.ref ?? 'HEAD'],
    { gitBinary, cwd, timeoutMs },
  );
  if (!fetched.ok) {
    return { available: false, error: 'fetch-failed' };
  }
  const shown = await runGit(['show', 'FETCH_HEAD:package.json'], { gitBinary, cwd, timeoutMs, capture: true });
  if (!shown.ok) {
    return { available: false, error: 'invalid-manifest' };
  }
  const parsed = parseManifestJson(shown.stdout ?? '');
  if (!parsed.ok || !parsed.version) {
    return { available: false, error: 'invalid-manifest' };
  }
  const order = compareSemver(guest.version, parsed.version);
  if (order === null) {
    return { available: false, error: 'invalid-manifest' };
  }
  if (order >= 0) {
    return { available: false, version: parsed.version };
  }
  return {
    available: true,
    version: parsed.version,
    requested: requestedGuestCapabilities(parsed.manifest.contributes),
  };
};

/**
 * Check results per store file, then per guest id. This is memory only and
 * separate from the catalog cache, so a store write (enable, approve) does
 * not throw away an hour-old answer from the network.
 * @type {Map<string, Map<string, { checkedAt: number, result: Awaited<ReturnType<typeof checkGuestUpdate>> }>>}
 */
const updateCache = new Map();

const cacheFor = (persistPath) => {
  let byGuest = updateCache.get(persistPath);
  if (!byGuest) {
    byGuest = new Map();
    updateCache.set(persistPath, byGuest);
  }
  return byGuest;
};

export const clearGuestUpdateCache = (persistPath, guestId) => {
  if (!persistPath) {
    updateCache.clear();
    return;
  }
  if (guestId === undefined) {
    updateCache.delete(persistPath);
    return;
  }
  updateCache.get(persistPath)?.delete(guestId);
};

/** The cached `{ version }` for a guest with a pending update, else `null`. */
export const getCachedGuestUpdate = (persistPath, guestId) => {
  const entry = updateCache.get(persistPath)?.get(guestId);
  return entry?.result.available ? { version: entry.result.version } : null;
};

/** The catalog row plus `update` when the last check found a newer version. */
export const withGuestUpdate = (guest, persistPath) => {
  const update = getCachedGuestUpdate(persistPath, guest.id);
  return update ? { ...guest, update } : guest;
};

/**
 * Check every git install. A guest checked within `UPDATE_CHECK_TTL_MS`
 * answers from the cache unless `force`. Checks run in parallel; one guest's
 * failure never hides another's update.
 *
 * @returns {Promise<Record<string, { version: string }>>} guests with an update
 */
export const checkAllGuestUpdates = async ({ persistPath, force = false, gitBinary, now = Date.now() }) => {
  const guests = await listInstalledGuests({ persistPath });
  const byGuest = cacheFor(persistPath);
  await Promise.all(guests.map(async (guest) => {
    if (guest.source !== 'git' || !guest.gitOrigin) {
      byGuest.delete(guest.id);
      return;
    }
    const cached = byGuest.get(guest.id);
    if (!force && cached && now - cached.checkedAt < UPDATE_CHECK_TTL_MS) {
      return;
    }
    const result = await checkGuestUpdate({ guest, origin: guest.gitOrigin, gitBinary });
    byGuest.set(guest.id, { checkedAt: now, result });
  }));
  /** @type {Record<string, { version: string }>} */
  const updates = {};
  for (const guest of guests) {
    const update = getCachedGuestUpdate(persistPath, guest.id);
    if (update) {
      updates[guest.id] = update;
    }
  }
  return updates;
};

const removeDir = async (dir) => {
  await fs.rm(dir, { recursive: true, force: true });
};

const exists = async (target) => {
  try {
    await fs.lstat(target);
    return true;
  } catch {
    return false;
  }
};

/**
 * Replace the installed git copy with a fresh clone of its origin.
 *
 * The new clone lands in a sibling temp dir and is inspected exactly like an
 * install (manifest, built scripts, engines). Only then is the live folder
 * swapped: current → `.old-<id>`, temp → final, then `.old-<id>` is deleted.
 * A failure before the swap removes the temp dir and leaves the install as
 * it was. A failed second rename moves the old folder back. Grants, tokens,
 * settings, and the paused flag are keyed by guest id, so they survive
 * unchanged; the catalog row for the id is re-read from disk.
 *
 * @returns {Promise<{ ok: true, id: string } | { ok: false, code: string, required?: string }>}
 */
export const updateGuest = async ({ guest, origin, persistPath, openchamberVersion, gitBinary }) => {
  if (guest.source !== 'git' || !origin?.url || !isCopiedGuestRoot(guest.packageRoot, persistPath)) {
    return { ok: false, code: 'not-git' };
  }
  const copies = guestCopiesDir(persistPath);
  await fs.mkdir(copies, { recursive: true });
  const staging = path.join(copies, `.tmp-${guest.id}-${crypto.randomBytes(6).toString('hex')}`);
  let packageRoot;
  try {
    const cloned = await cloneGitRepository(origin.url, staging, { gitBinary, ref: origin.ref });
    if (!cloned.ok) {
      await removeDir(staging);
      return cloned;
    }
    packageRoot = await unwrapGuestRoot(staging);
    const inspected = await inspectGuestPackage(packageRoot, { openchamberVersion });
    if (!inspected.ok) {
      await removeDir(staging);
      return inspected;
    }
    // A repo that now declares a different panel id is not an update of this
    // extension; installing it would orphan grants and tokens under the old id.
    if (inspected.guest.id !== guest.id) {
      await removeDir(staging);
      return { ok: false, code: 'invalid-manifest' };
    }
  } catch {
    await removeDir(staging);
    return { ok: false, code: 'clone-failed' };
  }

  // The service (if running) holds files from the old copy; on Windows that
  // blocks the rename. It restarts on the next call from the new code.
  await stopGuestService(guest.id);

  const dest = guest.packageRoot;
  const old = path.join(copies, `.old-${guest.id}`);
  try {
    await removeDir(old);
    await fs.rename(dest, old);
  } catch {
    await removeDir(staging);
    return { ok: false, code: 'swap-failed' };
  }
  try {
    await fs.rename(packageRoot, dest);
  } catch {
    // Put the previous copy back so the user keeps a working extension.
    try {
      if (!await exists(dest)) {
        await fs.rename(old, dest);
      }
    } catch {
      // Nothing more can be done; the next catalog read omits this guest and
      // the user can reinstall from the same URL.
    }
    await removeDir(staging);
    invalidateGuestCatalog(persistPath);
    return { ok: false, code: 'swap-failed' };
  }
  await removeDir(old);
  if (packageRoot !== staging) {
    await removeDir(staging);
  }
  invalidateGuestCatalog(persistPath);
  clearGuestUpdateCache(persistPath, guest.id);
  return { ok: true, id: guest.id };
};
