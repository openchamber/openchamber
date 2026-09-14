import { create } from 'zustand';
import { persist } from 'zustand/middleware';
import { createDeferredSafeJSONStorage } from '@/stores/utils/safeStorage';
import { canonicalizePathIdentity } from '@/lib/pathNormalization';

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

type AutoReviewTarget = {
  sessionId: string;
  directory: string;
  runtimeKey: string;
};

type AutoReviewRunTargetFields = Pick<AutoReviewRun, 'originalSessionID' | 'directory' | 'runtimeKey' | 'status'>;

export const isAutoReviewRunActiveForTarget = (
  run: AutoReviewRunTargetFields | undefined,
  target: AutoReviewTarget,
): boolean => {
  if (
    !run
    || run.status !== 'running'
    || run.originalSessionID !== target.sessionId
    || run.runtimeKey !== target.runtimeKey
  ) {
    return false;
  }

  const runDirectory = canonicalizePathIdentity(run.directory);
  const targetDirectory = canonicalizePathIdentity(target.directory);
  return runDirectory !== null && targetDirectory !== null && runDirectory === targetDirectory;
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
