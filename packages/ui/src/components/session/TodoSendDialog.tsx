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
import { useConfigStore } from '@/stores/useConfigStore';
import { useAgentsStore } from '@/stores/useAgentsStore';
import { isPrimaryMode } from '@/components/chat/mobileControlsUtils';
import { useI18n } from '@/lib/i18n';

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

const getInitialExecution = (params: {
  providerID: string;
  modelID: string;
  variant: string;
  agent: string;
}): TodoSendExecution => ({
  providerID: params.providerID,
  modelID: params.modelID,
  variant: params.variant,
  agent: params.agent,
});

export function TodoSendDialog(props: TodoSendDialogProps) {
  const { t } = useI18n();
  const { open, onOpenChange, target, projectDirectory, submitting = false, allowRunAsGoal = false, onConfirm } = props;
  const showRunAsGoal = allowRunAsGoal && !isVSCodeRuntime();

  const loadProviders = useConfigStore((state) => state.loadProviders);
  const loadConfigAgents = useConfigStore((state) => state.loadAgents);
  const loadAgentsStoreAgents = useAgentsStore((state) => state.loadAgents);
  const providers = useConfigStore((state) => state.providers);
  const currentProviderID = useConfigStore((state) => state.currentProviderId);
  const currentModelID = useConfigStore((state) => state.currentModelId);
  const currentVariant = useConfigStore((state) => state.currentVariant || '');
  const currentAgentName = useConfigStore((state) => state.currentAgentName || '');

  const [execution, setExecution] = React.useState<TodoSendExecution>(() => getInitialExecution({
    providerID: currentProviderID,
    modelID: currentModelID,
    variant: currentVariant,
    agent: currentAgentName,
  }));

  React.useEffect(() => {
    if (!open) return;
    void loadProviders({ directory: projectDirectory, source: 'todoSendDialog' });
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
              disabled={!hasVariantOptions}
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

        <div className={`flex items-center gap-3 ${showRunAsGoal ? 'justify-between' : 'justify-end'}`}>
          {showRunAsGoal ? (
            <div className="flex min-w-0 items-center gap-2">
              <Checkbox
                checked={execution.runAsGoal === true}
                onChange={(runAsGoal: boolean) => setExecution((prev) => ({ ...prev, runAsGoal }))}
                disabled={submitting}
                ariaLabel={t('sessions.scheduledTasks.editor.goal.aria')}
              />
              <button
                type="button"
                className="truncate typography-ui-label text-muted-foreground transition-colors hover:text-foreground disabled:cursor-not-allowed disabled:opacity-50"
                disabled={submitting}
                onClick={() => setExecution((prev) => ({ ...prev, runAsGoal: prev.runAsGoal !== true }))}
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
