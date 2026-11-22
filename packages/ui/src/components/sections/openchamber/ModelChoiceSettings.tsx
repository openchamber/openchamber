import React from 'react';

import { Button } from '@/components/ui/button';
import {
  SETTINGS_HELPER_CLASS,
  SettingsCheckboxRow,
  SettingsFieldRow,
  SettingsInset,
  SettingsSection,
} from '@/components/sections/shared/SettingsSection';
import { useI18n } from '@/lib/i18n';
import {
  answerModelChoiceSuggestion,
  clearModelChoices,
  readModelChoices,
  type ModelChoiceSuggestion,
} from '@/lib/modelChoices';
import { useUIStore } from '@/stores/useUIStore';

type HistoryView =
  | { kind: 'loading' }
  | { kind: 'error' }
  | { kind: 'ready'; total: number };

/**
 * Settings → Chat → Assistance → Model choices: whether the server records
 * the models and efforts picked by hand, how many choices it keeps, and a
 * button that clears them. Not offered in VS Code, which has no OpenChamber
 * server.
 */
export const ModelChoiceSettings: React.FC = () => {
  const { t } = useI18n();
  const enabled = useUIStore((state) => state.modelChoiceRecordingEnabled);
  const setEnabled = useUIStore((state) => state.setModelChoiceRecordingEnabled);
  const [view, setView] = React.useState<HistoryView>({ kind: 'loading' });
  const [working, setWorking] = React.useState(false);

  React.useEffect(() => {
    const controller = new AbortController();
    readModelChoices(controller.signal)
      .then((summary) => setView({ kind: 'ready', total: summary.total }))
      .catch(() => {
        if (!controller.signal.aborted) setView({ kind: 'error' });
      });
    return () => controller.abort();
  }, []);

  const handleClear = React.useCallback(() => {
    setWorking(true);
    clearModelChoices()
      .then(() => setView({ kind: 'ready', total: 0 }))
      .catch(() => setView({ kind: 'error' }))
      .finally(() => setWorking(false));
  }, []);

  let statusText: string;
  if (view.kind === 'loading') statusText = t('settings.openchamber.modelChoices.status.loading');
  else if (view.kind === 'error') statusText = t('settings.openchamber.modelChoices.status.error');
  else statusText = t('settings.openchamber.modelChoices.status.count', { count: view.total });

  return (
    <SettingsSection title={t('settings.openchamber.modelChoices.title')} settingsItem="chat.model-choices">
      <SettingsCheckboxRow
        settingsItem="chat.model-choice-recording"
        checked={enabled}
        onChange={setEnabled}
        label={t('settings.openchamber.modelChoices.field.enabled')}
        ariaLabel={t('settings.openchamber.modelChoices.field.enabled')}
        info={t('settings.openchamber.modelChoices.field.enabledInfo')}
      />
      <SettingsInset>
        <SettingsFieldRow label={t('settings.openchamber.modelChoices.field.history')}>
          <Button
            type="button"
            variant="outline"
            size="xs"
            className="!font-normal"
            onClick={handleClear}
            disabled={working || view.kind === 'loading' || (view.kind === 'ready' && view.total === 0)}
          >
            {working ? t('settings.openchamber.modelChoices.actions.working') : t('settings.openchamber.modelChoices.actions.clear')}
          </Button>
        </SettingsFieldRow>
        <p className={SETTINGS_HELPER_CLASS} aria-live="polite">{statusText}</p>
      </SettingsInset>
    </SettingsSection>
  );
};

const formatEffort = (variant: string): string => variant.charAt(0).toUpperCase() + variant.slice(1);

const modelIdOf = (ref: string): string => ref.slice(ref.indexOf('/') + 1);

/**
 * The goal writer default the recorded goal-window picks support, shown
 * under the goal writer model field with Approve and Decline. Approve has the
 * server write the setting and hands the written values back so the field
 * shows them; either answer is final, and the server never offers that
 * suggestion again. Nothing shows while recording is off, the history cannot
 * be read, or no habit is clear.
 */
export const GoalWriterChoiceSuggestion: React.FC<{
  disabled?: boolean;
  onApproved: (settings: { sessionGoalWriterModel: string; sessionGoalWriterVariant: string }) => void;
}> = ({ disabled = false, onApproved }) => {
  const { t } = useI18n();
  const enabled = useUIStore((state) => state.modelChoiceRecordingEnabled);
  const [suggestion, setSuggestion] = React.useState<ModelChoiceSuggestion | null>(null);
  const [working, setWorking] = React.useState(false);
  const [failed, setFailed] = React.useState(false);

  React.useEffect(() => {
    if (!enabled) {
      setSuggestion(null);
      return;
    }
    const controller = new AbortController();
    readModelChoices(controller.signal)
      .then((summary) => setSuggestion(summary.suggestions.find((entry) => entry.surface === 'goal-writer') ?? null))
      .catch(() => {
        if (!controller.signal.aborted) setSuggestion(null);
      });
    return () => controller.abort();
  }, [enabled]);

  if (!suggestion) return null;

  const answer = (decision: 'approved' | 'declined') => {
    setWorking(true);
    setFailed(false);
    answerModelChoiceSuggestion(suggestion.id, decision)
      .then((settings) => {
        if (settings) onApproved(settings);
        setSuggestion(null);
      })
      .catch(() => setFailed(true))
      .finally(() => setWorking(false));
  };

  const params = { model: modelIdOf(suggestion.model), count: suggestion.count, total: suggestion.total };
  const text = suggestion.variant
    ? t('settings.openchamber.modelChoices.suggestion.goalWriter', { ...params, effort: formatEffort(suggestion.variant) })
    : t('settings.openchamber.modelChoices.suggestion.goalWriterDefaultEffort', params);

  return (
    <div className="flex flex-col gap-1.5 py-1.5">
      <p className="typography-meta text-foreground">{text}</p>
      <div className="flex flex-wrap items-center gap-2">
        <Button type="button" variant="default" size="xs" disabled={disabled || working} onClick={() => answer('approved')}>
          {t('settings.openchamber.modelChoices.suggestion.approve')}
        </Button>
        <Button type="button" variant="ghost" size="xs" disabled={disabled || working} onClick={() => answer('declined')}>
          {t('settings.openchamber.modelChoices.suggestion.decline')}
        </Button>
        {failed ? (
          <span className={SETTINGS_HELPER_CLASS} role="alert">{t('settings.openchamber.modelChoices.suggestion.failed')}</span>
        ) : null}
      </div>
    </div>
  );
};
