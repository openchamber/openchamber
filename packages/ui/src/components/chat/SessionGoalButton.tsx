import React from 'react';
import { Icon } from '@/components/icon/Icon';
import { Tooltip, TooltipContent, TooltipTrigger } from '@/components/ui/tooltip';
import { Button } from '@/components/ui/button';
import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/dialog';
import { toast } from '@/components/ui';
import { useSessionGoal } from '@/hooks/useSessionGoal';
import { useSessionGoalArmStore } from '@/stores/useSessionGoalArmStore';
import { clearSessionGoal } from '@/lib/sessionGoalActions';
import { isVSCodeRuntime } from '@/lib/desktop';
import { useI18n } from '@/lib/i18n';
import { cn } from '@/lib/utils';

interface SessionGoalButtonProps {
  sessionId: string | null;
  directory?: string;
  /** Session draft is open — the goal arms for the session the draft creates. */
  draftOpen?: boolean;
  footerIconButtonClass: string;
  iconSizeClass: string;
  withTooltip?: boolean;
}

// Composer target button — the goal switch. One tap arms goal mode: the next
// sent prompt becomes the objective (works on drafts too). While a goal is
// live the target stays lit (info while running, success when complete,
// error when blocked / out of budget); tapping again asks to cancel it.
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
  const [confirmOpen, setConfirmOpen] = React.useState(false);
  const [busy, setBusy] = React.useState(false);

  // The goal loop runs in the web server; the VS Code extension only renders
  // goal state. Arming a goal there would create one nothing drives, so the
  // entry point is hidden entirely.
  if (isVSCodeRuntime() || !enabled || (!sessionId && !draftOpen)) {
    return null;
  }

  // A settled goal no longer drives the loop — the button goes back to being
  // an arm switch, while still tinting with the outcome color.
  const liveGoal = goal && goal.status !== 'complete' ? goal : null;
  const isEngaged = armed || Boolean(liveGoal);

  const colorClass = (() => {
    if (goal?.status === 'complete') return 'text-[var(--status-success)]';
    if (goal?.status === 'blocked' || goal?.status === 'budgetLimited') return 'text-[var(--status-error)]';
    if (armed || goal?.status === 'active' || goal?.status === 'paused') return 'text-[var(--status-info)]';
    return '';
  })();

  const label = liveGoal
    ? t('chat.goal.button.cancelAria')
    : (armed ? t('chat.goal.button.disarmAria') : t('chat.goal.button.armAria'));

  const handleClick = () => {
    if (liveGoal) {
      setConfirmOpen(true);
      return;
    }
    setArmed(!armed);
  };

  const handleCancelGoal = async () => {
    if (!sessionId) return;
    setBusy(true);
    try {
      await clearSessionGoal(sessionId, directory);
      setConfirmOpen(false);
    } catch (error) {
      console.warn('[session-goal] cancel failed:', error);
      toast.error(t('chat.goal.toast.actionFailed'));
    } finally {
      setBusy(false);
    }
  };

  const button = (
    <button
      type="button"
      className={cn(footerIconButtonClass, colorClass)}
      onClick={handleClick}
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

      <Dialog open={confirmOpen} onOpenChange={setConfirmOpen}>
        <DialogContent className="max-w-md">
          <DialogHeader>
            <DialogTitle>{t('chat.goal.cancelDialog.title')}</DialogTitle>
          </DialogHeader>
          <div className="space-y-3">
            <p className="typography-ui-label text-muted-foreground">{t('chat.goal.cancelDialog.description')}</p>
            {liveGoal ? (
              <p className="typography-meta text-foreground line-clamp-3">{liveGoal.objective}</p>
            ) : null}
            <div className="flex items-center justify-end gap-2">
              <Button variant="ghost" size="sm" disabled={busy} onClick={() => setConfirmOpen(false)}>
                {t('chat.goal.cancelDialog.keep')}
              </Button>
              <Button variant="destructive" size="sm" disabled={busy} onClick={handleCancelGoal}>
                {t('chat.goal.cancelDialog.confirm')}
              </Button>
            </div>
          </div>
        </DialogContent>
      </Dialog>
    </>
  );
});

SessionGoalButton.displayName = 'SessionGoalButton';
