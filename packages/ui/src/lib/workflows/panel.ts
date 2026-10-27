import { create } from 'zustand';

import type { ContextPanelMode } from '@/lib/surfaces/modes';
import { useUIStore } from '@/stores/useUIStore';
import { getWorkflowProjectScope, useWorkflowProjectScope } from './project';
import { isRunInScope } from './project-scope';
import { useSavedWorkflows, useSavedWorkflowsStore } from './saved';
import { useProjectWorkflowRuns, useWorkflowRunsStore } from './store';

/**
 * Which run the Workflows panel shows, per session (or per directory where
 * no session is open). Memory only: one the panel has not been pointed at
 * shows its session's newest run, else the project's.
 */
interface WorkflowPanelState {
  selectedBySession: Record<string, string>;
  select: (sessionId: string, runId: string) => void;
}

export const useWorkflowPanelStore = create<WorkflowPanelState>((set) => ({
  selectedBySession: {},
  select: (sessionId, runId) => set((state) => ({ selectedBySession: { ...state.selectedBySession, [sessionId]: runId } })),
}));

type PanelTabs = readonly { mode: ContextPanelMode }[];

/**
 * Whether the rail offers the Workflows panel: in a build with workflows,
 * while the project has a run or a saved workflow, or a Workflows tab is open,
 * so an open panel never loses its icon.
 */
export const useWorkflowsSurfaceShown = (tabs: PanelTabs, directory: string | null): boolean => {
  const available = useUIStore((state) => state.agentWorkflowFeatureAvailable);
  const scope = useWorkflowProjectScope(directory);
  const runs = useProjectWorkflowRuns(scope);
  const saved = useSavedWorkflows(scope?.savedDirectory ?? null);
  return available && (runs.length > 0 || saved.length > 0 || tabs.some((tab) => tab.mode === 'workflows'));
};

/** The same answer outside React, for the surface-switch shortcut. */
export const isWorkflowsSurfaceShown = (tabs: PanelTabs, directory: string | null): boolean => {
  if (!useUIStore.getState().agentWorkflowFeatureAvailable) return false;
  if (tabs.some((tab) => tab.mode === 'workflows')) return true;
  const scope = getWorkflowProjectScope(directory);
  if (!scope) return false;
  const hasRun = Object.values(useWorkflowRunsStore.getState().bySession)
    .some((entry) => entry.runs.some((run) => isRunInScope(run.directory, scope)));
  return hasRun || (useSavedWorkflowsStore.getState().byDirectory[scope.savedDirectory]?.length ?? 0) > 0;
};

/** Shows `runId` in the Workflows panel of `directory`, opening the panel. */
export const openWorkflowRunInPanel = (directory: string, sessionId: string, runId: string): void => {
  useWorkflowPanelStore.getState().select(sessionId, runId);
  useUIStore.getState().openContextPanelTab(directory, { mode: 'workflows' });
};
