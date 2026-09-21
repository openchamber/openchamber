import { create } from 'zustand';
import { persist } from 'zustand/middleware';
import { getRuntimeKey } from '@/lib/runtime-switch';
import { createDeferredSafeJSONStorage } from './utils/safeStorage';

const GIT_BASE_BRANCH_STORAGE_KEY = 'openchamber.git-base-branch';
const MAX_BASE_BRANCH_ENTRIES = 100;

/**
 * Build the persisted override key for one branch of one repository.
 *
 * The branch is part of the identity on purpose: a base picked for one feature
 * branch is not an answer for a different branch of the same repository, and a
 * directory-only key would silently shadow reflog detection after checkout.
 * Keys include the runtime identity so a remote runtime's paths never shadow
 * local ones.
 */
export const gitBaseBranchEntryKey = (directory: string, branch: string): string =>
  JSON.stringify([getRuntimeKey(), directory, branch]);

type GitBaseBranchState = {
  overrides: Record<string, string>;
  getOverride: (directory: string, branch: string) => string | null;
  setOverride: (directory: string, branch: string, base: string) => void;
  clearOverride: (directory: string, branch: string) => void;
};

/**
 * Explicit per-branch base choices for the "Branch" diff scope.
 *
 * Git does not record a parent branch for every branch (clones, detached
 * starts). When no authoritative source exists, the user picks a base once and
 * the choice is remembered for that branch.
 */
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
