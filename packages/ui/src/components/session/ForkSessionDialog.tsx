import React from 'react';
import { Button } from '@/components/ui/button';
import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/dialog';
import { Textarea } from '@/components/ui/textarea';
import { Checkbox } from '@/components/ui/checkbox';
import { ModelSelector } from '@/components/sections/agents/ModelSelector';
import { AgentSelector } from '@/components/sections/commands/AgentSelector';
import { ThinkingPill } from '@/components/session/ThinkingPill';
import { EXECUTION_FORK_DEFAULT_INSTRUCTIONS, EXECUTION_FORK_GOAL_INSTRUCTIONS } from '@/lib/messages/executionMeta';
import { useI18n } from '@/lib/i18n';
import { useInitialSessionOverrides } from '@/hooks/useInitialSessionOverrides';
import { isVSCodeRuntime } from '@/lib/desktop';

export type ForkSessionExecution = {
  providerID: string;
  modelID: string;
  variant: string;
  agent: string;
  instructions: string;
  createWorktree?: boolean;
  runAsGoal?: boolean;
};

type ForkSessionDialogProps = {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  projectDirectory: string | null;
  submitting?: boolean;
  onConfirm: (execution: ForkSessionExecution) => Promise<void> | void;
};

export function ForkSessionDialog(props: ForkSessionDialogProps) {
  const { t } = useI18n();
  const { open, onOpenChange, projectDirectory, submitting = false, onConfirm } = props;

  const [instructions, setInstructions] = React.useState(EXECUTION_FORK_DEFAULT_INSTRUCTIONS);
  const [createWorktree, setCreateWorktree] = React.useState(false);
  const [runAsGoal, setRunAsGoal] = React.useState(false);
  const showCreateWorktree = React.useMemo(() => !isVSCodeRuntime(), []);
  // The goal loop lives in the web server; VS Code only renders goal state.
  const showRunAsGoal = React.useMemo(() => !isVSCodeRuntime(), []);

  // Toggling goal mode swaps the prefilled instructions between the
  // report-back default and the assertive execute-to-completion variant —
  // but never clobbers text the user has edited.
  const handleToggleRunAsGoal = React.useCallback((next: boolean) => {
    setRunAsGoal(next);
    setInstructions((current) => {
      if (next && current === EXECUTION_FORK_DEFAULT_INSTRUCTIONS) return EXECUTION_FORK_GOAL_INSTRUCTIONS;
      if (!next && current === EXECUTION_FORK_GOAL_INSTRUCTIONS) return EXECUTION_FORK_DEFAULT_INSTRUCTIONS;
      return current;
    });
  }, []);

  // Shared session-override state (providers/agents loading, default prefill,
  // provider/model fallback, variant reset, agent filter). See
  // packages/ui/src/hooks/useInitialSessionOverrides.ts.
  const {
    providerID,
    modelID,
    variant,
    agent,
    setVariant,
    setAgent,
    variantOptions,
    hasVariantOptions,
    agentFilter,
    setProviderAndModel,
  } = useInitialSessionOverrides({
    open,
    projectDirectory,
    source: 'forkSessionDialog',
  });

  // Reset dialog-local state when the dialog opens.
  // This is a fresh dialog surface each time, so clearing is safe and desired;
  // the user's override choices live inside `useInitialSessionOverrides` and
  // are managed by that hook, not this effect.
  React.useEffect(() => {
    if (!open) return;
    setInstructions(EXECUTION_FORK_DEFAULT_INSTRUCTIONS);
    setCreateWorktree(false);
    setRunAsGoal(false);
  }, [open]);

  const canConfirm =
    providerID.trim().length > 0 && modelID.trim().length > 0 && instructions.trim().length > 0;

  const handleSubmit = React.useCallback(() => {
    if (!canConfirm || submitting) return;
    void onConfirm({
      providerID,
      modelID,
      variant,
      agent,
      instructions,
      createWorktree: showCreateWorktree && createWorktree,
      runAsGoal: showRunAsGoal && runAsGoal,
    });
  }, [canConfirm, submitting, onConfirm, providerID, modelID, variant, agent, instructions, showCreateWorktree, createWorktree, showRunAsGoal, runAsGoal]);

  React.useEffect(() => {
    if (!open) return;
    const onKeyDown = (event: KeyboardEvent) => {
      if ((event.metaKey || event.ctrlKey) && event.key === 'Enter') {
        event.preventDefault();
        handleSubmit();
      }
    };
    window.addEventListener('keydown', onKeyDown);
    return () => window.removeEventListener('keydown', onKeyDown);
  }, [open, handleSubmit]);

  return (
    <Dialog open={open} onOpenChange={(nextOpen) => { if (!submitting) onOpenChange(nextOpen); }}>
      <DialogContent className="max-w-md overflow-visible">
        <DialogHeader>
          <DialogTitle>{t('chat.messageBody.actions.startNewSession')}</DialogTitle>
        </DialogHeader>

        <div className="flex flex-col gap-4">
          <div className="flex min-w-0 flex-col gap-1.5">
            <span className="typography-meta font-medium text-muted-foreground">{t('chat.modelControls.model')}</span>
            <ModelSelector
              providerId={providerID}
              modelId={modelID}
              className="max-w-[320px] justify-between"
              dropdownPortalToBody
              onChange={setProviderAndModel}
            />
          </div>
          <div className="flex flex-col gap-1.5">
            <span className="typography-meta font-medium text-muted-foreground">{t('sessions.scheduledTasks.editor.thinkingLevel.label')}</span>
            <ThinkingPill
              value={variant}
              options={variantOptions}
              disabled={!hasVariantOptions}
              onChange={setVariant}
            />
          </div>
          <div className="flex flex-col gap-1.5">
            <span className="typography-meta font-medium text-muted-foreground">{t('sessions.scheduledTasks.editor.agent.label')}</span>
            <AgentSelector
              agentName={agent}
              filter={agentFilter}
              dropdownPortalToBody
              onChange={setAgent}
            />
          </div>
          <div className="flex flex-col gap-1.5">
            <span className="typography-meta font-medium text-muted-foreground">{t('chat.messageBody.forkDialog.instructions.label')}</span>
            <Textarea
              value={instructions}
              onChange={(event) => setInstructions(event.target.value)}
              placeholder={t('chat.messageBody.forkDialog.instructions.placeholder')}
              hasError={instructions.trim().length === 0}
              disabled={submitting}
            />
          </div>
        </div>

        <div className={`flex items-center gap-3 ${showCreateWorktree || showRunAsGoal ? 'justify-between' : 'justify-end'}`}>
          <div className="flex min-w-0 flex-wrap items-center gap-x-4 gap-y-1">
            {showCreateWorktree ? (
              <div className="flex min-w-0 items-center gap-2">
                <Checkbox
                  checked={createWorktree}
                  onChange={setCreateWorktree}
                  disabled={submitting}
                  ariaLabel={t('chat.messageBody.forkDialog.createWorktree')}
                />
                <button
                  type="button"
                  className="truncate typography-ui-label text-muted-foreground transition-colors hover:text-foreground disabled:cursor-not-allowed disabled:opacity-50"
                  disabled={submitting}
                  onClick={() => setCreateWorktree((value) => !value)}
                >
                  {t('chat.messageBody.forkDialog.createWorktree')}
                </button>
              </div>
            ) : null}
            {showRunAsGoal ? (
              <div className="flex min-w-0 items-center gap-2">
                <Checkbox
                  checked={runAsGoal}
                  onChange={handleToggleRunAsGoal}
                  disabled={submitting}
                  ariaLabel={t('sessions.scheduledTasks.editor.goal.aria')}
                />
                <button
                  type="button"
                  className="truncate typography-ui-label text-muted-foreground transition-colors hover:text-foreground disabled:cursor-not-allowed disabled:opacity-50"
                  disabled={submitting}
                  onClick={() => handleToggleRunAsGoal(!runAsGoal)}
                >
                  {t('sessions.scheduledTasks.editor.goal.label')}
                </button>
              </div>
            ) : null}
          </div>
          <div className="flex items-center justify-end gap-2">
            <Button variant="ghost" size="sm" onClick={() => onOpenChange(false)} disabled={submitting}>
              {t('rightSidebar.contextNotesTodo.sendDialog.actions.cancel')}
            </Button>
            <Button size="sm" onClick={handleSubmit} disabled={!canConfirm || submitting}>
              {submitting
                ? t('rightSidebar.contextNotesTodo.sendDialog.actions.sending')
                : t('rightSidebar.contextNotesTodo.sendDialog.actions.send')}
            </Button>
          </div>
        </div>
      </DialogContent>
    </Dialog>
  );
}
