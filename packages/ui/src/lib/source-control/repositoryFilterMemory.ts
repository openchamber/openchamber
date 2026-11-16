import { z } from 'zod';
import type { RepositoryReferenceFilter, RepositoryReferenceKind, RepositorySelector } from '@/lib/api/types';

const STORAGE_KEY = 'openchamber.repositoryFilters.v1';
const MAX_ENTRIES = 500;
const MAX_LABELS = 20;
const MAX_LABEL_LENGTH = 256;

export const normalizeLabelFilter = (labels: readonly string[]): string[] => {
  const seen = new Set<string>();
  const kept: string[] = [];
  for (const label of labels) {
    const name = label.trim();
    if (!name || name.length > MAX_LABEL_LENGTH || seen.has(name)) continue;
    seen.add(name);
    kept.push(name);
    if (kept.length === MAX_LABELS) break;
  }
  return kept;
};

const filterSchema = z.object({
  state: z.enum(['open', 'closed', 'merged', 'all', 'unanswered']),
  people: z.enum(['any', 'assigned', 'created', 'reviewRequested']),
  labels: z.array(z.string()).transform((labels) => normalizeLabelFilter(labels)),
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

export const repositoryFilterKey = (
  provider: string,
  instance: string,
  project: RepositorySelector,
  kind: RepositoryReferenceKind,
): string => {
  const part = (value: string) => value.trim().toLowerCase();
  return [part(provider), part(instance), `${part(project.owner)}/${part(project.repo)}`, kind].join('\u0000');
};

export const savedRepositoryFilter = (key: string): RepositoryReferenceFilter | null => (
  readEntries().find(([storedKey]) => storedKey === key)?.[1] ?? null
);

export const rememberRepositoryFilter = (key: string, filter: RepositoryReferenceFilter): void => {
  const parsed = filterSchema.safeParse(filter);
  if (!parsed.success) return;
  try {
    const entries = readEntries().filter(([storedKey]) => storedKey !== key);
    entries.push([key, parsed.data]);
    const kept = entries.slice(Math.max(0, entries.length - MAX_ENTRIES));
    storage()?.setItem(STORAGE_KEY, JSON.stringify(kept));
  // oxlint-disable-next-line no-empty
  } catch {
  }
};
