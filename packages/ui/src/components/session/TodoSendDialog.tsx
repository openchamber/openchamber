import React from 'react';
import { Button } from '@/components/ui/button';
import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/dialog';
import { Checkbox } from '@/components/ui/checkbox';
import { Skeleton } from '@/components/ui/skeleton';
import { useWaitingBlink } from '@/hooks/useDurationTicker';
import { useDeviceInfo } from '@/lib/device';
import { cn } from '@/lib/utils';
import { useUIStore } from '@/stores/useUIStore';
import { isVSCodeRuntime } from '@/lib/desktop';
import { ModelSelector } from '@/components/sections/agents/ModelSelector';
import { AgentSelector } from '@/components/sections/commands/AgentSelector';
import { ThinkingPill } from '@/components/session/ThinkingPill';
import { selectConfigAgentsForDirectory, selectProvidersForDirectory, useConfigStore } from '@/stores/useConfigStore';
import { useAgentsStore } from '@/stores/useAgentsStore';
import { isPrimaryMode } from '@/components/chat/mobileControlsUtils';
import { useI18n } from '@/lib/i18n';
import { listModelVariantIds, type ModelVariantSource } from '@/lib/modelVariants';
import { resolveEffortForModelSelection } from '@/lib/modelEfforts';
import type { TodoSendExecution } from './todoSendExecution';

type TodoSendTarget = 'session' | 'worktree';

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

// Stands in for the model picker while the project's defaults load, in the
// trigger's shape so nothing moves when the picker replaces it.
function ModelFieldSkeleton() {
  const { t } = useI18n();
  const isMobile = useUIStore((state) => state.isMobile);
  const { isMobile: deviceIsMobile } = useDeviceInfo();
  const blink = useWaitingBlink(true);
  return (
    <Skeleton
      role="status"
      aria-label={t('common.loading')}
      className={cn(isMobile || deviceIsMobile ? 'h-8 w-full' : 'h-7 w-48', 'max-w-[320px] rounded-md', blink)}
    />
  );
}

const EMPTY_EXECUTION: TodoSendExecution = {
  providerID: '',
  modelID: '',
  variant: '',
  agent: '',
  picked: { model: false, variant: false, agent: false },
};

export function TodoSendDialog(props: TodoSendDialogProps) {
  const { t } = useI18n();
  const { open, onOpenChange, target, projectDirectory, submitting = false, allowRunAsGoal = false, onConfirm } = props;
  const showRunAsGoal = allowRunAsGoal && !isVSCodeRuntime();

  const loadProviders = useConfigStore((state) => state.loadProviders);
  const loadConfigAgents = useConfigStore((state) => state.loadAgents);
  const loadAgentsStoreAgents = useAgentsStore((state) => state.loadAgents);
  // The catalogs of the project the dialog sends to, which need not be the active one.
  const pickerDirectory = projectDirectory ?? undefined;
  const providers = useConfigStore((state) => selectProvidersForDirectory(state, projectDirectory));
  const agents = useConfigStore((state) => selectConfigAgentsForDirectory(state, pickerDirectory));
  const resolveDirectoryDefaultSelection = useConfigStore((state) => state.resolveDirectoryDefaultSelection);

  const [execution, setExecution] = React.useState<TodoSendExecution>(EMPTY_EXECUTION);
  const [defaultsResolved, setDefaultsResolved] = React.useState(false);

  const resolveVariantForModel = React.useCallback((providerID: string, modelID: string, agentName: string) => {
    const provider = providers.find((item) => item.id === providerID);
    const model = provider?.models?.find((item) => item.id === modelID) as { variants?: ModelVariantSource } | undefined;
    return resolveEffortForModelSelection({
      providerID,
      modelID,
      variants: listModelVariantIds(model?.variants),
      agents,
      agentName,
      configuredVariant: useConfigStore.getState().getDefaultVariantForModel(providerID, modelID, projectDirectory),
    }) ?? '';
  }, [agents, projectDirectory, providers]);

  React.useEffect(() => {
    if (!open) return;
    void loadProviders({ directory: projectDirectory, source: 'todoSendDialog' });
    void loadConfigAgents({ directory: projectDirectory });
    void loadAgentsStoreAgents();
  }, [open, loadProviders, loadConfigAgents, loadAgentsStoreAgents, projectDirectory]);

  // The dialog starts on the defaults of the project it sends to. The
  // composer's pick belongs to whatever session is open, often in another
  // project, so it never seeds the dialog. An agent picked while the
  // defaults load stays.
  React.useEffect(() => {
    if (!open) return;
    setExecution(EMPTY_EXECUTION);
    setDefaultsResolved(false);
    if (!projectDirectory) {
      setDefaultsResolved(true);
      return;
    }
    let cancelled = false;
    void resolveDirectoryDefaultSelection(projectDirectory).then((defaults) => {
      if (cancelled) return;
      setDefaultsResolved(true);
      if (!defaults) return;
      setExecution((prev) => {
        // The model and its effort cannot be picked yet: the picker shows once the defaults are here.
        const next = { ...prev, providerID: defaults.providerId, modelID: defaults.modelId, variant: defaults.variant ?? '' };
        if (!prev.picked.agent) next.agent = defaults.agentName ?? '';
        return next;
      });
    }, () => {
      if (!cancelled) setDefaultsResolved(true);
    });
    return () => {
      cancelled = true;
    };
  }, [open, projectDirectory, resolveDirectoryDefaultSelection]);

  // Nothing resolved for the project: offer a model so the dialog can send.
  React.useEffect(() => {
    if (!open || !defaultsResolved || providers.length === 0 || execution.providerID) return;

    const provider = providers[0];
    const nextModelID = provider?.models?.[0]?.id ?? '';
    setExecution((prev) => ({
      ...prev,
      providerID: provider?.id ?? '',
      modelID: nextModelID,
      variant: resolveVariantForModel(provider?.id ?? '', nextModelID, prev.agent),
    }));
  }, [open, defaultsResolved, providers, execution.providerID, resolveVariantForModel]);

  const agentFilter = React.useCallback((agent: { mode?: string }) => isPrimaryMode(agent.mode), []);

  const selectedModel = React.useMemo(() => {
    const provider = providers.find((item) => item.id === execution.providerID);
    return provider?.models?.find((item) => item.id === execution.modelID) as { variants?: ModelVariantSource } | undefined;
  }, [providers, execution.providerID, execution.modelID]);
  const variantOptions = React.useMemo(() => listModelVariantIds(selectedModel?.variants), [selectedModel]);

  const hasVariantOptions = variantOptions.length > 0;

  // A configured model the catalog has not listed yet keeps its effort.
  React.useEffect(() => {
    if (!selectedModel || hasVariantOptions || !execution.variant) return;
    setExecution((prev) => ({ ...prev, variant: '' }));
  }, [selectedModel, hasVariantOptions, execution.variant]);

  // A send before the defaults arrive would leave out what the user did not pick.
  const canConfirm = defaultsResolved && execution.providerID.trim().length > 0 && execution.modelID.trim().length > 0;

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
            {!defaultsResolved ? <ModelFieldSkeleton /> : <ModelSelector
              providerId={execution.providerID}
              modelId={execution.modelID}
              directory={pickerDirectory}
              className="max-w-[320px] justify-between"
              dropdownPortalToBody
              onChange={(providerID, modelID) => {
                setExecution((prev) => ({
                  ...prev,
                  providerID,
                  modelID,
                  variant: resolveVariantForModel(providerID, modelID, prev.agent),
                  picked: { ...prev.picked, model: true },
                }));
              }}
            />}
          </div>
          <div className="flex flex-col gap-1.5">
            <span className="typography-meta font-medium text-muted-foreground">{t('sessions.scheduledTasks.editor.thinkingLevel.label')}</span>
            <ThinkingPill
              value={execution.variant}
              options={variantOptions}
              disabled={!hasVariantOptions}
              onChange={(variant) => setExecution((prev) => ({ ...prev, variant, picked: { ...prev.picked, variant: true } }))}
            />
          </div>
          <div className="flex flex-col gap-1.5">
            <span className="typography-meta font-medium text-muted-foreground">{t('sessions.scheduledTasks.editor.agent.label')}</span>
            <AgentSelector
              agentName={execution.agent}
              directory={pickerDirectory}
              filter={agentFilter}
              dropdownPortalToBody
              onChange={(agent) => setExecution((prev) => ({ ...prev, agent, picked: { ...prev.picked, agent: true } }))}
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
