import React from 'react';
import { Switch } from '@/components/ui/switch';
import { SETTINGS_HELPER_CLASS, SettingsFieldRow } from '@/components/sections/shared/SettingsSection';
import { RangedNumberField } from '@/components/sections/routing/RangedNumberField';
import { useI18n } from '@/lib/i18n';
import type { ModelRouteTuning } from '@/lib/routing/modelRoutesApi';
import { tuningToSave, withOptional } from '@/lib/routing/poolAdvanced';

/** Scheduled review of routing history: whether it runs, how often, and how much history it reads. */
export const RouteTuningFields: React.FC<{
  tuning: ModelRouteTuning | null;
  onSave: (tuning: ModelRouteTuning | null) => void;
}> = ({ tuning, onSave }) => {
  const { t } = useI18n();
  const current: ModelRouteTuning = tuning ?? {};

  const update = (key: keyof ModelRouteTuning, value: unknown) =>
    onSave(tuningToSave(withOptional(current, key, value) as ModelRouteTuning));

  return (
    <div className="space-y-3">
      <SettingsFieldRow label={t('settings.pools.tuning.enabled')} description={t('settings.pools.tuning.info')} settingsItem="routing.pools-tuning">
        <Switch checked={current.enabled === true} onCheckedChange={(checked) => update('enabled', checked)} aria-label={t('settings.pools.tuning.enabled')} />
      </SettingsFieldRow>
      <div className="grid grid-cols-1 gap-3 sm:grid-cols-2">
        <RangedNumberField
          label={t('settings.pools.tuning.interval')}
          value={current.intervalMinutes}
          min={1}
          max={1440}
          placeholder="15"
          onCommit={(value) => update('intervalMinutes', value)}
        />
        <RangedNumberField
          label={t('settings.pools.tuning.window')}
          value={current.windowHours}
          min={1}
          max={336}
          placeholder="24"
          onCommit={(value) => update('windowHours', value)}
        />
      </div>
      <p className={SETTINGS_HELPER_CLASS}>{t('settings.pools.tuning.help')}</p>
    </div>
  );
};
