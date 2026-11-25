import crypto from 'node:crypto';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';

import { parseManifestJson } from '@openchamber/sdk/schemas';
import { requestedGuestCapabilities } from '@openchamber/sdk';

import { inspectGuestPackage, invalidateGuestCatalog, listInstalledGuests } from './catalog.js';
import { enterpriseBlockedCapabilities } from './enterprise.js';
import { cloneGitRepository, prepareGuestGitNetwork, runGit, runGitNetwork } from './clone.js';
import { unwrapGuestRoot } from './extract-zip.js';
import { guestCopiesDir, isCopiedGuestRoot, readExtensionStore, withGuestCheckoutLock } from './persist.js';
import { stopGuestService } from './service.js';
import { detachedCheckouts, discardDetached, swapGuestCheckout } from './checkout-swap.js';
import type { AddressLookup } from './clone.js';
import type { GitOrigin } from './persist.js';
import type { GuestRecord } from './contracts.js';

export const UPDATE_CHECK_TTL_MS = 60 * 60 * 1000;
const CHECK_TIMEOUT_MS = 20_000;

const SEMVER = /^(\d+)\.(\d+)\.(\d+)(?:-([0-9A-Za-z.-]+))?(?:\+[0-9A-Za-z.-]+)?$/;

const parseSemver = (value: string) => {
  const match = SEMVER.exec(value.trim());
  if (!match) {
    return null;
  }
  return {
    core: [Number(match[1]), Number(match[2]), Number(match[3])],
    pre: match[4] ? match[4].split('.') : null,
  };
};

const compareIdentifier = (a: string, b: string) => {
  const aNumeric = /^\d+$/.test(a);
  const bNumeric = /^\d+$/.test(b);
  if (aNumeric && bNumeric) {
    return Math.sign(Number(a) - Number(b));
  }
  if (aNumeric) return -1;
  if (bNumeric) return 1;
  return a < b ? -1 : a > b ? 1 : 0;
};

export const compareSemver = (a: string, b: string) => {
  const left = parseSemver(a);
  const right = parseSemver(b);
  if (!left || !right) {
    return null;
  }
  for (let index = 0; index < 3; index += 1) {
    if (left.core[index] !== right.core[index]) {
      return Number(left.core[index]) < Number(right.core[index]) ? -1 : 1;
    }
  }
  if (!left.pre && !right.pre) return 0;
  if (!left.pre) return 1;
  if (!right.pre) return -1;
  const length = Math.min(left.pre.length, right.pre.length);
  for (let index = 0; index < length; index += 1) {
    const order = compareIdentifier(left.pre[index] ?? '', right.pre[index] ?? '');
    if (order !== 0) {
      return order;
    }
  }
  return Math.sign(left.pre.length - right.pre.length);
};

type CheckInput = {
  guest: { version?: string; packageRoot: string };
  origin: GitOrigin;
  gitBinary?: string | undefined;
  timeoutMs?: number;
  lookup?: AddressLookup | undefined;
};
type CheckResult = { available: true; version: string; requested: string[] } | { available: false; version?: string; error?: string };
const inFlightChecks = new Map<string, Promise<CheckResult>>();

export const checkGuestUpdate = (input: CheckInput) => {
  const key = JSON.stringify([input.guest.packageRoot, input.guest.version, input.origin]);
  const running = inFlightChecks.get(key);
  if (running) {
    return running;
  }
  const check = runGuestUpdateCheck(input).finally(() => inFlightChecks.delete(key));
  inFlightChecks.set(key, check);
  return check;
};

const readRemoteManifest = async ({ origin, gitBinary, timeoutMs, lookup }: Omit<CheckInput, 'guest'>) => {
  const network = await prepareGuestGitNetwork(origin.url, { gitIdentityId: origin.gitIdentityId, lookup }).catch(() => null);
  if (!network) return null;
  const cwd = await fs.mkdtemp(path.join(os.tmpdir(), 'openchamber-update-check-')).catch(() => null);
  if (!cwd) return null;
  try {
    const prepared = await runGit(['init', '-q', '--template='], { gitBinary, cwd, timeoutMs });
    if (!prepared.ok) return null;
    const fetched = await runGitNetwork(
      [...network.args, 'fetch', '--depth', '1', '--no-tags', '--', origin.url, origin.ref ?? 'HEAD'],
      { gitBinary, cwd, timeoutMs, env: network.env },
    );
    if (!fetched.ok) return null;
    return await runGit(['show', 'FETCH_HEAD:package.json'], { gitBinary, cwd, timeoutMs, capture: true });
  } finally {
    await discardDetached([cwd]);
  }
};

const runGuestUpdateCheck = async ({ guest, origin, gitBinary, timeoutMs = CHECK_TIMEOUT_MS, lookup }: CheckInput): Promise<CheckResult> => {
  if (!origin?.url) {
    return { available: false, error: 'not-git' };
  }
  if (!guest.version) {
    return { available: false, error: 'invalid-manifest' };
  }
  const shown = await readRemoteManifest({ origin, gitBinary, timeoutMs, lookup });
  if (shown === null) {
    return { available: false, error: 'fetch-failed' };
  }
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

const updateCache = new Map<string, Map<string, { checkedAt: number; version: string | undefined; result: CheckResult }>>();

const cacheFor = (persistPath: string) => {
  let byGuest = updateCache.get(persistPath);
  if (!byGuest) {
    byGuest = new Map();
    updateCache.set(persistPath, byGuest);
  }
  return byGuest;
};

export const clearGuestUpdateCache = (persistPath?: string, guestId?: string) => {
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

export const getCachedGuestUpdate = (persistPath: string, guest: Pick<GuestRecord, 'id' | 'version'>) => {
  const entry = updateCache.get(persistPath)?.get(guest.id);
  return entry?.result.available && entry.version === guest.version ? { version: entry.result.version } : null;
};

export const withGuestUpdate = <T extends GuestRecord>(guest: T, persistPath: string) => {
  const update = getCachedGuestUpdate(persistPath, guest);
  return update ? { ...guest, update } : guest;
};

const isCheckoutUnchanged = async (guest: GuestRecord, origin: GitOrigin, persistPath: string) => {
  const store = await readExtensionStore(persistPath);
  const root = guest.packageRoot;
  const saved = store.gitOrigins[root];
  if (!store.paths.includes(root) || store.sources[root] !== 'git'
    || saved?.url !== origin.url || saved.ref !== origin.ref || saved.gitIdentityId !== origin.gitIdentityId) {
    return false;
  }
  const raw = await fs.readFile(path.join(root, 'package.json'), 'utf8').catch(() => null);
  const current = raw === null ? null : parseManifestJson(raw);
  return !!current?.ok && current.manifest.contributes.panel.id === guest.id && current.version === guest.version;
};

export const checkAllGuestUpdates = async ({ persistPath, force = false, gitBinary, now = Date.now() }: { persistPath: string; force?: boolean; gitBinary?: string; now?: number }) => {
  const guests = await listInstalledGuests({ persistPath });
  const byGuest = cacheFor(persistPath);
  await Promise.all(guests.map(async (guest) => {
    if (guest.source !== 'git' || !guest.gitOrigin) {
      byGuest.delete(guest.id);
      return;
    }
    const cached = byGuest.get(guest.id);
    if (!force && cached && cached.version === guest.version && now - cached.checkedAt < UPDATE_CHECK_TTL_MS) {
      return;
    }
    const result = await checkGuestUpdate({ guest, origin: guest.gitOrigin, gitBinary });
    if (!await isCheckoutUnchanged(guest, guest.gitOrigin, persistPath)) {
      invalidateGuestCatalog(persistPath);
      return;
    }
    if (result.available || result.error !== 'fetch-failed') {
      byGuest.set(guest.id, { checkedAt: now, version: guest.version, result });
    }
  }));
  const updates: Record<string, { version: string }> = {};
  for (const guest of await listInstalledGuests({ persistPath })) {
    const update = getCachedGuestUpdate(persistPath, guest);
    if (update) {
      updates[guest.id] = update;
    }
  }
  return updates;
};

const removeDir = async (dir: string) => {
  await fs.rm(dir, { recursive: true, force: true });
};

type UpdateResult =
  | { ok: true; id: string }
  | { ok: false; code: string; required?: string };

export const updateGuest = async ({ guest, origin, persistPath, openchamberVersion, gitBinary, lookup }: { guest: GuestRecord; origin: GitOrigin | undefined; persistPath: string; openchamberVersion?: string | undefined; gitBinary?: string; lookup?: AddressLookup }): Promise<UpdateResult> => {
  if (guest.source !== 'git' || !origin?.url || !isCopiedGuestRoot(guest.packageRoot, persistPath)) {
    return { ok: false, code: 'not-git' };
  }
  const copies = guestCopiesDir(persistPath);
  await fs.mkdir(copies, { recursive: true });
  const staging = path.join(copies, `.tmp-${guest.id}-${crypto.randomBytes(6).toString('hex')}`);
  let packageRoot;
  try {
    const cloned = await cloneGitRepository(origin.url, staging, { gitBinary, ref: origin.ref, gitIdentityId: origin.gitIdentityId, lookup });
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
    if (inspected.guest.id !== guest.id) {
      await removeDir(staging);
      return { ok: false, code: 'invalid-manifest' };
    }
    if (enterpriseBlockedCapabilities(inspected.guest, { source: 'git', gitUrl: origin.url }).length > 0) {
      await removeDir(staging);
      return { ok: false, code: 'enterprise-mode' };
    }
  } catch {
    await removeDir(staging);
    return { ok: false, code: 'clone-failed' };
  }

  let detached: string[] = [];
  try {
    return await withGuestCheckoutLock<UpdateResult>(persistPath, async () => {
      if (!await isCheckoutUnchanged(guest, origin, persistPath)) return { ok: false, code: 'swap-failed' };
      await stopGuestService(guest.id);
      const swapped = await swapGuestCheckout(guest, copies, packageRoot);
      detached = await detachedCheckouts(copies);
      invalidateGuestCatalog(persistPath);
      if (!swapped) return { ok: false, code: 'swap-failed' };
      clearGuestUpdateCache(persistPath, guest.id);
      return { ok: true, id: guest.id };
    });
  } catch {
    return { ok: false, code: 'swap-failed' };
  } finally {
    await discardDetached([...detached, staging]);
  }
};
