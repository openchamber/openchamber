import { useTerminalStore } from '@/stores/useTerminalStore';
import type { ProjectActionRun } from './useProjectActionsRunner';

export const useRunStartedByAgent = (run: ProjectActionRun | null): boolean => useTerminalStore((state) => {
  if (!run) return false;
  const purpose = state.getDirectoryState(run.directory)?.tabs.find((tab) => tab.id === run.tabId)?.purpose;
  return purpose?.type === 'project-action' && Boolean(purpose.agentSessionId);
});
