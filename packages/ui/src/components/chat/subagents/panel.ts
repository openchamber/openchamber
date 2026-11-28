import React from 'react';

import type { Session } from '@/lib/opencode/model';
import { isWorkflowAgentSession } from '@/lib/sessionWorkflowMetadata';
import type { WorkflowRun } from '@/lib/workflows/model';
import { useWorkflowRunsStore } from '@/lib/workflows/store';
import { useGlobalSessionsStore } from '@/stores/useGlobalSessionsStore';
import { useUIStore } from '@/stores/useUIStore';
import type { ChildStoreManager } from '@/sync/child-store';
import { useSessionUIStore } from '@/sync/session-ui-store';
import { useSyncRuntime } from '@/sync/sync-context';
import type { State } from '@/sync/types';

export const openSubagentsPanel = (directory: string): void => {
  useUIStore.getState().openContextPanelTab(directory, { mode: 'subagents' });
};

const workflowAgentIdsOf = (runs: readonly WorkflowRun[]): ReadonlySet<string> => (
  new Set(runs.flatMap((run) => run.agents.flatMap((agent) => (agent.sessionId ? [agent.sessionId] : []))))
);

const isSubagentOf = (candidate: Session, sessionId: string, workflowAgentIds: ReadonlySet<string>): boolean => (
  candidate.parentID === sessionId && !workflowAgentIds.has(candidate.id) && !isWorkflowAgentSession(candidate)
);

const hasLiveSubagent = (
  childStores: ChildStoreManager,
  sessionId: string | null,
  workflowAgentIds: ReadonlySet<string>,
): boolean => {
  if (!sessionId) return false;
  for (const store of childStores.children.values()) {
    if (store.getState().session.some((candidate) => isSubagentOf(candidate, sessionId, workflowAgentIds))) {
      return true;
    }
  }
  return false;
};

const hasListedSubagent = (
  state: ReturnType<typeof useGlobalSessionsStore.getState>,
  sessionId: string | null,
  workflowAgentIds: ReadonlySet<string>,
): boolean => {
  if (!sessionId) return false;
  const childIds = state.structure.activeChildrenByParentId.get(sessionId);
  if (!childIds) return false;
  for (const id of childIds) {
    const child = state.entityById.get(id);
    if (child && isSubagentOf(child, sessionId, workflowAgentIds)) return true;
  }
  return false;
};

const EMPTY_RUNS: readonly WorkflowRun[] = [];
const NOOP_UNSUBSCRIBE = () => undefined;

export const useSubagentsSurfaceShown = (): boolean => {
  const sessionId = useSessionUIStore((state) => state.currentSessionId);
  const workflowRuns = useWorkflowRunsStore((state) => (sessionId ? state.bySession[sessionId]?.runs : undefined) ?? EMPTY_RUNS);
  const workflowAgentIds = React.useMemo(() => workflowAgentIdsOf(workflowRuns), [workflowRuns]);
  const listed = useGlobalSessionsStore(React.useCallback(
    (state) => hasListedSubagent(state, sessionId, workflowAgentIds),
    [sessionId, workflowAgentIds],
  ));
  const { childStores } = useSyncRuntime();
  const skipLive = listed || !sessionId;
  const subscribe = React.useCallback(
    (notify: () => void) => (skipLive ? NOOP_UNSUBSCRIBE : childStores.subscribeAllSelected((state: State) => state.session, notify)),
    [childStores, skipLive],
  );
  const getSnapshot = React.useCallback(
    () => (listed ? true : hasLiveSubagent(childStores, sessionId, workflowAgentIds)),
    [childStores, listed, sessionId, workflowAgentIds],
  );
  return React.useSyncExternalStore(subscribe, getSnapshot, getSnapshot);
};

export const isSubagentsSurfaceShown = (childStores: ChildStoreManager): boolean => {
  const sessionId = useSessionUIStore.getState().currentSessionId;
  if (!sessionId) return false;
  const workflowRuns = useWorkflowRunsStore.getState().bySession[sessionId]?.runs ?? [];
  const workflowAgentIds = workflowAgentIdsOf(workflowRuns);
  return hasListedSubagent(useGlobalSessionsStore.getState(), sessionId, workflowAgentIds)
    || hasLiveSubagent(childStores, sessionId, workflowAgentIds);
};
