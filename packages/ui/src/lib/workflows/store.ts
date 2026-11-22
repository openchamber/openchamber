import React from 'react';
import { create } from 'zustand';

import { useUIStore } from '@/stores/useUIStore';
import { selectWorkflowsShown } from '@/lib/workflows/availability';
import { fetchProjectWorkflowRuns, fetchWorkflowRuns } from './api';
import type { WorkflowRun } from './model';
import { isRunInScope, type WorkflowProjectScope } from './project-scope';


type SessionRuns = {
  status: 'idle' | 'loading' | 'ready' | 'error';
  runs: WorkflowRun[];
};

interface WorkflowRunsState {
  bySession: Record<string, SessionRuns>;
  byDirectory: Record<string, SessionRuns['status']>;
  load: (sessionId: string) => Promise<void>;
  loadDirectory: (directories: readonly string[]) => Promise<void>;
  apply: (run: WorkflowRun) => void;
  remove: (sessionId: string, runId: string) => void;
  reloadLoaded: () => void;
  reset: () => void;
}

const EMPTY_RUNS: WorkflowRun[] = [];

const upsert = (runs: WorkflowRun[], run: WorkflowRun): WorkflowRun[] => {
  const index = runs.findIndex((candidate) => candidate.id === run.id);
  if (index === -1) return [...runs, run].sort((left, right) => left.createdAt - right.createdAt);
  const next = runs.slice();
  next[index] = run;
  return next;
};

export const createWorkflowRunsStore = (
  fetchRuns: (sessionId: string) => Promise<WorkflowRun[]>,
  fetchDirectoryRuns: (directories: readonly string[]) => Promise<WorkflowRun[]> = async () => [],
) => {
  let eventSequence = 0;
  const touchedAt = new Map<string, number>();
  let requestSequence = 0;
  const loadSequence = new Map<string, number>();
  const removed = new Set<string>();

  return create<WorkflowRunsState>((set, get) => ({
    bySession: {},
    byDirectory: {},

    loadDirectory: async (directories) => {
      const key = directories.join('\n');
      set((state) => ({ byDirectory: { ...state.byDirectory, [key]: 'loading' } }));
      try {
        const fetched = await fetchDirectoryRuns(directories);
        for (const run of fetched) {
          if (removed.has(run.id)) continue;
          const held = get().bySession[run.parentSessionId]?.runs.find((candidate) => candidate.id === run.id);
          if (held && (touchedAt.get(run.id) ?? -1) >= 0) continue;
          set((state) => {
            const current = state.bySession[run.parentSessionId];
            return { bySession: { ...state.bySession, [run.parentSessionId]: { status: current?.status ?? 'idle', runs: upsert(current?.runs ?? EMPTY_RUNS, run) } } };
          });
        }
        set((state) => ({ byDirectory: { ...state.byDirectory, [key]: 'ready' } }));
      } catch {
        set((state) => ({ byDirectory: { ...state.byDirectory, [key]: 'error' } }));
      }
    },

    load: async (sessionId) => {
      const startedAt = eventSequence;
      requestSequence += 1;
      const request = requestSequence;
      loadSequence.set(sessionId, request);
      const before = get().bySession[sessionId];
      set((state) => ({ bySession: { ...state.bySession, [sessionId]: { status: 'loading', runs: before?.runs ?? EMPTY_RUNS } } }));
      try {
        const fetched = await fetchRuns(sessionId);
        if (loadSequence.get(sessionId) !== request) return;
        const held = get().bySession[sessionId]?.runs ?? EMPTY_RUNS;
        let runs = fetched.filter((run) => !removed.has(run.id));
        for (const run of held) {
          if ((touchedAt.get(run.id) ?? -1) > startedAt) runs = upsert(runs, run);
        }
        set((state) => ({ bySession: { ...state.bySession, [sessionId]: { status: 'ready', runs } } }));
      } catch {
        if (loadSequence.get(sessionId) !== request) return;
        set((state) => ({ bySession: { ...state.bySession, [sessionId]: { status: 'error', runs: state.bySession[sessionId]?.runs ?? EMPTY_RUNS } } }));
      }
    },

    apply: (run) => {
      if (removed.has(run.id)) return;
      eventSequence += 1;
      touchedAt.set(run.id, eventSequence);
      set((state) => {
        const current = state.bySession[run.parentSessionId];
        return {
          bySession: {
            ...state.bySession,
            [run.parentSessionId]: { status: current?.status ?? 'idle', runs: upsert(current?.runs ?? EMPTY_RUNS, run) },
          },
        };
      });
    },

    remove: (sessionId, runId) => {
      removed.add(runId);
      touchedAt.delete(runId);
      set((state) => {
        const current = state.bySession[sessionId];
        if (!current) return state;
        return { bySession: { ...state.bySession, [sessionId]: { ...current, runs: current.runs.filter((run) => run.id !== runId) } } };
      });
    },

    reloadLoaded: () => {
      if (!selectWorkflowsShown(useUIStore.getState())) {
        set((state) => ({
          bySession: Object.fromEntries(Object.entries(state.bySession).map(([id, entry]) => [id, { ...entry, status: 'idle' as const }])),
          byDirectory: Object.fromEntries(Object.keys(state.byDirectory).map((key) => [key, 'idle' as const])),
        }));
        return;
      }
      for (const [sessionId, entry] of Object.entries(get().bySession)) {
        if (entry.status !== 'idle') void get().load(sessionId);
      }
      for (const [key, status] of Object.entries(get().byDirectory)) {
        if (status !== 'idle') void get().loadDirectory(key.split('\n'));
      }
    },

    reset: () => {
      touchedAt.clear();
      loadSequence.clear();
      removed.clear();
      set({ bySession: {}, byDirectory: {} });
    },
  }));
};

export const useWorkflowRunsStore = createWorkflowRunsStore(fetchWorkflowRuns, fetchProjectWorkflowRuns);

export const useSessionWorkflowRuns = (sessionId: string | null): WorkflowRun[] => {
  const available = useUIStore(selectWorkflowsShown);
  const runs = useWorkflowRunsStore((state) => (sessionId ? state.bySession[sessionId]?.runs : undefined) ?? EMPTY_RUNS);
  const load = useWorkflowRunsStore((state) => state.load);

  React.useEffect(() => {
    if (!available || !sessionId) return;
    const current = useWorkflowRunsStore.getState().bySession[sessionId]?.status;
    if (current === 'ready' || current === 'loading') return;
    void load(sessionId);
  }, [available, load, sessionId]);

  return available ? runs : EMPTY_RUNS;
};

export const useWorkflowRun = (sessionId: string | null, runId: string | null): WorkflowRun | null => {
  const runs = useSessionWorkflowRuns(sessionId);
  return React.useMemo(() => (runId ? runs.find((run) => run.id === runId) ?? null : null), [runId, runs]);
};

export const useProjectWorkflowRuns = (scope: WorkflowProjectScope | null): WorkflowRun[] => {
  const available = useUIStore(selectWorkflowsShown);
  const bySession = useWorkflowRunsStore((state) => state.bySession);
  const loadDirectory = useWorkflowRunsStore((state) => state.loadDirectory);
  const key = scope ? scope.directories.join('\n') : '';

  React.useEffect(() => {
    if (!available || !key) return;
    const current = useWorkflowRunsStore.getState().byDirectory[key];
    if (current === 'ready' || current === 'loading') return;
    void loadDirectory(key.split('\n'));
  }, [available, key, loadDirectory]);

  return React.useMemo(() => {
    if (!available || !scope) return EMPTY_RUNS;
    const runs = Object.values(bySession).flatMap((entry) => entry.runs.filter((run) => isRunInScope(run.directory, scope)));
    return runs.length === 0 ? EMPTY_RUNS : runs.sort((left, right) => left.createdAt - right.createdAt);
  }, [available, bySession, scope]);
};
