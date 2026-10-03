import { create } from 'zustand';
import type { PullRequestSource } from '@/lib/diff/pullRequestDiff';

interface PullRequestSelection {
  source: PullRequestSource;
  handoff: PullRequestSource | null;
}

interface PullRequestSelectionState {
  selections: Map<string, PullRequestSelection>;
  select: (key: string, source: PullRequestSource) => void;
  acceptHandoff: (key: string, source: PullRequestSource) => void;
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
  select: (key, source) => set((state) => remember(state, key, { source, handoff: state.selections.get(key)?.handoff ?? null })),
  // A retained request is consumed once even if the walkthrough tab remounts.
  acceptHandoff: (key, source) => set((state) => state.selections.get(key)?.handoff === source
    ? state : remember(state, key, { source, handoff: source })),
}));
