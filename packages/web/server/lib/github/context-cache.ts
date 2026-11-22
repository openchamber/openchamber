import type { ContextScope, PullContext } from './resources.js';

const PR_CONTEXT_CACHE_TTL_MS = 30_000;
const PR_CONTEXT_CACHE_MAX_ENTRIES = 50;

export function createContextCache() {
  const entries = new Map<string, { data: PullContext; includeCheckDetails: boolean; fetchedAt: number; scope: ContextScope }>();
  let epoch = 0;
  return Object.freeze({
    begin: () => epoch,
    read: (key: string, includeCheckDetails: boolean) => {
      const entry = entries.get(key);
      return entry && Date.now() - entry.fetchedAt < PR_CONTEXT_CACHE_TTL_MS && (entry.includeCheckDetails || !includeCheckDetails)
        ? entry.data
        : null;
    },
    store: (key: string, scope: ContextScope, data: PullContext, includeCheckDetails: boolean, started: number) => {
      if (started !== epoch) return;
      entries.delete(key);
      entries.set(key, { data, includeCheckDetails, fetchedAt: data.fetchedAt, scope });
      if (entries.size > PR_CONTEXT_CACHE_MAX_ENTRIES) {
        const oldest = entries.keys().next().value;
        if (oldest !== undefined) entries.delete(oldest);
      }
    },
    invalidate: (scope: Partial<ContextScope>) => {
      epoch += 1;
      // SAFETY: the keys come from the caller's own ContextScope, whose values the cache compares field by field.
      const fields = Object.keys(scope) as (keyof ContextScope)[];
      for (const [key, entry] of entries) {
        if (fields.every((field) => entry.scope[field] === scope[field])) entries.delete(key);
      }
    },
  });
}
