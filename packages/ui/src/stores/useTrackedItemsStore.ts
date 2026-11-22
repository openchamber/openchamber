import { create } from 'zustand';
import { persist } from 'zustand/middleware';
import { useShallow } from 'zustand/react/shallow';
import type { DiscussionLiveSummary, IssueLiveSummary, TrackerLiveSummary } from '@/lib/api/types';
import { getRuntimeKey } from '@/lib/runtime-switch';
import { z } from 'zod';
import { trackedItemKey, trackedItemRecordSchema, type TrackedItem, type TrackedItemState, type TrackedThread, type TrackedWorkItem } from '@/lib/trackedItems/model';
import { createDeferredSafeJSONStorage } from './utils/safeStorage';
import { getLinkedChangeRequestVisualSummary, type PrVisualSummary } from './useGitHubPrStatusStore';

const STORAGE_KEY = 'openchamber.tracked-items';
const PERSIST_TTL_MS = 12 * 60 * 60 * 1000;
const MAX_ENTRIES = 300;

const storeKey = (runtimeKey: string, key: string) => `${runtimeKey}|${key}`;

const persistedSchema = z.object({ records: z.record(z.string(), z.object({ item: z.unknown(), state: z.unknown(), fetchedAt: z.unknown() })) });

type TrackedItemsStore = {
  records: Record<string, TrackedItemState>;
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

export const useTrackedRecords = (items: ReadonlyArray<TrackedItem | null>): Array<TrackedItemState | null> => {
  const runtimeKey = getRuntimeKey();
  return useTrackedItemsStore(useShallow((state) => items.map((item) => (
    item ? state.records[storeKey(runtimeKey, trackedItemKey(item))] ?? null : null
  ))));
};

type TrackedRecords = TrackedItemsStore['records'];

const DISCUSSION_ISSUE_STATES = {
  open: 'open',
  resolved: 'completed',
  outdated: 'not_planned',
  duplicate: 'not_planned',
} as const satisfies Record<DiscussionLiveSummary['state'], IssueLiveSummary['state']>;

const discussionIssueStates = new WeakMap<DiscussionLiveSummary, IssueLiveSummary>();
const discussionAsIssue = (summary: DiscussionLiveSummary): IssueLiveSummary => {
  const known = discussionIssueStates.get(summary);
  if (known) return known;
  const issue: IssueLiveSummary = { owner: summary.owner, repo: summary.repo, number: summary.number, title: summary.title, state: DISCUSSION_ISSUE_STATES[summary.state] };
  discussionIssueStates.set(summary, issue);
  return issue;
};

export const readTrackedIssueState = (records: TrackedRecords, item: TrackedThread<'issue' | 'discussion'>): IssueLiveSummary | null => {
  const record = records[storeKey(getRuntimeKey(), trackedItemKey(item))];
  if (record?.type === 'discussion') return record.state ? discussionAsIssue(record.state) : null;
  return record?.type === 'issue' ? record.state : null;
};

export const readTrackedWorkItemState = (records: TrackedRecords, item: TrackedWorkItem): TrackerLiveSummary | null => {
  const record = records[storeKey(getRuntimeKey(), trackedItemKey(item))];
  return record?.type === 'work-item' ? record.state : null;
};

export const readTrackedPullVisualSummary = (
  records: TrackedRecords,
  { item, url, title }: { item: TrackedThread<'pull'>; url: string; title: string },
): PrVisualSummary | null => {
  const id = storeKey(getRuntimeKey(), trackedItemKey(item));
  const record = records[id];
  if (record?.type !== 'pull' || !record.state) return null;
  return getLinkedChangeRequestVisualSummary(
    id,
    { owner: item.owner, repo: item.repo, number: item.number, url, title },
    record.state,
    { provider: item.provider, instance: item.instance },
  );
};

export const useTrackedIssueStates = (items: ReadonlyArray<TrackedThread<'issue' | 'discussion'>>): Array<IssueLiveSummary | null> => (
  useTrackedItemsStore(useShallow((state) => items.map((item) => readTrackedIssueState(state.records, item))))
);

export const useTrackedWorkItemStates = (items: ReadonlyArray<TrackedWorkItem>): Array<TrackerLiveSummary | null> => (
  useTrackedItemsStore(useShallow((state) => items.map((item) => readTrackedWorkItemState(state.records, item))))
);

export const useTrackedPullVisualSummaries = (
  links: ReadonlyArray<{ item: TrackedThread<'pull'>; url: string; title: string }>,
): Array<PrVisualSummary | null> => (
  useTrackedItemsStore(useShallow((state) => links.map((link) => readTrackedPullVisualSummary(state.records, link))))
);
