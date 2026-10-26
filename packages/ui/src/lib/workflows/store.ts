import React from 'react';
import { create } from 'zustand';

import { useUIStore } from '@/stores/useUIStore';
import { fetchProjectWorkflowRuns, fetchWorkflowRuns } from './api';
import type { WorkflowRun } from './model';
import { isRunInScope, type WorkflowProjectScope } from './project-scope';

/**
 * Workflow runs per session, as the chat card and the work-status panel show
 * them. A session's list is read once from the server; after that the
 * server's `openchamber:workflow-run` events keep each run current.
 *
 * A failed read never blanks runs already held: it leaves them and records the
 * error, so the card of a running workflow does not vanish over a hiccup.
 */

type SessionRuns = {
  status: 'idle' | 'loading' | 'ready' | 'error';
  runs: WorkflowRun[];
};

interface WorkflowRunsState {
  bySession: Record<string, SessionRuns>;
  /** Projects whose runs of every session were read, for the panel's project view, by their folders joined. */
  byDirectory: Record<string, SessionRuns['status']>;
  load: (sessionId: string) => Promise<void>;
  loadDirectory: (directories: readonly string[]) => Promise<void>;
  apply: (run: WorkflowRun) => void;
  /** Drops a run the user deleted. */
  remove: (sessionId: string, runId: string) => void;
  /** Reads again every session a surface has asked about, after a gap in events. */
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

/**
 * A store over `fetchRuns`; the app's one reads the OpenChamber server, tests
 * pass their own.
 */
export const createWorkflowRunsStore = (
  fetchRuns: (sessionId: string) => Promise<WorkflowRun[]>,
  fetchDirectoryRuns: (directories: readonly string[]) => Promise<WorkflowRun[]> = async () => [],
) => {
  // Event order: a run an event touched after a read started is newer than
  // what that read returns, so the read keeps it.
  let eventSequence = 0;
  const touchedAt = new Map<string, number>();
  // Each session's newest read. The counter never restarts, so a read that
  // was on its way when the runtime changed can never pass for a newer one.
  let requestSequence = 0;
  const loadSequence = new Map<string, number>();
  // Run ids never come back, so a deleted one stays out of every later read,
  // including one that was on its way when it was deleted.
  const removed = new Set<string>();

  return create<WorkflowRunsState>((set, get) => ({
    bySession: {},
    byDirectory: {},

    // Merged run by run, like events: a session's own read or an event that
    // lands meanwhile is not undone, and a deleted run stays out.
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

/**
 * The workflow runs of a session, read from the server the first time a
 * surface asks. Empty in builds without workflows.
 */
export const useSessionWorkflowRuns = (sessionId: string | null): WorkflowRun[] => {
  const available = useUIStore((state) => state.agentWorkflowFeatureAvailable);
  const runs = useWorkflowRunsStore((state) => (sessionId ? state.bySession[sessionId]?.runs : undefined) ?? EMPTY_RUNS);
  const load = useWorkflowRunsStore((state) => state.load);

  // Read when a surface first shows the session, and again on the next mount
  // after a failed read; while a read runs or after one landed, events and
  // reconnects keep the list current.
  React.useEffect(() => {
    if (!available || !sessionId) return;
    const current = useWorkflowRunsStore.getState().bySession[sessionId]?.status;
    if (current === 'ready' || current === 'loading') return;
    void load(sessionId);
  }, [available, load, sessionId]);

  return available ? runs : EMPTY_RUNS;
};

/** One run of a session by id, for the chat card of the call that proposed it. */
export const useWorkflowRun = (sessionId: string | null, runId: string | null): WorkflowRun | null => {
  const runs = useSessionWorkflowRuns(sessionId);
  return React.useMemo(() => (runId ? runs.find((run) => run.id === runId) ?? null : null), [runId, runs]);
};

/**
 * The runs of every session in a project (its folder and its worktrees),
 * oldest first, read from the server the first time a surface asks; events
 * keep them current after that. Empty in builds without workflows.
 */
export const useProjectWorkflowRuns = (scope: WorkflowProjectScope | null): WorkflowRun[] => {
  const available = useUIStore((state) => state.agentWorkflowFeatureAvailable);
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
