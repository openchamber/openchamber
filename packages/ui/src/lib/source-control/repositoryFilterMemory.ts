import { z } from 'zod';
import type { RepositoryReferenceFilter, RepositoryReferenceKind, RepositorySelector } from '@/lib/api/types';

/**
 * The repository filter (state, people, labels) last used, remembered per
 * resolved repository and tab across reloads. The key carries the host,
 * instance and `owner/repo` the list reads, so a fork clone and its upstream
 * share one entry, as do two clones of the same remote; another repository
 * never sees the labels picked in one. The across-repositories list has no
 * single repository and so no entry.
 */
const STORAGE_KEY = 'openchamber.repositoryFilters.v1';
const MAX_ENTRIES = 500;
const MAX_LABELS = 20;

// One malformed entry is dropped, never the rest. A value's state and people
// must be values this app knows at all; whether the tab offers them is checked
// where the filter is used.
const filterSchema = z.object({
  state: z.enum(['open', 'closed', 'merged', 'all', 'unanswered']),
  people: z.enum(['any', 'assigned', 'created', 'reviewRequested']),
  labels: z.array(z.string()).transform((labels) => {
    const seen = new Set<string>();
    const kept: string[] = [];
    for (const label of labels) {
      const name = label.trim();
      if (!name || seen.has(name)) continue;
      seen.add(name);
      kept.push(name);
      if (kept.length === MAX_LABELS) break;
    }
    return kept;
  }),
});

const storedMemory = z.array(z.tuple([z.string(), filterSchema]).nullable().catch(null))
  .transform((entries) => entries.filter((entry) => entry !== null));

const storage = (): Storage | null => {
  try {
    return window.localStorage;
  } catch {
    return null;
  }
};

const readEntries = (): Array<[string, RepositoryReferenceFilter]> => {
  try {
    const value = storage()?.getItem(STORAGE_KEY);
    const parsed = storedMemory.safeParse(JSON.parse(value ?? '[]'));
    return parsed.success ? parsed.data : [];
  } catch {
    return [];
  }
};

/** `provider\0instance\0owner/repo\0kind`; host and project names are case-insensitive. */
export const repositoryFilterKey = (
  provider: string,
  instance: string,
  project: RepositorySelector,
  kind: RepositoryReferenceKind,
): string => {
  const part = (value: string) => value.trim().toLowerCase();
  return [part(provider), part(instance), `${part(project.owner)}/${part(project.repo)}`, kind].join('\u0000');
};

/** The remembered filter for a key, or null when none or the entry is malformed. */
export const savedRepositoryFilter = (key: string): RepositoryReferenceFilter | null => (
  readEntries().find(([storedKey]) => storedKey === key)?.[1] ?? null
);

/** Remembers a filter for a key; storage failures leave the session unaffected. */
export const rememberRepositoryFilter = (key: string, filter: RepositoryReferenceFilter): void => {
  const parsed = filterSchema.safeParse(filter);
  if (!parsed.success) return;
  try {
    const entries = readEntries().filter(([storedKey]) => storedKey !== key);
    entries.push([key, parsed.data]);
    // The newest entry goes last, so the oldest are the ones trimmed.
    const kept = entries.slice(Math.max(0, entries.length - MAX_ENTRIES));
    storage()?.setItem(STORAGE_KEY, JSON.stringify(kept));
  } catch {
    // Storage full or blocked: the filter still holds for this session.
  }
};
