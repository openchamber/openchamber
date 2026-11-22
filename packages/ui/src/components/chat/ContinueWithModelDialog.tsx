import React from 'react';

import { Icon } from '@/components/icon/Icon';
import { ModelSelector } from '@/components/sections/agents/ModelSelector';
import { SettingsRadioGroup, SettingsRadioOption } from '@/components/sections/shared/SettingsSection';
import { ThinkingPill } from '@/components/session/ThinkingPill';
import { toast } from '@/components/ui';
import { Button } from '@/components/ui/button';
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from '@/components/ui/dialog';
import { Spinner } from '@/components/ui/spinner';
import { useI18n, type I18nKey, type I18nParams } from '@/lib/i18n';
import { getProviderModelDisplayName } from '@/lib/modelDisplay';
import { listModelVariantIds, type ModelVariantSource } from '@/lib/modelVariants';
import type { ContinueWorkMode } from '@/lib/opencode/model-handoff';
import { isAutoModel } from '@/lib/routing/autoModel';
import { selectProvidersForDirectory, useConfigStore } from '@/stores/useConfigStore';
import { useUIStore } from '@/stores/useUIStore';
import { useBackgroundShellsStore } from '@/sync/background-shells';
import { continueWithModel, type ContinueResult, type ContinueSelection } from '@/sync/continue-with-model';
import { createContinueWithModelDeps, readContinueSnapshot, readRunningWork } from '@/sync/continue-with-model-runtime';
import { useGlobalSessionStatusStore } from '@/sync/global-session-status';
import { useSelectionStore } from '@/sync/selection-store';

type ContinueWithModelDialogProps = {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  sessionId: string;
  directory: string;
};

const FAILURE_KEYS = {
  background: 'chat.continueWithModel.failed.background',
  handoff: 'chat.continueWithModel.failed.background',
  interrupt: 'chat.continueWithModel.failed.interrupt',
  switch: 'chat.continueWithModel.failed.switch',
  note: 'chat.continueWithModel.failed.send',
  send: 'chat.continueWithModel.failed.send',
} as const satisfies Record<Extract<ContinueResult, { status: 'failed' }>['step'], I18nKey>;

/** Tells the user how a continue went when the transcript alone does not say it. */
const reportResult = (result: ContinueResult, model: string, t: (key: I18nKey, params?: I18nParams) => string): void => {
  switch (result.status) {
    case 'continued':
      if (result.failedStops > 0) toast.warning(t('chat.continueWithModel.partial', { model }));
      return;
    case 'failed':
      toast.error(t(FAILURE_KEYS[result.step], { model }));
      return;
    case 'runtime-changed':
      toast.error(t('chat.continueWithModel.failed.runtime'));
      return;
    case 'busy':
      toast.error(t('chat.continueWithModel.failed.busy'));
  }
};

/**
 * "Continue with another model": the model and effort to continue on, starting
 * from the composer's choice, and what happens to the shell commands and
 * subagents the session started (the default comes from Settings → Sessions).
 * The sequence itself is `continueWithModel` (`sync/continue-with-model.ts`).
 */
export function ContinueWithModelDialog({ open, onOpenChange, sessionId, directory }: ContinueWithModelDialogProps) {
  const { t } = useI18n();
  const providers = useConfigStore((state) => selectProvidersForDirectory(state, directory));
  const [providerID, setProviderID] = React.useState('');
  const [modelID, setModelID] = React.useState('');
  const [variant, setVariant] = React.useState('');
  const [mode, setMode] = React.useState<ContinueWorkMode>(() => useUIStore.getState().continueWithModelMode);
  const [submitting, setSubmitting] = React.useState(false);

  // Read once when the dialog opens: a background catalog refresh must not
  // replace a model the user is picking. Auto is left out, because it can
  // route straight back to the model that stopped.
  React.useEffect(() => {
    if (!open) return;
    const config = useConfigStore.getState();
    const auto = isAutoModel(config.currentProviderId, config.currentModelId);
    setProviderID(auto ? '' : config.currentProviderId);
    setModelID(auto ? '' : config.currentModelId);
    setVariant(auto ? '' : config.currentVariant || '');
    setMode(useUIStore.getState().continueWithModelMode);
  }, [open]);

  const variantOptions = React.useMemo(() => {
    const provider = providers.find((candidate) => candidate.id === providerID);
    // SAFETY: the catalog model's `variants` is v2's `{ id, settings }[]` (or
    // the v1 keyed object on an older record); only the ids are read.
    const model = provider?.models.find((candidate) => candidate.id === modelID) as { variants?: ModelVariantSource } | undefined;
    return listModelVariantIds(model?.variants);
  }, [modelID, providerID, providers]);

  const modelName = React.useMemo(() => {
    const provider = providers.find((candidate) => candidate.id === providerID);
    return getProviderModelDisplayName(provider, modelID) || modelID;
  }, [modelID, providerID, providers]);

  // What runs now, kept current while the dialog is open.
  const shellsById = useBackgroundShellsStore((state) => state.byId);
  const activeSessionIds = useGlobalSessionStatusStore((state) => state.activeSessionIds);
  const running = React.useMemo(
    () => readRunningWork({ sessionId, directory }, { shellsById, activeSessionIds }),
    [activeSessionIds, directory, sessionId, shellsById],
  );

  const canConfirm = providerID.length > 0 && modelID.length > 0 && !submitting;

  const handleConfirm = React.useCallback(async () => {
    if (!canConfirm) return;
    setSubmitting(true);
    const target = { sessionId, directory };
    const selection: ContinueSelection = {
      providerID,
      modelID,
      variant: variantOptions.length === 0 ? undefined : (variant || null),
      // The agent a send from the composer would use.
      agent: useSelectionStore.getState().getSessionAgentSelection(sessionId) || useConfigStore.getState().currentAgentName || undefined,
    };
    const result = await continueWithModel({
      target,
      mode,
      selection,
      prompt: t('chat.continueWithModel.prompt'),
      snapshot: readContinueSnapshot(target),
    }, createContinueWithModelDeps());
    setSubmitting(false);
    reportResult(result, modelName, t);
    // A failure that changed nothing keeps the dialog, so the user can try again or pick the other mode.
    const nothingChanged = result.status === 'busy' || (result.status === 'failed' && !result.stopped);
    if (!nothingChanged) onOpenChange(false);
  }, [canConfirm, directory, mode, modelID, modelName, onOpenChange, providerID, sessionId, t, variant, variantOptions.length]);

  React.useEffect(() => {
    if (!open) return;
    const onKeyDown = (event: KeyboardEvent) => {
      if ((event.metaKey || event.ctrlKey) && event.key === 'Enter') {
        event.preventDefault();
        void handleConfirm();
      }
    };
    window.addEventListener('keydown', onKeyDown);
    return () => window.removeEventListener('keydown', onKeyDown);
  }, [handleConfirm, open]);

  const hasRunningWork = running.shells.length > 0 || running.subagents.length > 0;

  return (
    <Dialog open={open} onOpenChange={(nextOpen) => { if (!submitting) onOpenChange(nextOpen); }}>
      <DialogContent className="max-w-md overflow-visible">
        <DialogHeader>
          <DialogTitle>{t('chat.continueWithModel.action')}</DialogTitle>
          <DialogDescription>{t('chat.continueWithModel.description')}</DialogDescription>
        </DialogHeader>

        <div className="flex flex-col gap-4">
          <div className="flex min-w-0 flex-col gap-1.5">
            <span className="typography-meta font-medium text-muted-foreground">{t('chat.modelControls.model')}</span>
            <ModelSelector
              providerId={providerID}
              modelId={modelID}
              directory={directory}
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
              disabled={variantOptions.length === 0 || submitting}
              onChange={setVariant}
            />
          </div>
          <div className="flex flex-col gap-1.5">
            <span className="typography-meta font-medium text-muted-foreground">{t('chat.continueWithModel.modeLabel')}</span>
            <SettingsRadioGroup aria-label={t('chat.continueWithModel.modeLabel')}>
              <SettingsRadioOption
                selected={mode === 'stop'}
                onSelect={() => setMode('stop')}
                disabled={submitting}
                label={t('chat.continueWithModel.mode.stop')}
                description={t('chat.continueWithModel.mode.stopDescription')}
              />
              <SettingsRadioOption
                selected={mode === 'keep'}
                onSelect={() => setMode('keep')}
                disabled={submitting}
                label={t('chat.continueWithModel.mode.keep')}
                description={t('chat.continueWithModel.mode.keepDescription')}
              />
            </SettingsRadioGroup>
          </div>
          {hasRunningWork ? (
            <div className="flex min-w-0 flex-col gap-1.5">
              <span className="typography-meta font-medium text-muted-foreground">{t('chat.continueWithModel.running')}</span>
              <ul className="max-h-32 space-y-1 overflow-y-auto">
                {running.shells.map((shell) => (
                  <li key={shell.shellID} className="flex min-w-0 items-center gap-2">
                    <Icon name="terminal-box" className="size-3.5 shrink-0 text-muted-foreground" />
                    <span className="min-w-0 truncate font-mono typography-meta text-foreground" dir="ltr" title={shell.command}>{shell.command}</span>
                  </li>
                ))}
                {running.subagents.map((subagent) => (
                  <li key={subagent.sessionID} className="flex min-w-0 items-center gap-2">
                    <Icon name="ai-agent" className="size-3.5 shrink-0 text-muted-foreground" />
                    <span className="min-w-0 truncate typography-meta text-foreground" dir="auto">
                      {subagent.description || t('chat.backgroundShells.subagent')}
                    </span>
                  </li>
                ))}
              </ul>
            </div>
          ) : null}
        </div>

        <DialogFooter>
          <Button variant="ghost" size="sm" onClick={() => onOpenChange(false)} disabled={submitting}>
            {t('chat.continueWithModel.cancel')}
          </Button>
          {/* The label stays in place under the spinner, so the button keeps its width. */}
          <Button size="sm" className="relative" onClick={() => void handleConfirm()} disabled={!canConfirm}>
            <span className={submitting ? 'invisible' : undefined}>{t('chat.continueWithModel.confirm')}</span>
            {submitting ? <Spinner className="absolute inset-0 m-auto size-3.5" aria-hidden /> : null}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
