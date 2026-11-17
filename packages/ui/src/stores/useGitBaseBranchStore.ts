import { create } from 'zustand';
import { persist } from 'zustand/middleware';
import { getRuntimeKey } from '@/lib/runtime-switch';
import { createDeferredSafeJSONStorage } from './utils/safeStorage';

const GIT_BASE_BRANCH_STORAGE_KEY = 'openchamber.git-base-branch';
const MAX_BASE_BRANCH_ENTRIES = 100;

export const gitBaseBranchEntryKey = (directory: string, branch: string): string =>
  JSON.stringify([getRuntimeKey(), directory, branch]);

type GitBaseBranchState = {
  overrides: Record<string, string>;
  getOverride: (directory: string, branch: string) => string | null;
  setOverride: (directory: string, branch: string, base: string) => void;
  clearOverride: (directory: string, branch: string) => void;
};

export const useGitBaseBranchStore = create<GitBaseBranchState>()(
  persist(
    (set, get) => ({
      overrides: {},
      getOverride: (directory, branch) => {
        if (!directory || !branch) return null;
        return get().overrides[gitBaseBranchEntryKey(directory, branch)] ?? null;
      },
      setOverride: (directory, branch, base) => {
        if (!directory || !branch || !base) return;
        set((state) => {
          const key = gitBaseBranchEntryKey(directory, branch);
          const entries = Object.entries({ ...state.overrides, [key]: base });
          while (entries.length > MAX_BASE_BRANCH_ENTRIES) {
            entries.shift();
          }
          return { overrides: Object.fromEntries(entries) };
        });
      },
      clearOverride: (directory, branch) => {
        if (!directory || !branch) return;
        set((state) => {
          const key = gitBaseBranchEntryKey(directory, branch);
          if (!(key in state.overrides)) return state;
          const next = { ...state.overrides };
          delete next[key];
          return { overrides: next };
        });
      },
    }),
    {
      name: GIT_BASE_BRANCH_STORAGE_KEY,
      storage: createDeferredSafeJSONStorage(),
      partialize: (state) => ({ overrides: state.overrides }),
    }
  )
);
