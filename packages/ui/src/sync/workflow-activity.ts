import { create } from 'zustand';

type WorkflowActivityState = { runningSessionIds: ReadonlySet<string> };

const NONE: ReadonlySet<string> = new Set();

export const useWorkflowActivityStore = create<WorkflowActivityState>(() => ({ runningSessionIds: NONE }));

export const setWorkflowRunningSessions = (sessionIds: Iterable<string>): void => {
  const next = new Set(sessionIds);
  const current = useWorkflowActivityStore.getState().runningSessionIds;
  if (next.size === current.size && [...next].every((id) => current.has(id))) return;
  useWorkflowActivityStore.setState({ runningSessionIds: next.size === 0 ? NONE : next });
};
