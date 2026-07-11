import { create } from 'zustand';
import { persist } from 'zustand/middleware';
import { createDeferredSafeJSONStorage } from '@/stores/utils/safeStorage';

type AutoReviewPhase = 'waiting_for_reviewer' | 'waiting_for_implementer';
type AutoReviewStatus = 'running' | 'completed' | 'stopped' | 'error';

export type AutoReviewRun = {
  originalSessionID: string;
  reviewSessionID: string;
  directory: string;
  runtimeKey: string;
  status: AutoReviewStatus;
  phase: AutoReviewPhase;
  iteration: number;
  maxIterations: number;
  lastForwardedMessageID?: string;
  expectedAssistantParentID?: string;
  waitAfterCreatedAt?: number;
  error?: string;
};

type AutoReviewState = {
  runsByOriginalSessionID: Record<string, AutoReviewRun>;
  upsertRun: (run: AutoReviewRun) => void;
  updateRun: (originalSessionID: string, updater: (run: AutoReviewRun) => AutoReviewRun) => void;
  stopRun: (originalSessionID: string) => void;
  completeRun: (originalSessionID: string) => void;
  stopRunningRunsForRuntime: (runtimeKey: string) => void;
  isRunningForSession: (sessionID: string) => boolean;
};

export const useAutoReviewStore = create<AutoReviewState>()(
  persist(
    (set, get) => ({
      runsByOriginalSessionID: {},
      upsertRun: (run) => set((state) => ({
        runsByOriginalSessionID: {
          ...state.runsByOriginalSessionID,
          [run.originalSessionID]: run,
        },
      })),
      updateRun: (originalSessionID, updater) => set((state) => {
        const current = state.runsByOriginalSessionID[originalSessionID];
        if (!current) return state;
        return {
          runsByOriginalSessionID: {
            ...state.runsByOriginalSessionID,
            [originalSessionID]: updater(current),
          },
        };
      }),
      stopRun: (originalSessionID) => set((state) => {
        const current = state.runsByOriginalSessionID[originalSessionID];
        if (!current) return state;
        return {
          runsByOriginalSessionID: {
            ...state.runsByOriginalSessionID,
            [originalSessionID]: { ...current, status: 'stopped' },
          },
        };
      }),
      completeRun: (originalSessionID) => set((state) => {
        const current = state.runsByOriginalSessionID[originalSessionID];
        if (!current) return state;
        return {
          runsByOriginalSessionID: {
            ...state.runsByOriginalSessionID,
            [originalSessionID]: { ...current, status: 'completed' },
          },
        };
      }),
      stopRunningRunsForRuntime: (runtimeKey) => set((state) => {
        let changed = false;
        const next = { ...state.runsByOriginalSessionID };
        for (const [sessionID, run] of Object.entries(next)) {
          if (run.runtimeKey === runtimeKey && run.status === 'running') {
            next[sessionID] = { ...run, status: 'stopped' };
            changed = true;
          }
        }
        return changed ? { runsByOriginalSessionID: next } : state;
      }),
      isRunningForSession: (sessionID) => {
        const run = get().runsByOriginalSessionID[sessionID];
        return run?.status === 'running';
      },
    }),
    {
      name: 'auto-review-store',
      storage: createDeferredSafeJSONStorage(),
      partialize: (state) => ({ runsByOriginalSessionID: state.runsByOriginalSessionID }),
    },
  ),
);
