import { z } from 'zod';

import { getChatDraftIdentityKey, type ChatDraftIdentity } from '@/lib/chatDraftPersistence';
import { getDeferredSafeStorage } from '@/stores/utils/safeStorage';

/**
 * The names a composer draft had attached. A draft keeps its text across a
 * reload, but its files live only in memory; with these names the composer
 * can still tell a chip whose file is gone from text the user typed in
 * brackets, and draw it as unavailable. Kept apart from the draft text so the
 * draft format stays as it is; bounded like the drafts, oldest out first.
 */

const entrySchema = z.object({ names: z.array(z.string()), touchedAt: z.number() });
const storedSchema = z.record(z.string(), z.unknown());
type Entry = z.infer<typeof entrySchema>;

const STORAGE_KEY = 'openchamber.chatDraftAttachmentNames.v1';
const MAX_DRAFTS = 50;
const storage = getDeferredSafeStorage();

/** The stored entries; an entry that does not parse is left out, and unreadable storage reads as none. */
const readAll = () => {
  let raw: unknown;
  try {
    raw = JSON.parse(storage.getItem(STORAGE_KEY) ?? '{}');
  } catch {
    return new Map<string, Entry>();
  }
  const stored = storedSchema.safeParse(raw);
  if (!stored.success) return new Map<string, Entry>();
  return new Map(Object.entries(stored.data).flatMap(([key, value]) => {
    const entry = entrySchema.safeParse(value);
    return entry.success ? [[key, entry.data] as const] : [];
  }));
};

/** The names this draft has had attached. */
export const readDraftAttachmentNames = (identity: ChatDraftIdentity): string[] => (
  readAll().get(getChatDraftIdentityKey(identity))?.names ?? []
);

/** Adds names to the ones this draft has had attached. */
export const rememberDraftAttachmentNames = (identity: ChatDraftIdentity, names: readonly string[]): void => {
  if (names.length === 0) return;
  const entries = readAll();
  const key = getChatDraftIdentityKey(identity);
  const known = entries.get(key)?.names ?? [];
  const merged = Array.from(new Set([...known, ...names]));
  if (merged.length === known.length && entries.has(key)) return;
  entries.set(key, { names: merged, touchedAt: Date.now() });
  const retained = [...entries]
    .sort((left, right) => right[1].touchedAt - left[1].touchedAt)
    .slice(0, MAX_DRAFTS);
  storage.setItem(STORAGE_KEY, JSON.stringify(Object.fromEntries(retained)));
};
