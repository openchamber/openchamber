import { create } from 'zustand';
import { persist } from 'zustand/middleware';
import { useShallow } from 'zustand/react/shallow';
import type { GitHubIssueLiveSummary, LinearIssueLiveSummary } from '@/lib/api/types';
import { getRuntimeKey } from '@/lib/runtime-switch';
import { z } from 'zod';
import { trackedItemKey, trackedItemRecordSchema, type TrackedItemState, type TrackedLinearIssue, type TrackedThread } from '@/lib/trackedItems/model';
import { createDeferredSafeJSONStorage } from './utils/safeStorage';
import { getLinkedChangeRequestVisualSummary, type PrVisualSummary } from './useGitHubPrStatusStore';

const STORAGE_KEY = 'openchamber.tracked-items';
// A state older than this is not shown at start; the item reads as unknown
// until the server answers, the same horizon the branch PR badge keeps.
const PERSIST_TTL_MS = 12 * 60 * 60 * 1000;
const MAX_ENTRIES = 300;

const storeKey = (runtimeKey: string, key: string) => `${runtimeKey}|${key}`;

const persistedSchema = z.object({ records: z.record(z.string(), z.object({ item: z.unknown(), state: z.unknown(), fetchedAt: z.unknown() })) });

type TrackedItemsStore = {
  /** What the server last said about each followed item, by runtime and item key. */
  records: Record<string, TrackedItemState>;
  /**
   * Applies records the server sent. A record older than the one held (an
   * interest answer racing a pushed change) is ignored.
   */
  apply: (runtimeKey: string, records: ReadonlyArray<{ key: string; record: TrackedItemState }>) => void;
};

const freshRecords = (records: Record<string, TrackedItemState>): Array<[string, TrackedItemState]> => {
  const cutoff = Date.now() - PERSIST_TTL_MS;
  return Object.entries(records)
    .filter(([, record]) => record.fetchedAt > cutoff)
    .sort(([, left], [, right]) => right.fetchedAt - left.fetchedAt)
    .slice(0, MAX_ENTRIES);
};

export const useTrackedItemsStore = create<TrackedItemsStore>()(persist(
  (set) => ({
    records: {},
    apply: (runtimeKey, incoming) => {
      if (incoming.length === 0) return;
      set((state) => {
        let next: Record<string, TrackedItemState> | null = null;
        for (const { key, record } of incoming) {
          const id = storeKey(runtimeKey, key);
          const current = (next ?? state.records)[id];
          if (current && current.fetchedAt > record.fetchedAt) continue;
          if (current && JSON.stringify(current) === JSON.stringify(record)) continue;
          next = next ?? { ...state.records };
          next[id] = record;
        }
        return next ? { records: next } : state;
      });
    },
  }),
  {
    name: STORAGE_KEY,
    storage: createDeferredSafeJSONStorage<{ records: Record<string, TrackedItemState> }>(),
    version: 1,
    partialize: (state) => ({ records: Object.fromEntries(freshRecords(state.records)) }),
    // Stored data is untrusted: each record is parsed again, and a malformed
    // one is dropped rather than shown.
    merge: (persisted, current) => {
      const stored = persistedSchema.safeParse(persisted);
      const restored: Record<string, TrackedItemState> = {};
      for (const [id, value] of Object.entries(stored.success ? stored.data.records : {})) {
        const separator = id.indexOf('|');
        if (separator <= 0) continue;
        const parsed = trackedItemRecordSchema.parse({ ...value, key: id.slice(separator + 1) });
        if (parsed) restored[id] = parsed.record;
      }
      return { ...current, records: { ...Object.fromEntries(freshRecords(restored)), ...current.records } };
    },
  },
));

/** Live state of each GitHub or GitLab issue, in order; null until known. */
export const useTrackedIssueStates = (items: ReadonlyArray<TrackedThread<'issue'>>): Array<GitHubIssueLiveSummary | null> => {
  const runtimeKey = getRuntimeKey();
  return useTrackedItemsStore(useShallow((state) => items.map((item) => {
    const record = state.records[storeKey(runtimeKey, trackedItemKey(item))];
    return record?.type === 'issue' ? record.state : null;
  })));
};

/** Live state of each Linear issue, in order; null until known. */
export const useTrackedLinearStates = (items: ReadonlyArray<TrackedLinearIssue>): Array<LinearIssueLiveSummary | null> => {
  const runtimeKey = getRuntimeKey();
  return useTrackedItemsStore(useShallow((state) => items.map((item) => {
    const record = state.records[storeKey(runtimeKey, trackedItemKey(item))];
    return record?.type === 'linear' ? record.state : null;
  })));
};

/**
 * Badges of linked pull and merge requests, in order: the same colour and
 * status rule as a branch's PR. Null for one whose state is not known yet.
 */
export const useTrackedPullVisualSummaries = (
  links: ReadonlyArray<{ item: TrackedThread<'pull'>; url: string; title: string }>,
): Array<PrVisualSummary | null> => {
  const runtimeKey = getRuntimeKey();
  return useTrackedItemsStore(useShallow((state) => links.map(({ item, url, title }) => {
    const id = storeKey(runtimeKey, trackedItemKey(item));
    const record = state.records[id];
    if (record?.type !== 'pull' || !record.state) return null;
    const identity = item.provider === 'gitlab'
      ? { provider: 'gitlab' as const, instance: item.instance }
      : { provider: 'github' as const, instance: 'github.com' };
    return getLinkedChangeRequestVisualSummary(id, { owner: item.owner, repo: item.repo, number: item.number, url, title }, record.state, identity);
  })));
};
