import { z } from 'zod';
import type { ChatDraftIdentity } from '@/lib/chatDraftPersistence';
import { getSafeSessionStorage } from '@/stores/utils/safeStorage';

// A send waiting on a background goal has already left its composer. If the
// page goes away before the goal is written (reload), the
// held send is gone with it. This journal keeps the text in storage until the
// send settles, so the next page can put it back in its composer.
//
// Session storage belongs to this tab. A new page can recover entries from
// its predecessor; other tabs cannot claim a running send. A timer is not
// proof a tab stopped: browsers suspend background pages and their timers.

const STORAGE_KEY = 'openchamber.backgroundGoalSends.v1';

const IdentitySchema = z.object({
  runtimeKey: z.string(),
  directory: z.string(),
  sessionId: z.string().nullable(),
});

const EntrySchema = z.object({
  id: z.string(),
  pageId: z.string(),
  identity: IdentitySchema,
  text: z.string(),
  mentions: z.array(z.string()),
});

export type BackgroundSendEntry = z.infer<typeof EntrySchema>;

// A malformed entry is dropped alone; the rest of the journal stays.
const JournalSchema = z.array(z.unknown()).catch([]);

interface JournalStorage {
  getItem: (key: string) => string | null;
  setItem: (key: string, value: string) => void;
  removeItem: (key: string) => void;
}

export interface BackgroundSendJournal {
  /** Keeps a send's text until it settles; returns its entry id. */
  record: (input: { identity: ChatDraftIdentity; text: string; mentions: Iterable<string> }) => string;
  /** The composer the text goes back to changed (a draft became a session). */
  retarget: (id: string, identity: ChatDraftIdentity) => void;
  /** Removes an entry: sent, or restored by this page. */
  remove: (id: string) => BackgroundSendEntry | null;
  /** Removes and returns entries from the previous page in this tab. */
  takeOrphans: () => BackgroundSendEntry[];
}

export function createBackgroundSendJournal(options: {
  storage: JournalStorage;
  pageId: string;
  createId?: () => string;
}): BackgroundSendJournal {
  const { storage, pageId } = options;
  let counter = 0;
  const createId = options.createId ?? (() => `${pageId}:${(counter += 1)}`);

  const parseStored = () => {
    try {
      return JournalSchema.parse(JSON.parse(storage.getItem(STORAGE_KEY) ?? '[]'));
    } catch {
      return [];
    }
  };
  const read = (): BackgroundSendEntry[] => {
    return parseStored().flatMap((item) => {
      const parsed = EntrySchema.safeParse(item);
      return parsed.success ? [parsed.data] : [];
    });
  };
  const write = (entries: BackgroundSendEntry[]) => {
    if (entries.length === 0) storage.removeItem(STORAGE_KEY);
    else storage.setItem(STORAGE_KEY, JSON.stringify(entries));
  };

  return {
    record: ({ identity, text, mentions }) => {
      const id = createId();
      write([...read(), { id, pageId, identity, text, mentions: Array.from(new Set(mentions)) }]);
      return id;
    },
    retarget: (id, identity) => {
      write(read().map((entry) => (entry.id === id ? { ...entry, identity } : entry)));
    },
    remove: (id) => {
      const entries = read();
      const found = entries.find((entry) => entry.id === id) ?? null;
      if (found) write(entries.filter((entry) => entry.id !== id));
      return found;
    },
    takeOrphans: () => {
      const entries = read();
      const orphaned = (entry: BackgroundSendEntry) => entry.pageId !== pageId;
      const orphans = entries.filter(orphaned);
      if (orphans.length > 0) write(entries.filter((entry) => !orphaned(entry)));
      return orphans;
    },
  };
}

const pageId = `${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 10)}`;
export const backgroundSendJournal = createBackgroundSendJournal({ storage: getSafeSessionStorage(), pageId });
