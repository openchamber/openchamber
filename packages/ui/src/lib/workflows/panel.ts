import { create } from 'zustand';

import type { ContextPanelMode } from '@/lib/surfaces/modes';
import { useUIStore } from '@/stores/useUIStore';
import { selectWorkflowsShown } from '@/lib/workflows/availability';
import { getWorkflowProjectScope, useWorkflowProjectScope } from './project';
import { isRunInScope } from './project-scope';
import { useSavedWorkflows, useSavedWorkflowsStore } from './saved';
import { useProjectWorkflowRuns, useWorkflowRunsStore } from './store';

interface WorkflowPanelState {
  selectedBySession: Record<string, string>;
  select: (sessionId: string, runId: string) => void;
}

export const useWorkflowPanelStore = create<WorkflowPanelState>((set) => ({
  selectedBySession: {},
  select: (sessionId, runId) => set((state) => ({ selectedBySession: { ...state.selectedBySession, [sessionId]: runId } })),
}));

type PanelTabs = readonly { mode: ContextPanelMode }[];

export const useWorkflowsSurfaceShown = (tabs: PanelTabs, directory: string | null): boolean => {
  const available = useUIStore(selectWorkflowsShown);
  const scope = useWorkflowProjectScope(directory);
  const runs = useProjectWorkflowRuns(scope);
  const saved = useSavedWorkflows(scope?.savedDirectory ?? null);
  return available && (runs.length > 0 || saved.length > 0 || tabs.some((tab) => tab.mode === 'workflows'));
};

export const isWorkflowsSurfaceShown = (tabs: PanelTabs, directory: string | null): boolean => {
  if (!selectWorkflowsShown(useUIStore.getState())) return false;
  if (tabs.some((tab) => tab.mode === 'workflows')) return true;
  const scope = getWorkflowProjectScope(directory);
  if (!scope) return false;
  const hasRun = Object.values(useWorkflowRunsStore.getState().bySession)
    .some((entry) => entry.runs.some((run) => isRunInScope(run.directory, scope)));
  return hasRun || (useSavedWorkflowsStore.getState().byDirectory[scope.savedDirectory]?.length ?? 0) > 0;
};

export const openWorkflowRunInPanel = (directory: string, sessionId: string, runId: string): void => {
  useWorkflowPanelStore.getState().select(sessionId, runId);
  useUIStore.getState().openContextPanelTab(directory, { mode: 'workflows' });
};
