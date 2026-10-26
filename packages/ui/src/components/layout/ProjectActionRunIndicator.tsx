import React from 'react';
import { Icon } from '@/components/icon/Icon';
import { cn } from '@/lib/utils';
import type { ProjectActionRun } from './useProjectActionsRunner';

/** What acting on the action does next: stop it, wait for it, or, with `showIdle`, run it. */
export const ProjectActionRunIndicator: React.FC<{ run: ProjectActionRun | null; showIdle?: boolean; className?: string }> = ({ run, showIdle = false, className }) => {
  if (run?.status === 'stopping' || run?.status === 'waiting-for-preview') {
    return <Icon name="loader-4" className={cn('size-4 shrink-0 animate-spin text-[var(--status-warning)]', className)} />;
  }
  if (run) {
    return <Icon name="stop" className={cn('size-4 shrink-0 text-[var(--status-warning)]', className)} />;
  }
  return showIdle ? <Icon name="play" className={cn('size-4 shrink-0', className)} /> : null;
};
