import React from 'react';
import { Icon } from '@/components/icon/Icon';
import { Tooltip, TooltipContent, TooltipTrigger } from '@/components/ui/tooltip';
import { useGoalCheckAvailable, useSessionGoal } from '@/hooks/useSessionGoal';
import { useSessionGoalArmStore } from '@/stores/useSessionGoalArmStore';
import { useUIStore } from '@/stores/useUIStore';
import { SESSION_GOAL_OBJECTIVE_CHAR_LIMIT } from '@/lib/sessionGoalMetadata';
import { sessionGoalStatusColor } from '@/lib/sessionGoalPresentation';
import { SessionGoalDialog } from '@/components/chat/SessionGoalDialog';
import { isVSCodeRuntime } from '@/lib/desktop';
import { useI18n } from '@/lib/i18n';
import { cn } from '@/lib/utils';

interface SessionGoalButtonProps {
  sessionId: string | null;
  directory?: string;
  draftOpen?: boolean;
  footerIconButtonClass: string;
  iconSizeClass: string;
  withTooltip?: boolean;
}

export const SessionGoalButton: React.FC<SessionGoalButtonProps> = React.memo(({
  sessionId,
  directory,
  draftOpen = false,
  footerIconButtonClass,
  iconSizeClass,
  withTooltip = false,
}) => {
  const { t } = useI18n();
  const { goal, enabled } = useSessionGoal(sessionId ?? '', directory);
  const armed = useSessionGoalArmStore((state) => state.armed);
  const setArmed = useSessionGoalArmStore((state) => state.setArmed);
  const [dialogOpen, setDialogOpen] = React.useState(false);
  const canCheck = useGoalCheckAvailable(directory, !isVSCodeRuntime() && enabled);
  const cannotCheck = !canCheck && !goal;

  if (isVSCodeRuntime() || !enabled || (!sessionId && !draftOpen)) {
    return null;
  }

  const liveGoal = goal && goal.status !== 'complete' ? goal : null;
  const isEngaged = armed || Boolean(liveGoal);

  const iconColor = goal
    ? sessionGoalStatusColor[goal.status]
    : (armed ? 'var(--status-info)' : undefined);

  const label = goal
    ? t('chat.goal.button.manageAria')
    : cannotCheck
      ? t('chat.goal.button.noSmallModel')
      : (armed ? t('chat.goal.button.disarmAria') : t('chat.goal.button.armAria'));

  const handleClick = () => {
    if (goal) {
      setDialogOpen(true);
      return;
    }
    if (cannotCheck) {
      useUIStore.getState().openSettingsAt('sessions', 'sessions.small-model');
      return;
    }
    setArmed(!armed);
  };

  const button = (
    <button
      type="button"
      className={cn(footerIconButtonClass, cannotCheck && 'opacity-50')}
      style={iconColor ? { color: iconColor } : undefined}
      onClick={handleClick}
      onMouseDown={(event) => {
        if (!goal) event.preventDefault();
      }}
      onPointerDownCapture={(event) => {
        if (!goal && event.pointerType === 'touch') {
          event.preventDefault();
        }
      }}
      aria-label={label}
      aria-pressed={isEngaged}
      {...(withTooltip ? {} : { title: label })}
    >
      {isEngaged || goal ? (
        <Icon name="target-fill" className={cn(iconSizeClass, 'text-current')} aria-hidden="true" />
      ) : (
        <Icon name="target" className={cn(iconSizeClass, 'text-current')} aria-hidden="true" />
      )}
    </button>
  );

  return (
    <>
      {withTooltip ? (
        <Tooltip>
          <TooltipTrigger asChild>{button}</TooltipTrigger>
          <TooltipContent side="top" sideOffset={6}>{label}</TooltipContent>
        </Tooltip>
      ) : button}
      {sessionId ? (
        <SessionGoalDialog open={dialogOpen} onOpenChange={setDialogOpen} sessionId={sessionId} directory={directory} />
      ) : null}
    </>
  );
});

SessionGoalButton.displayName = 'SessionGoalButton';

interface SessionGoalObjectiveCounterProps {
  length: number;
}

export const SessionGoalObjectiveCounter: React.FC<SessionGoalObjectiveCounterProps> = React.memo(({ length }) => {
  const { t } = useI18n();
  const armed = useSessionGoalArmStore((state) => state.armed);

  if (!armed || length === 0) {
    return null;
  }

  const over = length > SESSION_GOAL_OBJECTIVE_CHAR_LIMIT;
  return (
    <span
      className={cn(
        'flex-shrink-0 self-center typography-micro tabular-nums',
        over ? 'text-[var(--status-error)]' : 'text-muted-foreground',
      )}
      aria-label={t('chat.goal.counter.aria')}
      title={t('chat.goal.counter.aria')}
    >
      {length}/{SESSION_GOAL_OBJECTIVE_CHAR_LIMIT}
    </span>
  );
});

SessionGoalObjectiveCounter.displayName = 'SessionGoalObjectiveCounter';
