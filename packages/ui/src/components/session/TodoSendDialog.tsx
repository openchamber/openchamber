import React from 'react';
import { Button } from '@/components/ui/button';
import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/dialog';
import { Checkbox } from '@/components/ui/checkbox';
import { isVSCodeRuntime } from '@/lib/desktop';
import { ModelSelector } from '@/components/sections/agents/ModelSelector';
import { AgentSelector } from '@/components/sections/commands/AgentSelector';
import { ThinkingPill } from '@/components/session/ThinkingPill';
import { useI18n } from '@/lib/i18n';
import { useInitialSessionOverrides } from '@/hooks/useInitialSessionOverrides';

type TodoSendTarget = 'session' | 'worktree';

export type TodoSendExecution = {
  providerID: string;
  modelID: string;
  variant: string;
  agent: string;
  runAsGoal?: boolean;
};

type TodoSendDialogProps = {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  target: TodoSendTarget;
  projectDirectory: string | null;
  submitting?: boolean;
  /** Offer a "Run as goal" checkbox (hidden in VS Code, where the loop does not run). */
  allowRunAsGoal?: boolean;
  onConfirm: (execution: TodoSendExecution) => Promise<void> | void;
};

export function TodoSendDialog(props: TodoSendDialogProps) {
  const { t } = useI18n();
  const { open, onOpenChange, target, projectDirectory, submitting = false, allowRunAsGoal = false, onConfirm } = props;
  const showRunAsGoal = allowRunAsGoal && !isVSCodeRuntime();
  const [runAsGoal, setRunAsGoal] = React.useState(false);

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
    source: 'todoSendDialog',
  });

  const canConfirm = providerID.trim().length > 0 && modelID.trim().length > 0;

  const handleSubmit = React.useCallback(() => {
    if (!canConfirm || submitting) return;
    void onConfirm({
      providerID,
      modelID,
      variant,
      agent,
      runAsGoal: showRunAsGoal && runAsGoal,
    });
  }, [canConfirm, submitting, onConfirm, providerID, modelID, variant, agent, showRunAsGoal, runAsGoal]);

  React.useEffect(() => {
    if (!open) return;
    setRunAsGoal(false);
  }, [open]);

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

  const title = target === 'worktree'
    ? t('rightSidebar.contextNotesTodo.sendDialog.title.newWorktree')
    : t('rightSidebar.contextNotesTodo.sendDialog.title.newSession');

  return (
    <Dialog open={open} onOpenChange={(nextOpen) => { if (!submitting) onOpenChange(nextOpen); }}>
      <DialogContent className="max-w-md overflow-visible">
        <DialogHeader>
          <DialogTitle>{title}</DialogTitle>
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
        </div>

        <div className={`flex items-center gap-3 ${showRunAsGoal ? 'justify-between' : 'justify-end'}`}>
          {showRunAsGoal ? (
            <div className="flex min-w-0 items-center gap-2">
              <Checkbox
                checked={runAsGoal}
                onChange={setRunAsGoal}
                disabled={submitting}
                ariaLabel={t('sessions.scheduledTasks.editor.goal.aria')}
              />
              <button
                type="button"
                className="truncate typography-ui-label text-muted-foreground transition-colors hover:text-foreground disabled:cursor-not-allowed disabled:opacity-50"
                disabled={submitting}
                onClick={() => setRunAsGoal((value) => !value)}
              >
                {t('sessions.scheduledTasks.editor.goal.label')}
              </button>
            </div>
          ) : null}
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
