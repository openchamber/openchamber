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
import { useSessionGoal } from '@/hooks/useSessionGoal';
import {
  formatGoalTokens,
  SESSION_GOAL_OBJECTIVE_CHAR_LIMIT,
} from '@/lib/sessionGoalMetadata';
import { sessionGoalStatusColor, sessionGoalStatusLabelKey } from '@/lib/sessionGoalPresentation';
import { clearSessionGoal, setSessionGoal, setSessionGoalStatus } from '@/lib/sessionGoalActions';
import { useI18n } from '@/lib/i18n';

interface SessionGoalDialogProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  sessionId: string;
  directory?: string;
}

// Create/manage dialog for the session goal: objective + optional token
// budget on creation; status, usage, latest audit note and lifecycle actions
// (pause/resume/complete/clear) once a goal exists.
export function SessionGoalDialog({ open, onOpenChange, sessionId, directory }: SessionGoalDialogProps) {
  const { t } = useI18n();
  const { goal } = useSessionGoal(sessionId, directory);

  const [objective, setObjective] = React.useState('');
  const [budgetEnabled, setBudgetEnabled] = React.useState(false);
  const [tokenBudget, setTokenBudget] = React.useState<number>(200_000);
  const [busy, setBusy] = React.useState(false);

  React.useEffect(() => {
    if (!open) return;
    setObjective(goal?.objective ?? '');
    setBudgetEnabled(Boolean(goal?.tokenBudget));
    setTokenBudget(goal?.tokenBudget ?? 200_000);
    // Seed the form only when the dialog opens; live goal updates while it is
    // open must not clobber the user's edits.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [open]);

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
  const objectiveChanged = trimmedObjective !== (goal?.objective ?? '');
  const budgetValue = budgetEnabled ? tokenBudget : null;
  const budgetChanged = budgetValue !== (goal?.tokenBudget ?? null);
  const canSave = trimmedObjective.length > 0 && (!goal || objectiveChanged || budgetChanged || goal.status === 'complete');

  const handleSave = () => run(
    () => setSessionGoal(sessionId, directory, { objective: trimmedObjective, tokenBudget: budgetValue }, goal),
    true,
  );

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="max-w-lg">
        <DialogHeader>
          <DialogTitle>{goal ? t('chat.goal.dialog.titleManage') : t('chat.goal.dialog.titleCreate')}</DialogTitle>
        </DialogHeader>

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
              {goal.note ? (
                <p className="typography-meta text-muted-foreground">{goal.note}</p>
              ) : null}
              {goal.statusReason && goal.status !== 'active' ? (
                <p className="typography-meta text-muted-foreground/70">{goal.statusReason}</p>
              ) : null}
            </div>
          )}

          <div className="space-y-1">
            <span className="typography-ui-label text-foreground">{t('chat.goal.dialog.objectiveLabel')}</span>
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

          <div className="flex flex-wrap items-center justify-between gap-2 pt-1">
            <div className="flex items-center gap-2">
              {goal && goal.status === 'active' && (
                <Button variant="outline" size="sm" disabled={busy} onClick={() => run(() => setSessionGoalStatus(sessionId, directory, 'paused'), false)}>
                  {t('chat.goal.action.pause')}
                </Button>
              )}
              {goal && (goal.status === 'paused' || goal.status === 'blocked' || goal.status === 'budgetLimited') && (
                <Button variant="outline" size="sm" disabled={busy} onClick={() => run(() => setSessionGoalStatus(sessionId, directory, 'active'), false)}>
                  {t('chat.goal.action.resume')}
                </Button>
              )}
              {goal && goal.status !== 'complete' && (
                <Button variant="outline" size="sm" disabled={busy} onClick={() => run(() => setSessionGoalStatus(sessionId, directory, 'complete'), false)}>
                  {t('chat.goal.action.markComplete')}
                </Button>
              )}
              {goal && (
                <Button variant="destructive" size="sm" disabled={busy} onClick={() => run(() => clearSessionGoal(sessionId, directory), true)}>
                  {t('chat.goal.action.clear')}
                </Button>
              )}
            </div>
            <div className="flex items-center gap-2">
              <Button variant="ghost" size="sm" disabled={busy} onClick={() => onOpenChange(false)}>
                {t('chat.goal.action.cancel')}
              </Button>
              <Button size="sm" disabled={busy || !canSave} onClick={handleSave}>
                {goal ? t('chat.goal.action.save') : t('chat.goal.action.start')}
              </Button>
            </div>
          </div>
        </div>
      </DialogContent>
    </Dialog>
  );
}
