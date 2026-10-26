import React from 'react';
import { Button } from '@/components/ui/button';
import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/dialog';
import { Textarea } from '@/components/ui/textarea';
import { NumberInput } from '@/components/ui/number-input';
import { toast } from '@/components/ui';
import { Checkbox } from '@/components/ui/checkbox';
import { useGoalCheckAvailable, useGoalObjectiveContent, useSessionGoal } from '@/hooks/useSessionGoal';
import {
  formatGoalTokens,
  SESSION_GOAL_OBJECTIVE_CHAR_LIMIT,
} from '@/lib/sessionGoalMetadata';
import { sessionGoalStatusColor, sessionGoalStatusLabelKey } from '@/lib/sessionGoalPresentation';
import { clearSessionGoal, setSessionGoal } from '@/lib/sessionGoalActions';
import { useI18n } from '@/lib/i18n';
import { MobileOverlayPanel } from '@/components/ui/MobileOverlayPanel';
import { useUIStore } from '@/stores/useUIStore';

interface SessionGoalDialogProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  sessionId: string;
  directory?: string;
}

// Create/manage dialog for the session goal: objective + optional token
// budget on creation; status, usage, the checking model and lifecycle actions
// (pause/resume/complete/clear) once a goal exists.
//
// The shell stays mounted with the composer and the work status panel, while
// the session record it would read is replaced on every streamed step. Every
// goal read lives in `SessionGoalDialogBody`, which mounts only while the
// dialog is open (or animating closed), so a closed dialog does no work.
export function SessionGoalDialog({ open, onOpenChange, sessionId, directory }: SessionGoalDialogProps) {
  const isMobile = useUIStore((state) => state.isMobile);

  // Mobile renders the shared bottom-sheet overlay instead of a centered
  // dialog — same pattern as model controls and the session status panel.
  // The overlay renders nothing while closed, so the body mounts with it.
  if (isMobile) {
    return open ? <SessionGoalDialogBody mobile onOpenChange={onOpenChange} sessionId={sessionId} directory={directory} /> : null;
  }

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="max-w-lg">
        <SessionGoalDialogBody mobile={false} onOpenChange={onOpenChange} sessionId={sessionId} directory={directory} />
      </DialogContent>
    </Dialog>
  );
}

interface SessionGoalDialogBodyProps extends Omit<SessionGoalDialogProps, 'open'> {
  mobile: boolean;
}

function SessionGoalDialogBody({ mobile, onOpenChange, sessionId, directory }: SessionGoalDialogBodyProps) {
  const { t } = useI18n();
  const { goal } = useSessionGoal(sessionId, directory);
  const objectiveContent = useGoalObjectiveContent(sessionId, goal);
  // Creating a goal needs something to check its progress; managing an existing one does not.
  const cannotCheck = !useGoalCheckAvailable(directory, true) && !goal;

  // The body mounts on open, so the form seeds from the goal once; live goal
  // updates while it is open must not clobber the user's edits.
  const [objective, setObjective] = React.useState(() => (
    goal?.objectiveFile ? (objectiveContent ?? '') : (goal?.objective ?? '')
  ));
  const [budgetEnabled, setBudgetEnabled] = React.useState(() => Boolean(goal?.tokenBudget));
  const [tokenBudget, setTokenBudget] = React.useState<number>(() => goal?.tokenBudget ?? 200_000);
  const [busy, setBusy] = React.useState(false);

  // File-backed objectives fetch async — the content usually lands right
  // after the dialog opens. Late-seed the textarea only while it is still
  // untouched so a slow fetch never clobbers the user's typing.
  React.useEffect(() => {
    if (!goal?.objectiveFile || objectiveContent === null) return;
    setObjective((current) => (current === '' ? objectiveContent : current));
  }, [goal?.objectiveFile, objectiveContent]);

  const run = React.useCallback(async (action: () => Promise<void>, closeAfter: boolean) => {
    setBusy(true);
    try {
      await action();
      if (closeAfter) onOpenChange(false);
    } catch (error) {
      console.warn('[session-goal] action failed:', error);
      toast.error(t('chat.goal.toast.actionFailed'));
    } finally {
      setBusy(false);
    }
  }, [onOpenChange, t]);

  const trimmedObjective = objective.trim();
  const savedObjective = goal?.objectiveFile ? (objectiveContent ?? '') : (goal?.objective ?? '');
  const objectiveChanged = trimmedObjective !== savedObjective;
  const budgetValue = budgetEnabled ? tokenBudget : null;
  const budgetChanged = budgetValue !== (goal?.tokenBudget ?? null);
  // A completed goal is read-only: remove it and arm a new one instead of
  // "saving" over the outcome (re-saving used to spawn a fresh active goal
  // that the auditor instantly re-completed — a confusing status flash).
  const isCompleted = goal?.status === 'complete';
  const canSave = !isCompleted && !cannotCheck && trimmedObjective.length > 0 && (!goal || objectiveChanged || budgetChanged);

  const handleSave = () => run(
    () => setSessionGoal(sessionId, directory, { objective: trimmedObjective, tokenBudget: budgetValue }, goal),
    true,
  );

  const title = goal ? t('chat.goal.dialog.titleManage') : t('chat.goal.dialog.titleCreate');

  const body = (
        <div className="space-y-3">
          {goal && (
            <div className="space-y-1 p-2 rounded-lg" style={{ backgroundColor: 'var(--surface-elevated)' }}>
              <div className="flex items-center gap-2">
                <span className="h-2 w-2 rounded-full flex-shrink-0" style={{ backgroundColor: sessionGoalStatusColor[goal.status] }} aria-hidden="true" />
                <span className="typography-ui-label text-foreground">{t(sessionGoalStatusLabelKey[goal.status] as never)}</span>
                <span className="typography-meta text-muted-foreground tabular-nums">
                  {goal.tokenBudget
                    ? t('chat.goal.usage.tokensWithBudget', {
                        used: formatGoalTokens(goal.tokensUsed),
                        budget: formatGoalTokens(goal.tokenBudget),
                      })
                    : t('chat.goal.usage.tokens', { used: formatGoalTokens(goal.tokensUsed) })}
                  {' · '}
                  {t('chat.goal.usage.turns', { turns: goal.turnsUsed })}
                </span>
              </div>
              {/* Only failure states carry a reason worth reading; outcomes
                  like "verified by audit" are noise next to the status dot. */}
              {goal.statusReason && (goal.status === 'blocked' || goal.status === 'budgetLimited') ? (
                <p className="typography-meta text-muted-foreground/70">{goal.statusReason}</p>
              ) : null}
              {goal.evaluationProviderID || goal.evaluationModelID ? (
                <div className="flex items-baseline gap-2 typography-meta">
                  <span className="text-muted-foreground/70">{t('chat.goal.dialog.evaluationModelLabel')}</span>
                  <span className="min-w-0 break-all text-foreground">
                    {[goal.evaluationProviderID, goal.evaluationModelID].filter(Boolean).join('/')}
                  </span>
                </div>
              ) : null}
            </div>
          )}

          {isCompleted ? (
            <p className="max-h-48 overflow-y-auto whitespace-pre-wrap break-words typography-meta text-muted-foreground">{objectiveContent ?? goal.objective}</p>
          ) : (
            <>
              <div className="space-y-1">
                <div className="flex items-baseline justify-between gap-2">
                  <span className="typography-ui-label text-foreground">{t('chat.goal.dialog.objectiveLabel')}</span>
                  <span className="typography-micro tabular-nums text-muted-foreground/70" aria-label={t('chat.goal.counter.aria')}>
                    {objective.length}/{SESSION_GOAL_OBJECTIVE_CHAR_LIMIT}
                  </span>
                </div>
                <Textarea
                  value={objective}
                  onChange={(event) => setObjective(event.target.value)}
                  placeholder={t('chat.goal.dialog.objectivePlaceholder')}
                  maxLength={SESSION_GOAL_OBJECTIVE_CHAR_LIMIT}
                  rows={4}
                />
              </div>

              <div className="flex items-center gap-8">
                <div
                  className="flex cursor-pointer items-center gap-2"
                  role="button"
                  tabIndex={0}
                  aria-pressed={budgetEnabled}
                  onClick={() => setBudgetEnabled((value) => !value)}
                  onKeyDown={(event) => {
                    if (event.key === ' ' || event.key === 'Enter') {
                      event.preventDefault();
                      setBudgetEnabled((value) => !value);
                    }
                  }}
                >
                  <Checkbox
                    checked={budgetEnabled}
                    onChange={setBudgetEnabled}
                    ariaLabel={t('chat.goal.dialog.budgetLabel')}
                  />
                  <span className="typography-ui-label text-foreground">{t('chat.goal.dialog.budgetLabel')}</span>
                </div>
                {budgetEnabled && (
                  <NumberInput
                    value={tokenBudget}
                    onValueChange={(value) => setTokenBudget(typeof value === 'number' && value > 0 ? Math.floor(value) : 1000)}
                    min={1000}
                    max={100_000_000}
                    step={50_000}
                  />
                )}
              </div>
            </>
          )}

          {cannotCheck && (
            <p className="typography-meta text-muted-foreground">{t('chat.goal.dialog.noSmallModel')}</p>
          )}

          <div className="flex items-center gap-2 pt-1">
            {goal && (
              <Button variant="destructive" size="sm" disabled={busy} onClick={() => run(() => clearSessionGoal(sessionId, directory), true)}>
                {t('chat.goal.action.clear')}
              </Button>
            )}
            <div className="flex flex-1 items-center justify-end gap-2">
              <Button variant="ghost" size="sm" disabled={busy} onClick={() => onOpenChange(false)}>
                {t('chat.goal.action.cancel')}
              </Button>
              {!isCompleted && (
                <Button size="sm" disabled={busy || !canSave} onClick={handleSave}>
                  {goal ? t('chat.goal.action.save') : t('chat.goal.action.start')}
                </Button>
              )}
            </div>
          </div>
        </div>
  );

  if (mobile) {
    return (
      <MobileOverlayPanel open title={title} onClose={() => onOpenChange(false)}>
        {body}
      </MobileOverlayPanel>
    );
  }

  return (
    <>
      <DialogHeader>
        <DialogTitle>{title}</DialogTitle>
      </DialogHeader>
      {body}
    </>
  );
}
