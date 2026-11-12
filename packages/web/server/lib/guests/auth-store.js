import fs from 'node:fs/promises';
import path from 'node:path';
import { z } from 'zod';

const PANEL_ID = /^[a-z][a-z0-9-]*$/;
const SETTING_KEY = /^[a-z][a-z0-9-]*$/;

const guestAuthEntrySchema = z.object({
  clientId: z.string().min(1).optional(),
  clientSecret: z.string().min(1).optional(),
  accessToken: z.string().min(1).optional(),
  refreshToken: z.string().min(1).nullable().optional(),
  tokenType: z.string().min(1).optional(),
  expiresAt: z.number().int().positive().nullable().optional(),
  account: z.string().max(200).optional(),
  settings: z.record(z.string().regex(SETTING_KEY), z.string().max(2000)).optional(),
  authorizedAt: z.number().int().positive().optional(),
  // Where the tokens were minted for. Checked before every use, so a
  // package that moved its API origin or OAuth endpoints cannot receive
  // credentials the user connected for the old ones.
  target: z.object({
    apiOrigin: z.string().min(1),
    authorizeUrl: z.string().min(1).optional(),
    tokenUrl: z.string().min(1).optional(),
  }).optional(),
  // Where the client id and secret were entered for. A package that moved
  // its endpoints gets no client credentials until the user enters them
  // again; they are never carried over.
  clientTarget: z.object({
    apiOrigin: z.string().min(1),
    authorizeUrl: z.string().min(1).optional(),
    tokenUrl: z.string().min(1).optional(),
  }).optional(),
});

const storeSchema = z.object({
  guests: z.record(z.string().regex(PANEL_ID), guestAuthEntrySchema),
});

const dataDirSchema = z.string().min(1).refine((entry) => !entry.includes('\0') && path.isAbsolute(entry));

export const guestAuthPersistPath = (dataDir) => {
  const parsed = dataDirSchema.safeParse(dataDir);
  if (!parsed.success) {
    throw new Error('Guest auth needs an absolute OpenChamber data dir');
  }
  return path.join(parsed.data, 'guest-auth.json');
};

const parseStore = (raw) => {
  try {
    const parsed = storeSchema.safeParse(JSON.parse(raw));
    return parsed.success ? parsed.data : null;
  } catch {
    return null;
  }
};

export const readGuestAuthStore = async (persistPath) => {
  try {
    const raw = await fs.readFile(persistPath, 'utf8');
    const text = raw.replace(/^\uFEFF/, '').trim();
    if (text === '') {
      return { guests: {} };
    }
    const parsed = parseStore(text);
    if (!parsed) {
      throw new Error('Invalid guest auth store');
    }
    return parsed;
  } catch (error) {
    if (error instanceof Error && 'code' in error && error.code === 'ENOENT') {
      return { guests: {} };
    }
    throw error;
  }
};

/** @type {Map<string, Promise<unknown>>} */
const writeChains = new Map();
let writeSequence = 0;

// Two writers at once (a token refresh while a settings field saves) used to
// share one temp file and a stale read: one of them lost. Every change to one
// store file now runs read → change → write as a single step, one after
// another, each on its own temp file.
const withAuthStoreLock = (persistPath, run) => {
  const previous = writeChains.get(persistPath) ?? Promise.resolve();
  const next = previous.catch(() => undefined).then(run);
  const chained = next.finally(() => {
    if (writeChains.get(persistPath) === chained) writeChains.delete(persistPath);
  });
  writeChains.set(persistPath, chained);
  return next;
};

const writeGuestAuthStoreUnlocked = async (store, persistPath) => {
  const parsed = storeSchema.safeParse(store);
  if (!parsed.success) {
    throw new Error('Invalid guest auth store');
  }
  await fs.mkdir(path.dirname(persistPath), { recursive: true });
  const tmp = `${persistPath}.tmp-${process.pid}-${Date.now()}-${(writeSequence += 1)}`;
  await fs.writeFile(tmp, `${JSON.stringify(parsed.data, null, 2)}\n`, { encoding: 'utf8', mode: 0o600 });
  await fs.rename(tmp, persistPath);
  await fs.chmod(persistPath, 0o600);
};


export const getGuestAuth = async (guestId, persistPath) => {
  const store = await readGuestAuthStore(persistPath);
  return store.guests[guestId] ?? null;
};

/**
 * Apply `patch` to one guest's entry, read and written under the store lock.
 * With `expect`, the patch only lands when the entry read under the lock
 * satisfies it; a caller that spent a network round trip on the old entry
 * (a token refresh) uses this to drop its result when the entry moved on.
 * `patch` may be a function of the entry read under the lock, for a change
 * that depends on what is there (a client id replacing another one).
 * Returns the entry as stored afterwards, or `null` when it is gone.
 */
export const patchGuestAuth = (guestId, patch, persistPath, expect = null) => withAuthStoreLock(persistPath, async () => {
  const store = await readGuestAuthStore(persistPath);
  const current = store.guests[guestId] ?? null;
  if (expect && !expect(current)) {
    return current;
  }
  const next = { ...(current ?? {}) };
  const resolvedPatch = typeof patch === 'function' ? patch(current) : patch;
  for (const [key, value] of Object.entries(resolvedPatch)) {
    if (value === undefined) {
      delete next[key];
    } else {
      next[key] = value;
    }
  }
  const guests = { ...store.guests };
  const empty = !next.clientId
    && !next.clientSecret
    && !next.accessToken
    && !next.refreshToken
    && (!next.settings || Object.keys(next.settings).length === 0);
  if (empty) {
    delete guests[guestId];
  } else {
    guests[guestId] = next;
  }
  await writeGuestAuthStoreUnlocked({ guests }, persistPath);
  return guests[guestId] ?? null;
});

/**
 * Forget the tokens. With `expect`, only when the entry read under the lock
 * still holds the tokens the caller is reacting to; a caller that saw a 401
 * on one access token must not erase a newer connection made meanwhile.
 */
export const dropGuestTokens = async (guestId, persistPath, expect = null) => {
  const current = await getGuestAuth(guestId, persistPath);
  if (!current) {
    return null;
  }
  return patchGuestAuth(guestId, {
    accessToken: undefined,
    refreshToken: undefined,
    target: undefined,
    tokenType: undefined,
    expiresAt: undefined,
    account: undefined,
    authorizedAt: undefined,
  }, persistPath, expect);
};

/** Drop everything stored for a guest: tokens, client credentials, and settings. Used when the package is removed. */
export const forgetGuestAuth = (guestId, persistPath) => withAuthStoreLock(persistPath, async () => {
  const store = await readGuestAuthStore(persistPath);
  if (!(guestId in store.guests)) {
    return;
  }
  const guests = { ...store.guests };
  delete guests[guestId];
  await writeGuestAuthStoreUnlocked({ ...store, guests }, persistPath);
});
