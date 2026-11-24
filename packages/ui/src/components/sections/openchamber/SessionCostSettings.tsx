import React from 'react';
import { NumberInput } from '@/components/ui/number-input';
import {
  SettingsSection,
  SettingsFieldRow,
  SettingsCheckboxRow,
  SETTINGS_NUMBER_INPUT_CLASS,
  SETTINGS_NUMBER_STEPPER_ROW_CLASS,
  SETTINGS_NUMBER_UNIT_CLASS,
} from '@/components/sections/shared/SettingsSection';
import { useI18n } from '@/lib/i18n';
import { updateDesktopSettings } from '@/lib/persistence';
import {
  isUsableSessionCostPair,
  selectSessionCostSettings,
  useSessionCostSettingsStore,
  writeSessionCostSettings,
  type SessionCostSettings as SessionCostSettingsValues,
} from '@/stores/useSessionCostSettingsStore';

const saveSessionCostSettings = (changes: Partial<SessionCostSettingsValues>): void => {
  writeSessionCostSettings(changes);
  void updateDesktopSettings(changes);
};

const ThresholdInput: React.FC<{
  value: number;
  onValueChange: (value: number) => void;
  disabled: boolean;
  ariaLabel: string;
}> = ({ value, onValueChange, disabled, ariaLabel }) => (
  <div className={SETTINGS_NUMBER_STEPPER_ROW_CLASS}>
    <NumberInput
      value={value}
      onValueChange={onValueChange}
      min={1}
      step={1}
      inputMode="decimal"
      disabled={disabled}
      deferExternalValueWhileFocused
      className={SETTINGS_NUMBER_INPUT_CLASS}
      aria-label={ariaLabel}
    />
    <span className={SETTINGS_NUMBER_UNIT_CLASS}>USD</span>
  </div>
);

export const SessionCostSettings: React.FC = () => {
  const { t } = useI18n();
  const settings = useSessionCostSettingsStore(selectSessionCostSettings);
  const enabled = settings.sessionCostAlertsEnabled;
  const [unsavedPair, setUnsavedPair] = React.useState<{ warn: number; critical: number } | null>(null);
  const warnThreshold = unsavedPair?.warn ?? settings.sessionCostWarnThreshold;
  const criticalThreshold = unsavedPair?.critical ?? settings.sessionCostCriticalThreshold;

  const savePair = (warn: number, critical: number) => {
    if (!isUsableSessionCostPair(warn, critical)) {
      setUnsavedPair({ warn, critical });
      return;
    }
    setUnsavedPair(null);
    saveSessionCostSettings({ sessionCostWarnThreshold: warn, sessionCostCriticalThreshold: critical });
  };

  return (
    <SettingsSection title={t('settings.openchamber.sessionCost.title')} contentClassName="space-y-3">
      <SettingsCheckboxRow
        checked={enabled}
        onChange={(value) => saveSessionCostSettings({ sessionCostAlertsEnabled: value })}
        label={t('settings.openchamber.sessionCost.field.enabled')}
        ariaLabel={t('settings.openchamber.sessionCost.field.enabled')}
        info={t('settings.openchamber.sessionCost.field.enabledInfo')}
        settingsItem="sessions.cost-alerts"
      />
      <div>
        <SettingsFieldRow label={t('settings.openchamber.sessionCost.field.warnAt')}>
          <ThresholdInput
            value={warnThreshold}
            onValueChange={(value) => savePair(value, criticalThreshold)}
            disabled={!enabled}
            ariaLabel={t('settings.openchamber.sessionCost.field.warnAtAria')}
          />
        </SettingsFieldRow>
        <SettingsFieldRow label={t('settings.openchamber.sessionCost.field.criticalAt')}>
          <ThresholdInput
            value={criticalThreshold}
            onValueChange={(value) => savePair(warnThreshold, value)}
            disabled={!enabled}
            ariaLabel={t('settings.openchamber.sessionCost.field.criticalAtAria')}
          />
        </SettingsFieldRow>
        {enabled && unsavedPair ? (
          <p role="alert" className="typography-meta text-status-error">
            {t('settings.openchamber.sessionCost.field.orderError')}
          </p>
        ) : null}
      </div>
    </SettingsSection>
  );
};
