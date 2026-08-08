import React from 'react';

import { AgentSelector } from '@/components/sections/commands/AgentSelector';
import { ModelSelector } from '@/components/sections/agents/ModelSelector';
import { ThinkingPill } from '@/components/session/ThinkingPill';
import { Checkbox } from '@/components/ui/checkbox';
import { Button } from '@/components/ui/button';
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/dialog';
import { useI18n } from '@/lib/i18n';
import { useInitialSessionOverrides } from '@/hooks/useInitialSessionOverrides';

export type ReviewFlowExecution = {
  providerID: string;
  modelID: string;
  variant: string;
  agent: string;
  generateHandoff: boolean;
  autoReview: boolean;
};

type ReviewFlowDialogProps = {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  projectDirectory: string | null;
  submitting?: boolean;
  onConfirm: (execution: ReviewFlowExecution) => Promise<void> | void;
};

export function ReviewFlowDialog({
  open,
  onOpenChange,
  projectDirectory,
  submitting = false,
  onConfirm,
}: ReviewFlowDialogProps) {
  const { t } = useI18n();
  // Dialog-local flags (kept separate from the provider/model/variant/agent
  // overrides so the two layers can evolve independently).
  const [generateHandoff, setGenerateHandoff] = React.useState(true);
  const [autoReview, setAutoReview] = React.useState(false);

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
    source: 'reviewFlowDialog',
  });

  const canConfirm = providerID.trim().length > 0 && modelID.trim().length > 0;

  const handleSubmit = React.useCallback(() => {
    if (!canConfirm || submitting) return;
    void onConfirm({
      providerID,
      modelID,
      variant,
      agent,
      generateHandoff,
      autoReview,
    });
  }, [canConfirm, submitting, onConfirm, providerID, modelID, variant, agent, generateHandoff, autoReview]);

  // Reset dialog-local flags on each open transition. The dialog stays mounted
  // (parent controls `open`), so user changes to these checkboxes would
  // otherwise persist across opens. Mirrors the `runAsGoal` reset pattern in
  // TodoSendDialog.
  React.useEffect(() => {
    if (!open) return;
    setGenerateHandoff(true);
    setAutoReview(false);
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

  return (
    <Dialog open={open} onOpenChange={(nextOpen) => { if (!submitting) onOpenChange(nextOpen); }}>
      <DialogContent className="max-w-md overflow-visible">
        <DialogHeader>
          <DialogTitle>{t('diffView.reviewDialog.title')}</DialogTitle>
          <DialogDescription>
            {t('diffView.reviewDialog.description')}
          </DialogDescription>
        </DialogHeader>

        <div className="flex flex-col gap-4">
          <div className="rounded-md border border-[color:color-mix(in_srgb,var(--status-info)_35%,var(--interactive-border))] bg-[color:color-mix(in_srgb,var(--status-info)_10%,var(--surface-background))] px-3 py-2 typography-meta text-foreground">
            {t('diffView.reviewDialog.info')}
          </div>

          <label className="flex items-center gap-2 typography-ui-label text-foreground">
            <Checkbox
              checked={generateHandoff}
              onChange={setGenerateHandoff}
              disabled={submitting}
              ariaLabel={t('diffView.reviewDialog.generateHandoff')}
            />
            <span>{t('diffView.reviewDialog.generateHandoff')}</span>
          </label>

          <label className="flex items-center gap-2 typography-ui-label text-foreground">
            <Checkbox
              checked={autoReview}
              onChange={setAutoReview}
              disabled={submitting}
              ariaLabel={t('diffView.reviewDialog.autoReview')}
            />
            <span>{t('diffView.reviewDialog.autoReview')}</span>
          </label>

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
              disabled={!hasVariantOptions || submitting}
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

        <DialogFooter>
          <Button variant="ghost" size="sm" onClick={() => onOpenChange(false)} disabled={submitting}>
            {t('diffView.reviewDialog.actions.cancel')}
          </Button>
          <Button size="sm" onClick={handleSubmit} disabled={!canConfirm || submitting}>
            {submitting ? t('diffView.reviewDialog.actions.starting') : t('diffView.reviewDialog.actions.start')}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
