import React from 'react';
import { useProjectActionsContext } from '@/hooks/useProjectActionsContext';
import { useDraftSpaceTarget } from '@/lib/spaces/useDraftSpaceTarget';
import { ProjectActionsScope } from './ProjectActionsScope';

/**
 * One runner for the current session's project, shared by the Work Status row,
 * the project actions dialog and the command palette. It lives above all of
 * them, so a run keeps its output watch while the Work Status card is hidden.
 * A draft waiting for a new space runs its actions in the space, and none
 * until the space runs.
 */
export const ProjectActionsProvider: React.FC<{ children: React.ReactNode }> = ({ children }) => {
  const context = useProjectActionsContext();
  const draftSpace = useDraftSpaceTarget();
  const projectRef = draftSpace?.kind === 'preparing' ? null : context?.projectRef ?? null;
  const directory = draftSpace?.kind === 'ready' ? draftSpace.directory : context?.directory ?? '';
  return (
    <ProjectActionsScope projectRef={projectRef} directory={directory}>
      {children}
    </ProjectActionsScope>
  );
};
