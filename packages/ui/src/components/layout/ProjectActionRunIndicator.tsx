import React from 'react';
import { Icon } from '@/components/icon/Icon';
import { useI18n } from '@/lib/i18n';
import { cn } from '@/lib/utils';
import type { ProjectActionRun } from './useProjectActionsRunner';
import { useRunStartedByAgent } from './useRunStartedByAgent';

export const ProjectActionRunIndicator: React.FC<{ run: ProjectActionRun | null; showIdle?: boolean; large?: boolean; className?: string }> = ({ run, showIdle = false, large = false, className }) => {
  if (run?.status === 'stopping' || run?.status === 'waiting-for-preview') {
    return <Icon name="loader-4" className={cn('size-4 shrink-0 animate-spin text-[var(--status-warning)]', className)} />;
  }
  if (run) {
    return <Icon name={large ? 'stop-large' : 'stop'} className={cn('size-4 shrink-0 text-[var(--status-error)]', className)} />;
  }
  return showIdle ? <Icon name="play" className={cn('size-4 shrink-0', className)} /> : null;
};

export const ProjectActionAgentBadge: React.FC<{ run: ProjectActionRun | null }> = ({ run }) => {
  const { t } = useI18n();
  const startedByAgent = useRunStartedByAgent(run);
  if (!startedByAgent) return null;
  return (
    <span
      className="shrink-0 typography-micro px-1 rounded leading-none pb-px text-muted-foreground bg-[var(--surface-subtle)]"
      title={t('projectActions.run.startedByAgent')}
    >
      {t('projectActions.menu.agentBadge')}
    </span>
  );
};
