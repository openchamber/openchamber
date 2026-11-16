import { create } from 'zustand';
import type { GitLogEntry } from '@/lib/api/types';
import { getRuntimeKey } from '@/lib/runtime-switch';

export const commitSelectionKey = (directory: string, branch: string | null, runtimeKey = getRuntimeKey()): string =>
  JSON.stringify([runtimeKey, directory, branch]);

interface CommitSelectionState {
  selections: Map<string, GitLogEntry>;
  select: (key: string, commit: GitLogEntry) => void;
}

export const useCommitSelectionStore = create<CommitSelectionState>((set) => ({
  selections: new Map(),
  select: (key, commit) => set((state) => {
    const selections = new Map(state.selections);
    selections.delete(key);
    selections.set(key, commit);
    if (selections.size > 100) {
      const oldest = selections.keys().next().value;
      if (oldest !== undefined) selections.delete(oldest);
    }
    return { selections };
  }),
}));
