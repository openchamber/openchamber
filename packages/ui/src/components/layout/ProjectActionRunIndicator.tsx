import React from 'react';
import { Icon } from '@/components/icon/Icon';
import { cn } from '@/lib/utils';
import type { ProjectActionRun } from './useProjectActionsRunner';

/**
 * What acting on the action does next: stop it, wait for it, or, with `showIdle`, run it.
 * `large` draws the wider play and stop glyphs, which match the outline icons
 * beside them in the header; the regular ones sit next to text in menus.
 */
export const ProjectActionRunIndicator: React.FC<{ run: ProjectActionRun | null; showIdle?: boolean; large?: boolean; className?: string }> = ({ run, showIdle = false, large = false, className }) => {
  if (run?.status === 'stopping' || run?.status === 'waiting-for-preview') {
    return <Icon name="loader-4" className={cn('size-4 shrink-0 animate-spin text-[var(--status-warning)]', className)} />;
  }
  if (run) {
    return <Icon name={large ? 'stop-large' : 'stop'} className={cn('size-4 shrink-0 text-[var(--status-warning)]', className)} />;
  }
  return showIdle ? <Icon name={large ? 'play-large' : 'play'} className={cn('size-4 shrink-0', className)} /> : null;
};
