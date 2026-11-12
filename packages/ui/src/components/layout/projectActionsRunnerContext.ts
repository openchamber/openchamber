import React from 'react';
import type { ProjectActionsRunner } from './useProjectActionsRunner';

export const ProjectActionsRunnerContext = React.createContext<ProjectActionsRunner | null>(null);

/** `null` outside the main layout (VS Code, mini chat), where no actions run. */
export const useProjectActions = (): ProjectActionsRunner | null => React.useContext(ProjectActionsRunnerContext);

/** Keeps run states current while `enabled`; see `ProjectActionsRunner.observe`. */
export const useObserveProjectActionRuns = (enabled: boolean): void => {
  const observe = useProjectActions()?.observe;
  React.useEffect(() => (enabled && observe ? observe() : undefined), [enabled, observe]);
};
