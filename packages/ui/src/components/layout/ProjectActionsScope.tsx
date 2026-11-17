import React from 'react';
import { ProjectActionsRunnerContext } from './projectActionsRunnerContext';
import { useProjectActionsRunner, type ProjectActionsRunnerOptions } from './useProjectActionsRunner';

export const ProjectActionsScope: React.FC<React.PropsWithChildren<ProjectActionsRunnerOptions>> = ({ children, ...options }) => {
  const runner = useProjectActionsRunner(options);
  return <ProjectActionsRunnerContext.Provider value={runner}>{children}</ProjectActionsRunnerContext.Provider>;
};
