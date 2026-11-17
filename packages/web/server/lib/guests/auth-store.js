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

export const forgetGuestAuth = (guestId, persistPath) => withAuthStoreLock(persistPath, async () => {
  const store = await readGuestAuthStore(persistPath);
  if (!(guestId in store.guests)) {
    return;
  }
  const guests = { ...store.guests };
  delete guests[guestId];
  await writeGuestAuthStoreUnlocked({ ...store, guests }, persistPath);
});
