import React from 'react';
import { Icon } from '@/components/icon/Icon';
import { Tooltip, TooltipContent, TooltipTrigger } from '@/components/ui/tooltip';
import { useGoalCheckAvailable, useSessionGoal } from '@/hooks/useSessionGoal';
import { useSessionGoalArmStore } from '@/stores/useSessionGoalArmStore';
import { useUIStore } from '@/stores/useUIStore';
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

interface SessionGoalWriterButtonProps {
  sessionId: string | null;
  directory?: string;
  draftOpen?: boolean;
  footerIconButtonClass: string;
  iconSizeClass: string;
  withTooltip?: boolean;
}

// The goal writer switch, right of the target. On, an armed message is turned
// into a goal spec by a model before it is sent; off, the message is the goal
// as typed. It belongs to starting a goal, so it shows only while the session
// has none. The choice is a saved setting (Settings → Chat → Goal).
export const SessionGoalWriterButton: React.FC<SessionGoalWriterButtonProps> = React.memo(({
  sessionId,
  directory,
  draftOpen = false,
  footerIconButtonClass,
  iconSizeClass,
  withTooltip = false,
}) => {
  const { t } = useI18n();
  const { goal, enabled } = useSessionGoal(sessionId ?? '', directory);
  const writerEnabled = useUIStore((state) => state.sessionGoalWriterEnabled);
  const rewriteAll = useUIStore((state) => state.sessionGoalRewriteAll);
  const setWriterEnabled = useUIStore((state) => state.setSessionGoalWriterEnabled);
  // Without a progress check no goal can start, so there is nothing to write.
  const canCheck = useGoalCheckAvailable(directory, !isVSCodeRuntime() && enabled && !goal);

  if (isVSCodeRuntime() || !enabled || goal || !canCheck || (!sessionId && !draftOpen)) {
    return null;
  }

  // "Rewrite every goal" writes every spec whatever this switch says.
  const on = writerEnabled || rewriteAll;
  const label = rewriteAll
    ? t('chat.goal.writer.button.forced')
    : (writerEnabled ? t('chat.goal.writer.button.on') : t('chat.goal.writer.button.off'));

  const button = (
    <button
      type="button"
      className={cn(footerIconButtonClass, rewriteAll && 'opacity-50')}
      style={on ? { color: 'var(--status-info)' } : undefined}
      onClick={() => {
        if (!rewriteAll) setWriterEnabled(!writerEnabled);
      }}
      // Same keyboard guard as the target: it is toggled mid-typing.
      onMouseDown={(event) => event.preventDefault()}
      onPointerDownCapture={(event) => {
        if (event.pointerType === 'touch') event.preventDefault();
      }}
      aria-disabled={rewriteAll || undefined}
      aria-label={label}
      aria-pressed={on}
      {...(withTooltip ? {} : { title: label })}
    >
      <Icon name={on ? 'sparkling-fill' : 'sparkling'} className={cn(iconSizeClass, 'text-current')} aria-hidden="true" />
    </button>
  );

  return withTooltip ? (
    <Tooltip>
      <TooltipTrigger asChild>{button}</TooltipTrigger>
      <TooltipContent side="top" sideOffset={6}>{label}</TooltipContent>
    </Tooltip>
  ) : button;
});

SessionGoalWriterButton.displayName = 'SessionGoalWriterButton';

interface SessionGoalObjectiveCounterProps {
  length: number;
}

export const SessionGoalObjectiveCounter: React.FC<SessionGoalObjectiveCounterProps> = React.memo(({ length }) => {
  const { t } = useI18n();
  const armed = useSessionGoalArmStore((state) => state.armed);
  const writerOn = useUIStore((state) => state.sessionGoalWriterEnabled || state.sessionGoalRewriteAll);
  const limit = useUIStore((state) => state.sessionGoalObjectiveCharLimit);

  if (!armed || writerOn || length === 0) {
    return null;
  }

  const over = length > limit;
  return (
    <span
      className={cn(
        'flex-shrink-0 self-center typography-micro tabular-nums',
        over ? 'text-[var(--status-error)]' : 'text-muted-foreground',
      )}
      aria-label={t('chat.goal.counter.aria')}
      title={t('chat.goal.counter.aria')}
    >
      {length}/{limit}
    </span>
  );
});

SessionGoalObjectiveCounter.displayName = 'SessionGoalObjectiveCounter';
