import { create } from 'zustand';
import type { GitLogEntry } from '@/lib/api/types';
import { getRuntimeKey } from '@/lib/runtime-switch';

export const commitSelectionKey = (directory: string, branch: string | null, runtimeKey = getRuntimeKey()): string =>
  JSON.stringify([runtimeKey, directory, branch]);

interface CommitSelectionState {
  selections: Map<string, GitLogEntry>;
  select: (key: string, commit: GitLogEntry) => void;
}

// Shared between Changes and walkthrough. Selections are session-only and the
// branch is part of the key, so a checkout starts with that branch's history.
export const useCommitSelectionStore = create<CommitSelectionState>((set) => ({
  selections: new Map(),
  select: (key, commit) => set((state) => {
    const selections = new Map(state.selections);
    selections.delete(key);
    selections.set(key, commit);
    // Bound remembered choices on explicit selection, never while acquiring a view.
    if (selections.size > 100) {
      const oldest = selections.keys().next().value;
      if (oldest !== undefined) selections.delete(oldest);
    }
    return { selections };
  }),
}));
