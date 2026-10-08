import { create } from 'zustand';
import type { PullRequestSource } from '@/lib/diff/pullRequestDiff';

interface PullRequestSelection {
  source: PullRequestSource;
  handoff: PullRequestSource | null;
}

interface PullRequestSelectionState {
  selections: Map<string, PullRequestSelection>;
  /** A pull request another surface asked Changes to show, per directory. */
  diffRequests: Map<string, PullRequestSource>;
  select: (key: string, source: PullRequestSource) => void;
  acceptHandoff: (key: string, source: PullRequestSource) => void;
  /** Each call is a new request, so asking for the same PR again shows it again. */
  requestDiff: (directory: string, source: PullRequestSource) => void;
  /** Drops `source` once Changes has taken it, so it never comes back on another branch. */
  settleDiffRequest: (directory: string, source: PullRequestSource) => void;
}

const remember = (state: PullRequestSelectionState, key: string, selection: PullRequestSelection) => {
  const selections = new Map(state.selections);
  selections.delete(key);
  selections.set(key, selection);
  if (selections.size > 100) {
    const oldest = selections.keys().next().value;
    if (oldest !== undefined) selections.delete(oldest);
  }
  return { selections };
};

// Keys are runtime/directory/branch tuples supplied by usePullRequestComparison.
export const usePullRequestSelectionStore = create<PullRequestSelectionState>((set) => ({
  selections: new Map(),
  diffRequests: new Map(),
  select: (key, source) => set((state) => remember(state, key, { source, handoff: state.selections.get(key)?.handoff ?? null })),
  // A retained request is consumed once even if the walkthrough tab remounts.
  acceptHandoff: (key, source) => set((state) => state.selections.get(key)?.handoff === source
    ? state : remember(state, key, { source, handoff: source })),
  requestDiff: (directory, source) => set((state) => {
    const diffRequests = new Map(state.diffRequests);
    diffRequests.set(directory, { ...source });
    return { diffRequests };
  }),
  settleDiffRequest: (directory, source) => set((state) => {
    if (state.diffRequests.get(directory) !== source) return state;
    const diffRequests = new Map(state.diffRequests);
    diffRequests.delete(directory);
    return { diffRequests };
  }),
}));
