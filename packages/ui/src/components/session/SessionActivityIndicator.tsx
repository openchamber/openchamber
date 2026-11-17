import React from 'react';
import { Icon } from '@/components/icon/Icon';
import { Spinner } from '@/components/ui/spinner';
import type { IconName } from '@/components/icon/icons';
import { useI18n } from '@/lib/i18n';
import { Tooltip, TooltipContent, TooltipTrigger } from '@/components/ui/tooltip';
import { useSessionDisplayStore } from '@/stores/useSessionDisplayStore';
import { cn } from '@/lib/utils';

type SessionActivityIndicatorState = 'running' | 'workflow' | 'subagent' | 'shell' | 'image' | 'pullRequest' | 'extensionWait' | 'unread';

const PRESENTATION = {
  running: { icon: 'circle', colorClass: 'text-status-info', labelKey: 'sessions.sidebar.session.status.active' },
  workflow: { icon: 'flow-chart', colorClass: 'text-status-info', labelKey: 'sessions.sidebar.session.status.workflowRunning' },
  subagent: { icon: 'robot-2', colorClass: 'text-status-info', labelKey: 'sessions.sidebar.session.status.backgroundSubagent' },
  shell: { icon: 'terminal', colorClass: 'text-status-info', labelKey: 'sessions.sidebar.session.status.backgroundCommand' },
  image: { icon: 'image', colorClass: 'text-status-info', labelKey: 'sessions.sidebar.session.status.backgroundImage' },
  pullRequest: { icon: 'circle', colorClass: 'text-status-info', labelKey: 'sessions.sidebar.session.status.waitingOnPullRequest' },
  extensionWait: { icon: 'timer', colorClass: 'text-status-info', labelKey: 'sessions.sidebar.session.status.waitingOnExtension' },
  unread: { icon: 'checkbox-circle', colorClass: 'text-status-success', labelKey: 'sessions.sidebar.session.status.unread' },
} as const satisfies Record<SessionActivityIndicatorState, { icon: IconName; colorClass: string; labelKey: string }>;

export const SessionActivityIndicator: React.FC<{
  state: SessionActivityIndicatorState;
  className?: string;
  runningClassName?: string;
  tooltip?: boolean;
}> = ({ state, className, runningClassName, tooltip = false }) => {
  const { t } = useI18n();
  const animated = useSessionDisplayStore((s) => s.animatedActivityIndicators);
  const presentation = PRESENTATION[state];
  const label = t(presentation.labelKey);
  const running = state !== 'unread';

  const mark = (
    <span
      className={cn('inline-flex shrink-0 items-center justify-center', className)}
      aria-label={label}
      title={tooltip ? undefined : label}
      data-session-activity-indicator={state}
    >
      {running && animated ? (
        <Spinner className="h-3 w-3 text-status-info" />
      ) : (
        <Icon
          name={presentation.icon}
          className={cn('h-3 w-3', presentation.colorClass, running && runningClassName)}
        />
      )}
    </span>
  );
  if (!tooltip) return mark;
  return (
    <Tooltip>
      <TooltipTrigger asChild>{mark}</TooltipTrigger>
      <TooltipContent side="top" sideOffset={6}>{label}</TooltipContent>
    </Tooltip>
  );
};
