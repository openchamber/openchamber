import React from 'react';

import { isPrimaryMode } from '@/components/chat/mobileControlsUtils';
import { AgentSelector } from '@/components/sections/commands/AgentSelector';
import { ModelSelector } from '@/components/sections/agents/ModelSelector';
import {
  SettingsCheckboxRow,
  SettingsControlGroup,
  SettingsRadioGroup,
  SettingsRadioOption,
  SettingsStackedField,
  SETTINGS_HELPER_CLASS,
} from '@/components/sections/shared/SettingsSection';
import { Button } from '@/components/ui/button';
import { Dialog, DialogContent, DialogFooter, DialogHeader, DialogTitle } from '@/components/ui/dialog';
import { Input } from '@/components/ui/input';
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select';
import { Textarea } from '@/components/ui/textarea';
import { useDeviceInfo } from '@/lib/device';
import { useI18n } from '@/lib/i18n';
import { modelVariantNames } from '@/lib/modelVariants';
import { LENS_ACTIONS, type SuggestedTaskLens } from '@/lib/suggestedTasksApi';
import { selectProvidersForDirectory, useConfigStore } from '@/stores/useConfigStore';
import { LENS_ACTION_TEXT } from './suggestedLensActions';

const DEFAULT_VARIANT = '__default';

/**
 * One lens: what it looks for, which model and agent read the code, whether
 * it may use the web, and what happens to what it finds. Written on Save.
 */
export const SuggestedLensEditorDialog: React.FC<{
  lens: SuggestedTaskLens | null;
  directory: string;
  canCreateWorktree: boolean;
  isNew: boolean;
  onOpenChange: (open: boolean) => void;
  onSave: (lens: SuggestedTaskLens) => Promise<boolean>;
  onDelete: () => Promise<boolean>;
}> = ({ lens, directory, canCreateWorktree, isNew, onOpenChange, onSave, onDelete }) => {
  const { t } = useI18n();
  const { isMobile } = useDeviceInfo();
  const providers = useConfigStore((state) => selectProvidersForDirectory(state, directory));
  const [draft, setDraft] = React.useState<SuggestedTaskLens | null>(lens);
  const [busy, setBusy] = React.useState(false);
  const active = React.useRef(true);
  const submitting = React.useRef(false);
  React.useEffect(() => {
    active.current = true;
    return () => { active.current = false; };
  }, []);

  React.useEffect(() => setDraft(lens), [lens]);

  const variants = React.useMemo(() => {
    if (!draft?.model.providerID || !draft.model.modelID) return [];
    const provider = providers.find((entry) => entry.id === draft.model.providerID);
    return modelVariantNames(provider?.models.find((entry) => entry.id === draft.model.modelID));
  }, [draft?.model.providerID, draft?.model.modelID, providers]);

  if (!draft) return <Dialog open={false} onOpenChange={onOpenChange} />;

  const update = (patch: Partial<SuggestedTaskLens>) => { if (!submitting.current) setDraft((current) => current ? { ...current, ...patch } : current); };
  const updateModel = (patch: Partial<SuggestedTaskLens['model']>) => { if (!submitting.current) setDraft((current) => current ? { ...current, model: { ...current.model, ...patch } } : current); };

  const modelReady = draft.model.useDefaults || Boolean(draft.model.providerID && draft.model.modelID);
  const actionReady = canCreateWorktree || (draft.action !== 'worktree' && draft.action !== 'draft-pr');
  const canSave = draft.name.trim().length > 0 && draft.prompt.trim().length > 0 && modelReady && actionReady && !busy;

  const run = async (operation: () => Promise<boolean>) => {
    if (submitting.current) return;
    submitting.current = true;
    setBusy(true);
    try {
      if (await operation() && active.current) onOpenChange(false);
    } finally {
      submitting.current = false;
      if (active.current) setBusy(false);
    }
  };

  return (
    <Dialog open onOpenChange={onOpenChange}>
      <DialogContent className="max-w-3xl">
        <DialogHeader>
          <DialogTitle>{isNew ? t('suggestedTasks.lens.editor.titleNew') : t('suggestedTasks.lens.editor.titleEdit')}</DialogTitle>
        </DialogHeader>

        <div className="@container" inert={busy}>
        <div className={isMobile ? 'flex flex-col gap-5' : 'grid grid-cols-1 gap-5 @xl:grid-cols-2 @xl:gap-x-10'}>
          <div className="flex min-w-0 flex-col gap-5">
            <SettingsStackedField label={t('suggestedTasks.lens.editor.name')} controlClassName="max-w-none">
              <Input
                value={draft.name}
                dir="auto"
                autoFocus={isNew}
                maxLength={80}
                onChange={(event) => update({ name: event.target.value })}
                aria-label={t('suggestedTasks.lens.editor.name')}
                className="w-full"
              />
            </SettingsStackedField>
            <SettingsStackedField
              label={t('suggestedTasks.lens.editor.prompt')}
              info={t('suggestedTasks.lens.editor.promptInfo')}
              controlClassName="max-w-none"
            >
              <Textarea
                value={draft.prompt}
                dir="auto"
                onChange={(event) => update({ prompt: event.target.value })}
                aria-label={t('suggestedTasks.lens.editor.prompt')}
                maxLength={20_000}
                className="min-h-[200px] w-full text-xs"
              />
            </SettingsStackedField>
            <SettingsCheckboxRow
              checked={draft.enabled}
              onChange={(enabled) => update({ enabled })}
              label={t('suggestedTasks.lens.editor.enabled')}
            />
          </div>

          <div className="flex min-w-0 flex-col gap-5">
            <div className="space-y-3">
              <SettingsCheckboxRow
                checked={draft.model.useDefaults}
                onChange={(useDefaults) => updateModel({ useDefaults })}
                label={t('suggestedTasks.lens.editor.useDefaults')}
                info={t('suggestedTasks.lens.editor.useDefaultsInfo')}
              />
              {!draft.model.useDefaults ? (
                <div className="space-y-3 ps-6">
                  <SettingsStackedField label={t('suggestedTasks.lens.editor.model')}>
                     <ModelSelector
                      directory={directory}
                      providerId={draft.model.providerID ?? ''}
                      modelId={draft.model.modelID ?? ''}
                      onChange={(providerID, modelID) => updateModel({ providerID, modelID, variant: undefined })}
                    />
                  </SettingsStackedField>
                  <SettingsStackedField label={t('suggestedTasks.lens.editor.variant')}>
                    <Select
                      value={draft.model.variant ?? DEFAULT_VARIANT}
                      disabled={variants.length === 0}
                      onValueChange={(value) => updateModel({ variant: value === DEFAULT_VARIANT ? undefined : value })}
                    >
                      <SelectTrigger className="w-fit max-w-full" aria-label={t('suggestedTasks.lens.editor.variant')}>
                        <SelectValue>{(value) => (value === DEFAULT_VARIANT ? t('suggestedTasks.lens.editor.variantDefault') : value)}</SelectValue>
                      </SelectTrigger>
                      <SelectContent>
                        <SelectItem value={DEFAULT_VARIANT}>{t('suggestedTasks.lens.editor.variantDefault')}</SelectItem>
                        {draft.model.variant && !variants.includes(draft.model.variant) ? <SelectItem value={draft.model.variant}>{draft.model.variant}</SelectItem> : null}
                        {variants.map((variant) => <SelectItem key={variant} value={variant}>{variant}</SelectItem>)}
                      </SelectContent>
                    </Select>
                  </SettingsStackedField>
                  <SettingsStackedField label={t('suggestedTasks.lens.editor.agent')}>
                    <AgentSelector
                      directory={directory}
                      agentName={draft.model.agent ?? ''}
                      filter={(agent) => isPrimaryMode(agent.mode)}
                      onChange={(agent) => updateModel({ agent: agent || undefined })}
                    />
                  </SettingsStackedField>
                </div>
              ) : null}
            </div>
            <SettingsCheckboxRow
              checked={draft.web}
              onChange={(web) => update({ web })}
              label={t('suggestedTasks.lens.editor.web')}
              info={t('suggestedTasks.lens.editor.webInfo')}
            />
            <SettingsControlGroup title={t('suggestedTasks.lens.editor.action')}>
              <SettingsRadioGroup aria-label={t('suggestedTasks.lens.editor.action')}>
                {LENS_ACTIONS.map((action) => (
                  <SettingsRadioOption
                    key={action}
                    selected={draft.action === action}
                    disabled={!canCreateWorktree && (action === 'worktree' || action === 'draft-pr')}
                    onSelect={() => update({ action })}
                    label={t(LENS_ACTION_TEXT[action].label)}
                    description={t(LENS_ACTION_TEXT[action].description)}
                  />
                ))}
              </SettingsRadioGroup>
              {draft.action !== 'suggest' ? (
                <p className={SETTINGS_HELPER_CLASS} style={{ color: 'var(--status-warning)' }}>{t('suggestedTasks.lens.editor.automaticWarning')}</p>
              ) : null}
              {!actionReady ? <p className={SETTINGS_HELPER_CLASS}>{t('settings.openchamber.worktrees.state.gitOnly')}</p> : null}
            </SettingsControlGroup>
          </div>
        </div>
        </div>

        <DialogFooter className="sm:justify-between">
          {!isNew ? (
            <Button type="button" size="sm" variant="ghost" className="text-[var(--status-error)]" disabled={busy} onClick={() => void run(onDelete)}>
              {t('suggestedTasks.lens.editor.delete')}
            </Button>
          ) : <span />}
          <div className="flex flex-col-reverse gap-2 sm:flex-row">
            <Button type="button" size="sm" variant="outline" onClick={() => onOpenChange(false)}>{t('dialog.common.actions.cancel')}</Button>
            <Button
              type="button"
              size="sm"
              disabled={!canSave}
              onClick={() => void run(() => onSave({ ...draft, name: draft.name.trim(), prompt: draft.prompt.trim() }))}
            >
              {t('suggestedTasks.lens.editor.save')}
            </Button>
          </div>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
};
