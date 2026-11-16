import { create } from 'zustand';
import type { PullRequestSource } from '@/lib/diff/pullRequestDiff';

interface PullRequestSelection {
  source: PullRequestSource;
  handoff: PullRequestSource | null;
}

interface PullRequestSelectionState {
  selections: Map<string, PullRequestSelection>;
  diffRequests: Map<string, PullRequestSource>;
  changesRepositories: Map<string, string>;
  select: (key: string, source: PullRequestSource) => void;
  acceptHandoff: (key: string, source: PullRequestSource) => void;
  requestDiff: (directory: string, source: PullRequestSource, repository?: string | null) => void;
  clearChangesRepository: (directory: string) => void;
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

export const usePullRequestSelectionStore = create<PullRequestSelectionState>((set) => ({
  selections: new Map(),
  diffRequests: new Map(),
  changesRepositories: new Map(),
  select: (key, source) => set((state) => remember(state, key, { source, handoff: state.selections.get(key)?.handoff ?? null })),
  acceptHandoff: (key, source) => set((state) => state.selections.get(key)?.handoff === source
    ? state : remember(state, key, { source, handoff: source })),
  requestDiff: (directory, source, repository = null) => set((state) => {
    const diffRequests = new Map(state.diffRequests);
    diffRequests.set(directory, { ...source });
    if (!repository && !state.changesRepositories.has(directory)) return { diffRequests };
    const changesRepositories = new Map(state.changesRepositories);
    if (repository) changesRepositories.set(directory, repository);
    else changesRepositories.delete(directory);
    return { diffRequests, changesRepositories };
  }),
  clearChangesRepository: (directory) => set((state) => {
    if (!state.changesRepositories.has(directory)) return state;
    const changesRepositories = new Map(state.changesRepositories);
    changesRepositories.delete(directory);
    return { changesRepositories };
  }),
  settleDiffRequest: (directory, source) => set((state) => {
    if (state.diffRequests.get(directory) !== source) return state;
    const diffRequests = new Map(state.diffRequests);
    diffRequests.delete(directory);
    return { diffRequests };
  }),
}));
