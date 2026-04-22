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
import { ModelSelector } from '@/components/sections/agents/ModelSelector';
import { AgentSelector } from '@/components/sections/commands/AgentSelector';
import { useConfigStore } from '@/stores/useConfigStore';
import { useAgentsStore } from '@/stores/useAgentsStore';
import { isPrimaryMode } from '@/components/chat/mobileControlsUtils';
import { cn } from '@/lib/utils';
import { RiArrowDownSLine } from '@remixicon/react';

type TodoSendTarget = 'session' | 'worktree';

export type TodoSendExecution = {
  providerID: string;
  modelID: string;
  variant: string;
  agent: string;
};

type TodoSendDialogProps = {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  target: TodoSendTarget;
  projectDirectory: string | null;
  submitting?: boolean;
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

type ThinkingPillProps = {
  value: string;
  options: string[];
  disabled?: boolean;
  onChange: (value: string) => void;
};

const ThinkingPill = ({ value, options, disabled, onChange }: ThinkingPillProps) => {
  const label = value || 'Default';

  const trigger = (
    <div
      className={cn(
        'flex h-6 w-fit items-center gap-1.5 rounded-lg border border-border/20 bg-interactive-selection/20 px-2',
        disabled ? 'cursor-not-allowed opacity-60' : 'cursor-pointer hover:bg-interactive-hover/30',
      )}
    >
      <span className="typography-micro whitespace-nowrap font-medium capitalize">{label}</span>
      <RiArrowDownSLine className="h-3 w-3 flex-shrink-0 text-muted-foreground" />
    </div>
  );

  if (disabled) return trigger;

  return (
    <DropdownMenu>
      <DropdownMenuTrigger asChild>{trigger}</DropdownMenuTrigger>
      <DropdownMenuContent align="start" className="max-w-[220px]">
        <DropdownMenuItem className="typography-meta" onSelect={() => onChange('')}>
          <span className={cn('font-medium', !value && 'text-primary')}>Default</span>
        </DropdownMenuItem>
        {options.map((option) => (
          <DropdownMenuItem
            key={option}
            className="typography-meta"
            onSelect={() => onChange(option)}
          >
            <span className={cn('font-medium capitalize', value === option && 'text-primary')}>
              {option}
            </span>
          </DropdownMenuItem>
        ))}
      </DropdownMenuContent>
    </DropdownMenu>
  );
};

export function TodoSendDialog(props: TodoSendDialogProps) {
  const { open, onOpenChange, target, projectDirectory, submitting = false, onConfirm } = props;

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
    void loadProviders({ directory: projectDirectory });
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

  const title = target === 'worktree' ? 'Send to new worktree' : 'Send to new session';

  return (
    <Dialog open={open} onOpenChange={(nextOpen) => { if (!submitting) onOpenChange(nextOpen); }}>
      <DialogContent className="max-w-lg">
        <DialogHeader>
          <DialogTitle>{title}</DialogTitle>
        </DialogHeader>

        <div className="flex flex-wrap items-center gap-x-4 gap-y-2">
          <ModelSelector
            providerId={execution.providerID}
            modelId={execution.modelID}
            onChange={(providerID, modelID) => {
              setExecution((prev) => ({ ...prev, providerID, modelID, variant: '' }));
            }}
          />
          <ThinkingPill
            value={execution.variant}
            options={variantOptions}
            disabled={!hasVariantOptions}
            onChange={(variant) => setExecution((prev) => ({ ...prev, variant }))}
          />
          <AgentSelector
            agentName={execution.agent}
            filter={agentFilter}
            onChange={(agent) => setExecution((prev) => ({ ...prev, agent }))}
          />
        </div>

        <div className="flex items-center justify-end gap-2">
          <Button variant="ghost" size="sm" onClick={() => onOpenChange(false)} disabled={submitting}>
            Cancel
          </Button>
          <Button size="sm" onClick={handleSubmit} disabled={!canConfirm || submitting}>
            {submitting ? 'Sending' : 'Send'}
          </Button>
        </div>
      </DialogContent>
    </Dialog>
  );
}
