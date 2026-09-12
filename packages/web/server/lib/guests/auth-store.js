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

export const writeGuestAuthStore = async (store, persistPath) => {
  const parsed = storeSchema.safeParse(store);
  if (!parsed.success) {
    throw new Error('Invalid guest auth store');
  }
  await fs.mkdir(path.dirname(persistPath), { recursive: true });
  const tmp = `${persistPath}.tmp-${process.pid}`;
  await fs.writeFile(tmp, `${JSON.stringify(parsed.data, null, 2)}\n`, { encoding: 'utf8', mode: 0o600 });
  await fs.rename(tmp, persistPath);
  await fs.chmod(persistPath, 0o600);
};

export const getGuestAuth = async (guestId, persistPath) => {
  const store = await readGuestAuthStore(persistPath);
  return store.guests[guestId] ?? null;
};

export const patchGuestAuth = async (guestId, patch, persistPath) => {
  const store = await readGuestAuthStore(persistPath);
  const next = { ...(store.guests[guestId] ?? {}) };
  for (const [key, value] of Object.entries(patch)) {
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
  await writeGuestAuthStore({ guests }, persistPath);
  return guests[guestId] ?? null;
};

export const dropGuestTokens = async (guestId, persistPath) => {
  const current = await getGuestAuth(guestId, persistPath);
  if (!current) {
    return null;
  }
  return patchGuestAuth(guestId, {
    accessToken: undefined,
    refreshToken: undefined,
    tokenType: undefined,
    expiresAt: undefined,
    account: undefined,
    authorizedAt: undefined,
  }, persistPath);
};

/** Drop everything stored for a guest: tokens, client credentials, and settings. Used when the package is removed. */
export const forgetGuestAuth = async (guestId, persistPath) => {
  const store = await readGuestAuthStore(persistPath);
  if (!(guestId in store.guests)) {
    return;
  }
  const guests = { ...store.guests };
  delete guests[guestId];
  await writeGuestAuthStore({ ...store, guests }, persistPath);
};
