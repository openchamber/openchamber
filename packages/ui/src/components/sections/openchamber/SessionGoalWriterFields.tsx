import React from 'react';
import { ModelSelector } from '@/components/sections/agents/ModelSelector';
import {
  SettingsCheckboxRow,
  SettingsChipGroup,
  SettingsFieldRow,
  SETTINGS_CUSTOM_TRIGGER_CLASS,
  SETTINGS_SELECT_ROW_TRIGGER_CLASS,
} from '@/components/sections/shared/SettingsSection';
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select';
import { modelVariantNames } from '@/lib/modelVariants';
import { selectProvidersForDirectory, useConfigStore } from '@/stores/useConfigStore';
import { useCallableModelProviders } from '@/hooks/useCallableModelProviders';
import { useI18n } from '@/lib/i18n';
import { parseModelIdentifier } from '@/lib/modelIdentifier';
import { loadDesktopSettings, updateDesktopSettings } from '@/lib/persistence';
import { cn } from '@/lib/utils';
import { useUIStore, type SessionGoalAutoCreate, type SessionGoalWriterSendMode } from '@/stores/useUIStore';
import { GoalWriterChoiceSuggestion } from './ModelChoiceSettings';

/**
 * The goal writer's settings in Settings → Chat → Goal: the composer switch,
 * the model, review before sending, what the spec does on send, rewriting
 * every goal, and starting a goal from the next message.
 */
export const SessionGoalWriterFields: React.FC<{ disabled?: boolean }> = ({ disabled = false }) => {
  const { t } = useI18n();
  const writerEnabled = useUIStore((state) => state.sessionGoalWriterEnabled);
  const setWriterEnabled = useUIStore((state) => state.setSessionGoalWriterEnabled);
  const review = useUIStore((state) => state.sessionGoalWriterReview);
  const setReview = useUIStore((state) => state.setSessionGoalWriterReview);
  const sendMode = useUIStore((state) => state.sessionGoalWriterSendMode);
  const setSendMode = useUIStore((state) => state.setSessionGoalWriterSendMode);
  const rewriteAll = useUIStore((state) => state.sessionGoalRewriteAll);
  const setRewriteAll = useUIStore((state) => state.setSessionGoalRewriteAll);
  const autoCreate = useUIStore((state) => state.sessionGoalAutoCreate);
  const setAutoCreate = useUIStore((state) => state.setSessionGoalAutoCreate);
  const rememberChoice = useUIStore((state) => state.sessionGoalWriterRememberChoice);
  const setRememberChoice = useUIStore((state) => state.setSessionGoalWriterRememberChoice);

  return (
    <>
      <SettingsCheckboxRow
        checked={writerEnabled}
        onChange={setWriterEnabled}
        disabled={disabled}
        label={t('settings.openchamber.visual.goal.writer.enabledLabel')}
        ariaLabel={t('settings.openchamber.visual.goal.writer.enabledAria')}
        info={t('settings.openchamber.visual.goal.writer.enabledInfo')}
        settingsItem="chat.session-goal-writer"
      />
      <SessionGoalWriterModelField disabled={disabled} />
      <SettingsCheckboxRow
        checked={rememberChoice}
        onChange={setRememberChoice}
        disabled={disabled}
        label={t('settings.openchamber.visual.goal.writer.rememberLabel')}
        ariaLabel={t('settings.openchamber.visual.goal.writer.rememberAria')}
        info={t('settings.openchamber.visual.goal.writer.rememberInfo')}
        settingsItem="chat.session-goal-writer-remember"
      />
      <SettingsCheckboxRow
        checked={review}
        onChange={setReview}
        disabled={disabled}
        label={t('settings.openchamber.visual.goal.writer.reviewLabel')}
        ariaLabel={t('settings.openchamber.visual.goal.writer.reviewAria')}
        info={t('settings.openchamber.visual.goal.writer.reviewInfo')}
        settingsItem="chat.session-goal-writer-review"
      />
      <SettingsFieldRow
        settingsItem="chat.session-goal-writer-send-mode"
        label={t('settings.openchamber.visual.goal.writer.sendModeLabel')}
        info={t('settings.openchamber.visual.goal.writer.sendModeInfo')}
      >
        <SettingsChipGroup<SessionGoalWriterSendMode>
          aria-label={t('settings.openchamber.visual.goal.writer.sendModeLabel')}
          value={sendMode}
          onChange={setSendMode}
          options={[
            { value: 'with-message', label: t('settings.openchamber.visual.goal.writer.sendMode.withMessage'), disabled },
            { value: 'goal-as-message', label: t('settings.openchamber.visual.goal.writer.sendMode.goalAsMessage'), disabled },
          ]}
        />
      </SettingsFieldRow>
      <SettingsCheckboxRow
        checked={rewriteAll}
        onChange={setRewriteAll}
        disabled={disabled}
        label={t('settings.openchamber.visual.goal.writer.rewriteAllLabel')}
        ariaLabel={t('settings.openchamber.visual.goal.writer.rewriteAllAria')}
        info={t('settings.openchamber.visual.goal.writer.rewriteAllInfo')}
        settingsItem="chat.session-goal-rewrite-all"
      />
      <SettingsFieldRow
        settingsItem="chat.session-goal-auto-create"
        label={t('settings.openchamber.visual.goal.autoCreate.label')}
        info={t('settings.openchamber.visual.goal.autoCreate.info')}
      >
        <SettingsChipGroup<SessionGoalAutoCreate>
          aria-label={t('settings.openchamber.visual.goal.autoCreate.label')}
          value={autoCreate}
          onChange={setAutoCreate}
          options={[
            { value: 'off', label: t('settings.openchamber.visual.goal.autoCreate.off'), disabled },
            { value: 'review', label: t('settings.openchamber.visual.goal.autoCreate.review'), disabled },
            { value: 'auto', label: t('settings.openchamber.visual.goal.autoCreate.auto'), disabled },
          ]}
        />
      </SettingsFieldRow>
    </>
  );
};

/**
 * Which model writes goal specs. Empty means the model the session uses. The
 * server reads the setting for every spec it writes, so the value lives in the
 * settings file only, as the walkthrough model does.
 */
const NO_VARIANT_VALUE = '__default__';

const formatVariantLabel = (variant: string): string => variant.charAt(0).toUpperCase() + variant.slice(1);

const SessionGoalWriterModelField: React.FC<{ disabled: boolean }> = ({ disabled }) => {
  const { t } = useI18n();
  // Fail closed: never offer providers whose credentials were not verified.
  const providers = useCallableModelProviders() ?? [];
  const catalog = useConfigStore((state) => selectProvidersForDirectory(state, undefined));
  const [model, setModel] = React.useState<string | undefined>();
  const [variant, setVariant] = React.useState<string | undefined>();

  React.useEffect(() => {
    let alive = true;
    const load = async () => {
      try {
        const stored = await loadDesktopSettings();
        const storedModel = stored?.sessionGoalWriterModel?.trim();
        if (alive && storedModel) setModel(storedModel);
        const storedVariant = stored?.sessionGoalWriterVariant?.trim();
        if (alive && storedVariant) setVariant(storedVariant);
      } catch (error) {
        console.warn('Failed to load the goal writer model:', error);
      }
    };
    void load();
    return () => {
      alive = false;
    };
  }, []);

  const parsed = parseModelIdentifier(model) ?? { providerId: '', modelId: '' };
  const variants = React.useMemo(() => modelVariantNames(
    catalog.find((provider) => provider.id === parsed.providerId)?.models.find((entry) => entry.id === parsed.modelId),
  ), [catalog, parsed.providerId, parsed.modelId]);

  const handleChange = React.useCallback(async (providerId: string, modelId: string) => {
    const next = providerId && modelId ? `${providerId}/${modelId}` : undefined;
    setModel(next);
    // An effort level belongs to the model it was chosen for.
    setVariant(undefined);
    try {
      // Clearing the picker goes back to the session's model, so an empty
      // value is a real choice.
      await updateDesktopSettings({ sessionGoalWriterModel: next ?? '', sessionGoalWriterVariant: '' });
    } catch (error) {
      console.warn('Failed to save the goal writer model:', error);
    }
  }, []);

  const handleVariantChange = React.useCallback(async (next: string | undefined) => {
    setVariant(next);
    try {
      await updateDesktopSettings({ sessionGoalWriterVariant: next ?? '' });
    } catch (error) {
      console.warn('Failed to save the goal writer effort:', error);
    }
  }, []);

  const handleSuggestionApproved = React.useCallback((settings: { sessionGoalWriterModel: string; sessionGoalWriterVariant: string }) => {
    setModel(settings.sessionGoalWriterModel || undefined);
    setVariant(settings.sessionGoalWriterVariant || undefined);
  }, []);

  return (
    <>
    <SettingsFieldRow
      settingsItem="chat.session-goal-writer-model"
      label={t('settings.openchamber.visual.goal.writer.modelLabel')}
      info={t('settings.openchamber.visual.goal.writer.modelInfo')}
    >
      <div className="flex flex-wrap items-center gap-2">
      <div className={cn(disabled && 'pointer-events-none opacity-50')} aria-disabled={disabled || undefined}>
        <ModelSelector
          providerId={parsed.providerId}
          modelId={parsed.modelId}
          onChange={(providerId, modelId) => {
            void handleChange(providerId, modelId);
          }}
          allowedProviderIds={providers}
          placeholder={t('settings.openchamber.visual.goal.writer.modelSessionDefault')}
          className={SETTINGS_CUSTOM_TRIGGER_CLASS}
        />
      </div>
      {variants.length > 0 ? (
        <Select
          value={variant ?? NO_VARIANT_VALUE}
          onValueChange={(value) => void handleVariantChange(value === NO_VARIANT_VALUE ? undefined : value)}
          disabled={disabled}
        >
          <SelectTrigger className={SETTINGS_SELECT_ROW_TRIGGER_CLASS} aria-label={t('settings.openchamber.visual.goal.writer.effortLabel')}>
            <SelectValue>{variant ? formatVariantLabel(variant) : t('chat.goal.writer.picker.effortDefault')}</SelectValue>
          </SelectTrigger>
          <SelectContent>
            <SelectItem value={NO_VARIANT_VALUE}>{t('chat.goal.writer.picker.effortDefault')}</SelectItem>
            {variants.map((entry) => (
              <SelectItem key={entry} value={entry}>{formatVariantLabel(entry)}</SelectItem>
            ))}
          </SelectContent>
        </Select>
      ) : null}
      </div>
    </SettingsFieldRow>
    {/* Shown only where the goal section is: never in VS Code. */}
    <GoalWriterChoiceSuggestion disabled={disabled} onApproved={handleSuggestionApproved} />
    </>
  );
};
