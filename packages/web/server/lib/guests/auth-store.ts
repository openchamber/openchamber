import fs from 'node:fs/promises';
import path from 'node:path';
import { z } from 'zod';
import { renameWithRetry } from '../shared/atomic-rename.js';
import { readBoundedFile } from '../shared/bounded-file-read.js';

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
  target: z.object({
    apiOrigin: z.string().min(1),
    authorizeUrl: z.string().min(1).optional(),
    tokenUrl: z.string().min(1).optional(),
  }).optional(),
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

export type GuestAuthEntry = z.infer<typeof guestAuthEntrySchema>;
type GuestAuthStore = z.infer<typeof storeSchema>;
type AuthExpectation = ((entry: GuestAuthEntry | null) => boolean) | null;
type AuthPatch = GuestAuthEntry | ((entry: GuestAuthEntry | null) => GuestAuthEntry);
const isAuthPatchFunction = (patch: AuthPatch): patch is (entry: GuestAuthEntry | null) => GuestAuthEntry => typeof patch === 'function';

export const guestAuthPersistPath = (dataDir: string) => {
  const parsed = dataDirSchema.safeParse(dataDir);
  if (!parsed.success) {
    throw new Error('Guest auth needs an absolute OpenChamber data dir');
  }
  return path.join(parsed.data, 'guest-auth.json');
};

const parseStore = (raw: string) => {
  try {
    const parsed = storeSchema.safeParse(JSON.parse(raw));
    return parsed.success ? parsed.data : null;
  } catch {
    return null;
  }
};

/**
 * Read cap for guest-auth.json. A legitimate file holds small bounded
 * records keyed by guest: OAuth client ids/secrets and tokens,
 * settings values of at most 2,000 chars, accounts of at most 200
 * chars. The guest count is not hard-clamped, but even a pathological
 * 1,000 guests at a few KB of records each stays in the low
 * single-digit MB. 8 MiB gives headroom over that while keeping one
 * oversized file from being buffered whole - and a FIFO from wedging
 * the store's serialized write lock, whose reads go through this
 * helper.
 */
export const GUEST_AUTH_STORE_READ_MAX_BYTES = 8 * 1024 * 1024;

export const readGuestAuthStore = async (persistPath: string): Promise<GuestAuthStore> => {
  const result = await readBoundedFile(persistPath, GUEST_AUTH_STORE_READ_MAX_BYTES);
  if (!result.ok) {
    // Missing stays the empty store. An over-cap or non-regular
    // target follows the malformed path (the Invalid throw below):
    // it must never silently read as empty, or the next locked patch
    // would overwrite real OAuth tokens with a fresh store.
    if (result.reason === 'missing') {
      return { guests: {} };
    }
    throw new Error('Invalid guest auth store');
  }
  const raw = result.buffer.toString('utf8');
  const text = raw.replace(/^\uFEFF/, '').trim();
  if (text === '') {
    return { guests: {} };
  }
  const parsed = parseStore(text);
  if (!parsed) {
    throw new Error('Invalid guest auth store');
  }
  return parsed;
};

const writeChains = new Map<string, Promise<unknown>>();
let writeSequence = 0;

const withAuthStoreLock = <T>(persistPath: string, run: () => Promise<T>) => {
  const previous = writeChains.get(persistPath) ?? Promise.resolve();
  const next = previous.catch(() => undefined).then(run);
  const chained = next.finally(() => {
    if (writeChains.get(persistPath) === chained) writeChains.delete(persistPath);
  });
  writeChains.set(persistPath, chained);
  return next;
};

const writeGuestAuthStoreUnlocked = async (store: GuestAuthStore, persistPath: string) => {
  const parsed = storeSchema.safeParse(store);
  if (!parsed.success) {
    throw new Error('Invalid guest auth store');
  }
  await fs.mkdir(path.dirname(persistPath), { recursive: true });
  const tmp = `${persistPath}.tmp-${process.pid}-${Date.now()}-${(writeSequence += 1)}`;
  await fs.writeFile(tmp, `${JSON.stringify(parsed.data, null, 2)}\n`, { encoding: 'utf8', mode: 0o600 });
  await renameWithRetry((from, to) => fs.rename(from, to), tmp, persistPath);
  await fs.chmod(persistPath, 0o600);
};


export const getGuestAuth = async (guestId: string, persistPath: string) => {
  const store = await readGuestAuthStore(persistPath);
  return store.guests[guestId] ?? null;
};

export const patchGuestAuth = (guestId: string, patch: AuthPatch, persistPath: string, expect: AuthExpectation = null) => withAuthStoreLock(persistPath, async () => {
  const store = await readGuestAuthStore(persistPath);
  const current = store.guests[guestId] ?? null;
  if (expect && !expect(current)) {
    return current;
  }
  const next: GuestAuthEntry = { ...(current ?? {}) };
  const resolvedPatch = isAuthPatchFunction(patch) ? patch(current) : patch;
  for (const [key, value] of Object.entries(resolvedPatch)) {
    if (value === undefined) {
      Reflect.deleteProperty(next, key);
    } else {
      Reflect.set(next, key, value);
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

export const dropGuestTokens = async (guestId: string, persistPath: string, expect: AuthExpectation = null) => {
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

export const forgetGuestAuth = (guestId: string, persistPath: string) => withAuthStoreLock(persistPath, async () => {
  const store = await readGuestAuthStore(persistPath);
  if (!(guestId in store.guests)) {
    return;
  }
  const guests = { ...store.guests };
  delete guests[guestId];
  await writeGuestAuthStoreUnlocked({ ...store, guests }, persistPath);
});
