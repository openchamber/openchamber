import React from 'react';
import { Button } from '@/components/ui/button';
import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/dialog';
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
} from '@/components/ui/dropdown-menu';
import { Textarea } from '@/components/ui/textarea';
import { NumberInput } from '@/components/ui/number-input';
import { toast } from '@/components/ui';
import { Checkbox } from '@/components/ui/checkbox';
import { Icon } from '@/components/icon/Icon';
import { useGoalCheckAvailable, useGoalObjectiveContent, useSessionGoal } from '@/hooks/useSessionGoal';
import { formatGoalTokens } from '@/lib/sessionGoalMetadata';
import { sessionGoalStatusColor, sessionGoalStatusLabelKey } from '@/lib/sessionGoalPresentation';
import { clearSessionGoal } from '@/lib/sessionGoalActions';
import { startGoalEdit } from '@/lib/goalEdit';
import type { GoalWriterChoice } from '@/lib/goalWriter';
import { useI18n } from '@/lib/i18n';
import { MobileOverlayPanel } from '@/components/ui/MobileOverlayPanel';
import { useUIStore } from '@/stores/useUIStore';
import { useMessageQueueStore } from '@/stores/messageQueueStore';
import { useGoalEditStore, type GoalEditDelivery, type GoalEditDraft } from '@/stores/useGoalEditStore';
import { useGlobalSessionStatusStore } from '@/sync/global-session-status';
import { resolveSessionWriterModel } from '@/components/chat/goalWriterContext';
import { GoalWriterPicker } from '@/components/chat/GoalWriterPicker';
import { recordGoalWriterChoice } from '@/lib/modelChoices';
import { useGoalWriterDefault } from '@/hooks/useGoalWriterDefault';
import { GoalVersionHistory } from '@/components/chat/GoalVersionHistory';

interface SessionGoalDialogProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  sessionId: string;
  directory?: string;
  /** An edit that did not land, brought back by the card above the composer. */
  initialDraft?: GoalEditDraft;
}

// Create/manage dialog for the session goal: objective + optional token
// budget on creation; status, usage, the checking model and lifecycle actions
// (pause/resume/complete/clear) once a goal exists.
//
// The shell stays mounted with the composer and the work status panel, while
// the session record it would read is replaced on every streamed step. Every
// goal read lives in `SessionGoalDialogBody`, which mounts only while the
// dialog is open (or animating closed), so a closed dialog does no work.
export function SessionGoalDialog({ open, onOpenChange, sessionId, directory, initialDraft }: SessionGoalDialogProps) {
  const isMobile = useUIStore((state) => state.isMobile);

  // Mobile renders the shared bottom-sheet overlay instead of a centered
  // dialog — same pattern as model controls and the session status panel.
  // The overlay renders nothing while closed, so the body mounts with it.
  if (isMobile) {
    return open ? <SessionGoalDialogBody mobile onOpenChange={onOpenChange} sessionId={sessionId} directory={directory} initialDraft={initialDraft} /> : null;
  }

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      {/* Goals get long: the window resizes from its corner, and the
          objective field grows with it. Only opacity and scale animate, so a
          resize follows the pointer instead of easing behind it. */}
      <DialogContent className="w-[32rem] max-w-[calc(100vw-2rem)] min-w-[20rem] min-h-[18rem] resize transition-[opacity,transform,filter]">
        <SessionGoalDialogBody mobile={false} onOpenChange={onOpenChange} sessionId={sessionId} directory={directory} initialDraft={initialDraft} />
      </DialogContent>
    </Dialog>
  );
}

interface SessionGoalDialogBodyProps extends Omit<SessionGoalDialogProps, 'open'> {
  mobile: boolean;
}

const sessionModelOf = (sessionId: string): { providerID: string; modelID: string } | null => {
  const { providerID, modelID } = resolveSessionWriterModel(sessionId);
  return providerID && modelID ? { providerID, modelID } : null;
};

const writerLabelOf = (choice: GoalWriterChoice | null): string | null => (
  choice ? `${choice.providerID}/${choice.modelID}${choice.variant ? ` · ${choice.variant}` : ''}` : null
);

function SessionGoalDialogBody({ mobile, onOpenChange, sessionId, directory, initialDraft }: SessionGoalDialogBodyProps) {
  const { t } = useI18n();
  const { goal } = useSessionGoal(sessionId, directory);
  const objectiveContent = useGoalObjectiveContent(sessionId, goal);
  // Creating a goal needs something to check its progress; managing an existing one does not.
  const cannotCheck = !useGoalCheckAvailable(directory, true) && !goal;
  const rewriteAll = useUIStore((state) => state.sessionGoalRewriteAll);
  const charLimit = useUIStore((state) => state.sessionGoalObjectiveCharLimit);
  const followUpBehavior = useMessageQueueStore((state) => state.followUpBehavior);
  const busy = useGlobalSessionStatusStore((state) => state.activeSessionIds.has(sessionId));
  const writerDefault = useGoalWriterDefault();
  const [sessionModel] = React.useState(() => sessionModelOf(sessionId));

  // The body mounts on open, so the form seeds once: from an edit that did
  // not land (or was cancelled), else from the goal. Live goal updates while
  // it is open must not clobber the user's edits.
  const [seed] = React.useState<GoalEditDraft | null>(() => initialDraft ?? useGoalEditStore.getState().drafts[sessionId] ?? null);
  React.useEffect(() => {
    if (seed) useGoalEditStore.getState().clearDraft(sessionId);
  }, [seed, sessionId]);
  const [objective, setObjective] = React.useState(() => (
    seed?.objective ?? (goal?.objectiveFile ? (objectiveContent ?? '') : (goal?.objective ?? ''))
  ));
  const [budgetEnabled, setBudgetEnabled] = React.useState(() => Boolean(seed ? seed.tokenBudget : goal?.tokenBudget));
  const [tokenBudget, setTokenBudget] = React.useState<number>(() => seed?.tokenBudget ?? goal?.tokenBudget ?? 200_000);
  const [ignoreLimit, setIgnoreLimit] = React.useState(() => seed?.ignoreLimit ?? goal?.ignoreObjectiveLimit ?? false);
  const [writer, setWriter] = React.useState<GoalWriterChoice | null>(() => seed?.writer ?? null);
  const [message, setMessage] = React.useState(() => seed?.message ?? '');
  const [delivery, setDelivery] = React.useState<GoalEditDelivery>(() => seed?.delivery ?? followUpBehavior);
  const [busyAction, setBusyAction] = React.useState(false);
  // Prior spec versions (#1830): shown in place of the objective field, so the
  // dialog keeps its size and the list mounts only while it is open.
  const [showVersions, setShowVersions] = React.useState(false);

  // File-backed objectives fetch async — the content usually lands right
  // after the dialog opens. Late-seed the textarea only while it is still
  // untouched so a slow fetch never clobbers the user's typing.
  React.useEffect(() => {
    if (seed || !goal?.objectiveFile || objectiveContent === null) return;
    setObjective((current) => (current === '' ? objectiveContent : current));
  }, [seed, goal?.objectiveFile, objectiveContent]);

  const trimmedObjective = objective.trim();
  const trimmedMessage = message.trim();
  const savedObjective = goal?.objectiveFile ? (objectiveContent ?? '') : (goal?.objective ?? '');
  const objectiveChanged = trimmedObjective !== savedObjective;
  const budgetValue = budgetEnabled ? tokenBudget : null;
  const budgetChanged = budgetValue !== (goal?.tokenBudget ?? null);
  const limitChanged = ignoreLimit !== (goal?.ignoreObjectiveLimit ?? false);
  // A completed goal is read-only: remove it and arm a new one instead of
  // "saving" over the outcome (re-saving used to spawn a fresh active goal
  // that the auditor instantly re-completed — a confusing status flash).
  const isCompleted = goal?.status === 'complete';
  const canSave = !isCompleted && !cannotCheck && trimmedObjective.length > 0
    && (!goal || objectiveChanged || budgetChanged || limitChanged || trimmedMessage.length > 0);
  // "Rewrite every goal" applies to a typed objective, not to a budget-only edit.
  const rewrites = rewriteAll && !cannotCheck && !isCompleted && (!goal || objectiveChanged);
  const overLimit = !ignoreLimit && objective.length > charLimit;

  // The save runs after the dialog closes; the card above the composer shows
  // it and can cancel it or bring the edit back here.
  const handleSave = () => {
    // The pick only writes when the objective is rewritten.
    if (rewrites && writer) {
      recordGoalWriterChoice({ writer, writerDefault, sessionModel, inputLength: trimmedObjective.length });
    }
    startGoalEdit({
      sessionId,
      directory,
      draft: { objective: trimmedObjective, tokenBudget: budgetValue, ignoreLimit, writer, message: trimmedMessage, delivery },
      existing: goal,
      rewrite: rewrites,
      sessionModel,
      writerLabel: writerLabelOf(writer ?? writerDefault ?? (sessionModel ? { ...sessionModel, variant: null } : null)),
    });
    onOpenChange(false);
  };

  // Restoring an older version puts its text in the objective field as an
  // unsaved edit: the normal Save then records it as a new version, so the
  // restore is reviewable and the past is never rewritten in place.
  const handleRestore = (content: string) => {
    setObjective(content);
    setShowVersions(false);
  };

  const handleClear = async () => {    setBusyAction(true);
    try {
      await clearSessionGoal(sessionId, directory);
      onOpenChange(false);
    } catch (error) {
      console.warn('[session-goal] action failed:', error);
      toast.error(t('chat.goal.toast.actionFailed'));
    } finally {
      setBusyAction(false);
    }
  };

  const title = goal ? t('chat.goal.dialog.titleManage') : t('chat.goal.dialog.titleCreate');
  const saveLabel = trimmedMessage
    ? t('chat.goal.action.saveAndSend')
    : (goal ? t('chat.goal.action.save') : t('chat.goal.action.start'));

  const body = (
        <div className="flex min-h-0 flex-1 flex-col gap-3">
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
              {showVersions ? (
                <GoalVersionHistory
                  sessionId={sessionId}
                  currentObjective={savedObjective}
                  onRestore={handleRestore}
                />
              ) : (
              <div className="flex min-h-0 flex-1 flex-col gap-1">
                <div className="flex items-center justify-between gap-2">
                  <span className="typography-ui-label text-foreground">{t('chat.goal.dialog.objectiveLabel')}</span>
                  <div className="flex items-center gap-1">
                    <span
                      className={overLimit ? 'typography-micro tabular-nums text-status-warning' : 'typography-micro tabular-nums text-muted-foreground/70'}
                      aria-label={t('chat.goal.counter.aria')}
                    >
                      {ignoreLimit ? objective.length : `${objective.length}/${charLimit}`}
                    </span>
                    <Button
                      type="button"
                      variant="ghost"
                      size="sm"
                      className="h-6 gap-1 px-1.5"
                      onClick={() => setShowVersions(true)}
                    >
                      <Icon name="history" className="size-3.5" aria-hidden="true" />
                      {t('chat.goal.versions.open')}
                    </Button>
                    <DropdownMenu>
                      <DropdownMenuTrigger asChild>
                        <Button type="button" variant="ghost" size="sm" className="h-6 w-6 px-0" aria-label={t('chat.goal.dialog.moreAria')}>
                          <Icon name="more-2" className="size-3.5" aria-hidden="true" />
                        </Button>
                      </DropdownMenuTrigger>
                      <DropdownMenuContent align="end">
                        <DropdownMenuItem onClick={() => setIgnoreLimit((value) => !value)} className="flex items-center justify-between gap-4">
                          <span>{t('chat.goal.dialog.ignoreLimit')}</span>
                          {ignoreLimit ? <Icon name="check" className="size-4 text-primary" aria-hidden="true" /> : null}
                        </DropdownMenuItem>
                      </DropdownMenuContent>
                    </DropdownMenu>
                  </div>
                </div>
                <Textarea
                  value={objective}
                  onChange={(event) => setObjective(event.target.value)}
                  placeholder={t('chat.goal.dialog.objectivePlaceholder')}
                  rows={mobile ? 4 : 6}
                  fillContainer={!mobile}
                  outerClassName={mobile ? undefined : 'min-h-0 flex-1'}
                />
                {/* One line kept for it, so the field does not jump as the text crosses the limit. */}
                <p className="min-h-4 truncate typography-micro text-muted-foreground">
                  {overLimit ? t('chat.goal.dialog.overLimit', { limit: charLimit }) : (ignoreLimit ? t('chat.goal.dialog.limitIgnored') : '')}
                </p>
              </div>
              )}

              {rewrites ? (
                <div className="space-y-1">
                  <p className="typography-meta text-muted-foreground">{t('chat.goal.writer.dialog.rewriteOnSave')}</p>
                  <GoalWriterPicker directory={directory} sessionModel={sessionModel} value={writer} onChange={setWriter} />
                </div>
              ) : null}

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

              <div className="space-y-1">
                <div className="flex min-h-7 items-center justify-between gap-2">
                  <span className="typography-ui-label text-foreground">{t('chat.goal.dialog.messageLabel')}</span>
                  {/* Only a working session can take a message two ways; the
                      row keeps its height either way. */}
                  {busy && trimmedMessage ? (
                    <div className="flex items-center gap-1" role="radiogroup" aria-label={t('chat.goal.dialog.deliveryAria')}>
                      {(['steer', 'queue'] as const).map((option) => (
                        <Button
                          key={option}
                          type="button"
                          variant="chip"
                          size="xs"
                          role="radio"
                          aria-checked={delivery === option}
                          aria-pressed={delivery === option}
                          onClick={() => setDelivery(option)}
                        >
                          {option === 'steer' ? t('chat.goal.dialog.deliverySteer') : t('chat.goal.dialog.deliveryQueue')}
                        </Button>
                      ))}
                    </div>
                  ) : null}
                </div>
                <Textarea
                  value={message}
                  onChange={(event) => setMessage(event.target.value)}
                  placeholder={t('chat.goal.dialog.messagePlaceholder')}
                  aria-label={t('chat.goal.dialog.messageLabel')}
                  rows={2}
                />
              </div>
            </>
          )}

          {cannotCheck && (
            <p className="typography-meta text-muted-foreground">{t('chat.goal.dialog.noSmallModel')}</p>
          )}

          <div className="flex items-center gap-2 pt-1">
            {goal && (
              <Button variant="destructive" size="sm" disabled={busyAction} onClick={() => void handleClear()}>
                {t('chat.goal.action.clear')}
              </Button>
            )}
            <div className="flex flex-1 items-center justify-end gap-2">
              <Button variant="ghost" size="sm" disabled={busyAction} onClick={() => onOpenChange(false)}>
                {t('chat.goal.action.cancel')}
              </Button>
              {!isCompleted && (
                <Button size="sm" disabled={busyAction || !canSave} onClick={handleSave}>
                  {saveLabel}
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
