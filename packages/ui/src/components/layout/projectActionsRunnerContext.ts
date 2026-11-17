import React from 'react';
import type { ProjectActionsRunner } from './useProjectActionsRunner';

export const ProjectActionsRunnerContext = React.createContext<ProjectActionsRunner | null>(null);

export const useProjectActions = (): ProjectActionsRunner | null => React.useContext(ProjectActionsRunnerContext);

export const useObserveProjectActionRuns = (enabled: boolean): void => {
  const observe = useProjectActions()?.observe;
  React.useEffect(() => (enabled && observe ? observe() : undefined), [enabled, observe]);
};
