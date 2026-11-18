import React from 'react';
import { useProjectActionsContext } from '@/hooks/useProjectActionsContext';
import { useDraftSpaceTarget } from '@/lib/spaces/useDraftSpaceTarget';
import { ProjectActionsScope } from './ProjectActionsScope';

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
