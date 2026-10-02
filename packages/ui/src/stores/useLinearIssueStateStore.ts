import { create } from 'zustand';
import { useShallow } from 'zustand/react/shallow';
import type { LinearAPI, LinearIssueLiveSummary } from '@/lib/api/types';
import { getRuntimeKey } from '@/lib/runtime-switch';

/** The server answers at most this many identifiers per request. */
const MAX_IDENTIFIERS_PER_REQUEST = 50;

const keyOf = (runtimeKey: string, identifier: string): string => `${runtimeKey}|${identifier.toUpperCase()}`;

type LinearIssueStateStore = {
  /** Live state of linked Linear issues, by runtime and identifier. Runtime-only. */
  summaries: Record<string, LinearIssueLiveSummary>;
  /**
   * Asks Linear about the identifiers not asked within `minAgeMs`. Issues the
   * workspace does not answer for lose their state; a failed request keeps the
   * last known one and waits for the next cadence.
   */
  sync: (identifiers: readonly string[], linear: LinearAPI, minAgeMs: number) => Promise<void>;
  resetForRuntimeSwitch: () => void;
};

const lastAskedAt = new Map<string, number>();
let inFlight = false;
// Asked while a request ran (the sidebar and the Linked section ask at once);
// sent right after it rather than a whole cadence later.
let queued: { identifiers: Set<string>; linear: LinearAPI; minAgeMs: number } | null = null;
let generation = 0;

export const useLinearIssueStateStore = create<LinearIssueStateStore>((set, get) => ({
  summaries: {},
  sync: async (identifiers, linear, minAgeMs) => {
    if (inFlight) {
      queued = {
        identifiers: new Set([...(queued?.identifiers ?? []), ...identifiers]),
        linear,
        minAgeMs: Math.min(queued?.minAgeMs ?? minAgeMs, minAgeMs),
      };
      return;
    }
    const runtimeKey = getRuntimeKey();
    const now = Date.now();
    const due = [...new Set(identifiers.map((identifier) => identifier.toUpperCase()))]
      .filter((identifier) => now - (lastAskedAt.get(keyOf(runtimeKey, identifier)) ?? 0) >= minAgeMs)
      .slice(0, MAX_IDENTIFIERS_PER_REQUEST);
    if (due.length === 0) return;

    for (const identifier of due) lastAskedAt.set(keyOf(runtimeKey, identifier), now);
    inFlight = true;
    const requestGeneration = generation;
    try {
      const result = await linear.issueSummaries(due);
      if (requestGeneration !== generation || !result.connected) return;
      const answered = new Map(result.issues.map((issue) => [issue.identifier.toUpperCase(), issue]));
      set((state) => {
        const summaries = { ...state.summaries };
        for (const identifier of due) {
          const issue = answered.get(identifier);
          if (issue) summaries[keyOf(runtimeKey, identifier)] = issue;
          else delete summaries[keyOf(runtimeKey, identifier)];
        }
        return { summaries };
      });
    } catch (error) {
      console.warn('[linear] could not refresh linked issue states', error);
    } finally {
      inFlight = false;
      const next = queued;
      queued = null;
      if (next && requestGeneration === generation) void get().sync([...next.identifiers], next.linear, next.minAgeMs);
    }
  },
  resetForRuntimeSwitch: () => {
    generation += 1;
    queued = null;
    lastAskedAt.clear();
    set({ summaries: {} });
  },
}));

/** Live state for each identifier, in order; null until known. */
export const useLinearIssueStates = (identifiers: readonly string[]): Array<LinearIssueLiveSummary | null> => {
  const runtimeKey = getRuntimeKey();
  return useLinearIssueStateStore(useShallow((state) => identifiers.map(
    (identifier) => state.summaries[keyOf(runtimeKey, identifier)] ?? null,
  )));
};
