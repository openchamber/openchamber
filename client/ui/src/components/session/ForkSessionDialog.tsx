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
import { useConfigStore } from '@/stores/useConfigStore';
import { useAgentsStore } from '@/stores/useAgentsStore';
import { isPrimaryMode } from '@/components/chat/mobileControlsUtils';
import { EXECUTION_FORK_DEFAULT_INSTRUCTIONS } from '@/lib/messages/executionMeta';
import { useI18n } from '@/lib/i18n';
import { isVSCodeRuntime } from '@/lib/desktop';

export type ForkSessionExecution = {
  providerID: string;
  modelID: string;
  variant: string;
  agent: string;
  instructions: string;
  createWorktree?: boolean;
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

  const loadProviders = useConfigStore((state) => state.loadProviders);
  const loadConfigAgents = useConfigStore((state) => state.loadAgents);
  const loadAgentsStoreAgents = useAgentsStore((state) => state.loadAgents);
  const providers = useConfigStore((state) => state.providers);
  const currentProviderID = useConfigStore((state) => state.currentProviderId);
  const currentModelID = useConfigStore((state) => state.currentModelId);
  const currentVariant = useConfigStore((state) => state.currentVariant || '');
  const currentAgentName = useConfigStore((state) => state.currentAgentName || '');

  const [providerID, setProviderID] = React.useState(currentProviderID);
  const [modelID, setModelID] = React.useState(currentModelID);
  const [variant, setVariant] = React.useState(currentVariant);
  const [agent, setAgent] = React.useState(currentAgentName);
  const [instructions, setInstructions] = React.useState(EXECUTION_FORK_DEFAULT_INSTRUCTIONS);
  const [createWorktree, setCreateWorktree] = React.useState(false);
  const showCreateWorktree = React.useMemo(() => !isVSCodeRuntime(), []);

  React.useEffect(() => {
    if (!open) return;
    void loadProviders({ directory: projectDirectory, source: 'forkSessionDialog' });
    void loadConfigAgents({ directory: projectDirectory });
    void loadAgentsStoreAgents();
  }, [open, loadProviders, loadConfigAgents, loadAgentsStoreAgents, projectDirectory]);

  // Reset only when the dialog transitions to open. Reading the store snapshot
  // here (instead of subscribing) avoids clobbering in-progress user edits when
  // the config store refreshes in the background while the dialog is open.
  React.useEffect(() => {
    if (!open) return;
    const config = useConfigStore.getState();
    setProviderID(config.currentProviderId);
    setModelID(config.currentModelId);
    setVariant(config.currentVariant || '');
    setAgent(config.currentAgentName || '');
    setInstructions(EXECUTION_FORK_DEFAULT_INSTRUCTIONS);
    setCreateWorktree(false);
  }, [open]);

  React.useEffect(() => {
    if (!open || providers.length === 0) return;

    const provider = providers.find((item) => item.id === providerID) ?? providers[0];
    const models = Array.isArray(provider?.models) ? provider.models : [];
    const hasModel = models.some((item) => item.id === modelID);
    const fallbackModelID = models[0]?.id ?? '';

    if (provider?.id === providerID && hasModel) return;

    setProviderID(provider?.id ?? '');
    setModelID(hasModel ? modelID : fallbackModelID);
    setVariant('');
  }, [open, providers, providerID, modelID]);

  const agentFilter = React.useCallback((candidate: { mode?: string }) => isPrimaryMode(candidate.mode), []);

  const variantOptions = React.useMemo(() => {
    const provider = providers.find((item) => item.id === providerID);
    const model = provider?.models?.find((item) => item.id === modelID) as { variants?: Record<string, unknown> } | undefined;
    return model?.variants ? Object.keys(model.variants) : [];
  }, [providers, providerID, modelID]);

  const hasVariantOptions = variantOptions.length > 0;

  React.useEffect(() => {
    if (hasVariantOptions || !variant) return;
    setVariant('');
  }, [hasVariantOptions, variant]);

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
    });
  }, [canConfirm, submitting, onConfirm, providerID, modelID, variant, agent, instructions, showCreateWorktree, createWorktree]);

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
              onChange={(nextProviderID, nextModelID) => {
                setProviderID(nextProviderID);
                setModelID(nextModelID);
                setVariant('');
              }}
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

        <div className={`flex items-center gap-3 ${showCreateWorktree ? 'justify-between' : 'justify-end'}`}>
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
