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
import { isPrimaryMode } from '@/components/chat/mobileControlsUtils';
import { useI18n } from '@/lib/i18n';
import { useConfigStore } from '@/stores/useConfigStore';
import { useAgentsStore } from '@/stores/useAgentsStore';

export type ReviewFlowExecution = {
  providerID: string;
  modelID: string;
  variant: string;
  agent: string;
  generateHandoff: boolean;
};

type ReviewFlowDialogProps = {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  projectDirectory: string | null;
  submitting?: boolean;
  onConfirm: (execution: ReviewFlowExecution) => Promise<void> | void;
};

const getInitialExecution = (params: {
  providerID: string;
  modelID: string;
  variant: string;
  agent: string;
}): ReviewFlowExecution => ({
  providerID: params.providerID,
  modelID: params.modelID,
  variant: params.variant,
  agent: params.agent,
  generateHandoff: true,
});

export function ReviewFlowDialog({
  open,
  onOpenChange,
  projectDirectory,
  submitting = false,
  onConfirm,
}: ReviewFlowDialogProps) {
  const { t } = useI18n();
  const loadProviders = useConfigStore((state) => state.loadProviders);
  const loadConfigAgents = useConfigStore((state) => state.loadAgents);
  const loadAgentsStoreAgents = useAgentsStore((state) => state.loadAgents);
  const providers = useConfigStore((state) => state.providers);
  const currentProviderID = useConfigStore((state) => state.currentProviderId);
  const currentModelID = useConfigStore((state) => state.currentModelId);
  const currentVariant = useConfigStore((state) => state.currentVariant || '');
  const currentAgentName = useConfigStore((state) => state.currentAgentName || '');

  const [execution, setExecution] = React.useState<ReviewFlowExecution>(() => getInitialExecution({
    providerID: currentProviderID,
    modelID: currentModelID,
    variant: currentVariant,
    agent: currentAgentName,
  }));

  React.useEffect(() => {
    if (!open) return;
    void loadProviders({ directory: projectDirectory, source: 'reviewFlowDialog' });
    void loadConfigAgents({ directory: projectDirectory });
    void loadAgentsStoreAgents();
  }, [open, loadProviders, loadConfigAgents, loadAgentsStoreAgents, projectDirectory]);

  React.useEffect(() => {
    if (!open) return;
    setExecution(getInitialExecution({
      providerID: currentProviderID,
      modelID: currentModelID,
      variant: currentVariant,
      agent: currentAgentName,
    }));
  }, [open, currentProviderID, currentModelID, currentVariant, currentAgentName]);

  React.useEffect(() => {
    if (!open || providers.length === 0) return;

    const provider = providers.find((item) => item.id === execution.providerID) ?? providers[0];
    const models = Array.isArray(provider?.models) ? provider.models : [];
    const hasModel = models.some((item) => item.id === execution.modelID);
    const fallbackModelID = models[0]?.id ?? '';

    if (provider?.id === execution.providerID && hasModel) return;

    setExecution((prev) => ({
      ...prev,
      providerID: provider?.id ?? '',
      modelID: hasModel ? prev.modelID : fallbackModelID,
      variant: '',
    }));
  }, [open, providers, execution.providerID, execution.modelID]);

  const agentFilter = React.useCallback((agent: { mode?: string }) => isPrimaryMode(agent.mode), []);

  const variantOptions = React.useMemo(() => {
    const provider = providers.find((item) => item.id === execution.providerID);
    const model = provider?.models?.find((item) => item.id === execution.modelID) as { variants?: Record<string, unknown> } | undefined;
    return model?.variants ? Object.keys(model.variants) : [];
  }, [providers, execution.providerID, execution.modelID]);

  const hasVariantOptions = variantOptions.length > 0;

  React.useEffect(() => {
    if (hasVariantOptions || !execution.variant) return;
    setExecution((prev) => ({ ...prev, variant: '' }));
  }, [hasVariantOptions, execution.variant]);

  const canConfirm = execution.providerID.trim().length > 0 && execution.modelID.trim().length > 0;

  const handleSubmit = React.useCallback(() => {
    if (!canConfirm || submitting) return;
    void onConfirm(execution);
  }, [canConfirm, submitting, onConfirm, execution]);

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
              checked={execution.generateHandoff}
              onChange={(generateHandoff) => setExecution((prev) => ({ ...prev, generateHandoff }))}
              disabled={submitting}
              ariaLabel={t('diffView.reviewDialog.generateHandoff')}
            />
            <span>{t('diffView.reviewDialog.generateHandoff')}</span>
          </label>

          <div className="flex min-w-0 flex-col gap-1.5">
            <span className="typography-meta font-medium text-muted-foreground">{t('chat.modelControls.model')}</span>
            <ModelSelector
              providerId={execution.providerID}
              modelId={execution.modelID}
              className="max-w-[320px] justify-between"
              dropdownPortalToBody
              onChange={(providerID, modelID) => {
                setExecution((prev) => ({ ...prev, providerID, modelID, variant: '' }));
              }}
            />
          </div>

          <div className="flex flex-col gap-1.5">
            <span className="typography-meta font-medium text-muted-foreground">{t('sessions.scheduledTasks.editor.thinkingLevel.label')}</span>
            <ThinkingPill
              value={execution.variant}
              options={variantOptions}
              disabled={!hasVariantOptions || submitting}
              onChange={(variant) => setExecution((prev) => ({ ...prev, variant }))}
            />
          </div>

          <div className="flex flex-col gap-1.5">
            <span className="typography-meta font-medium text-muted-foreground">{t('sessions.scheduledTasks.editor.agent.label')}</span>
            <AgentSelector
              agentName={execution.agent}
              filter={agentFilter}
              dropdownPortalToBody
              onChange={(agent) => setExecution((prev) => ({ ...prev, agent }))}
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
