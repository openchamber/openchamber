import React from 'react';
import { SettingsCheckboxRow, SettingsSection } from '@/components/sections/shared/SettingsSection';
import { useI18n } from '@/lib/i18n';
import { useUIStore } from '@/stores/useUIStore';

/**
 * "In work": the sidebar block, the Track / Done actions, and sessions going
 * in on a sent message. Jev decides nothing here (it only hints that work
 * looks done, which the section's info explains), so no Jev access note.
 */
export const SessionWorkSettings: React.FC = () => {
  const { t } = useI18n();
  const enabled = useUIStore((state) => state.sessionWorkEnabled);
  const setEnabled = useUIStore((state) => state.setSessionWorkEnabled);

  return (
    <SettingsSection
      title={t('settings.openchamber.sessionWork.title')}
      info={t('settings.openchamber.sessionWork.info')}
      settingsItem="sessions.work"
    >
      <SettingsCheckboxRow
        settingsItem="sessions.work-enabled"
        checked={enabled}
        onChange={setEnabled}
        label={t('settings.openchamber.sessionWork.field.enabled')}
        ariaLabel={t('settings.openchamber.sessionWork.field.enabled')}
      />
    </SettingsSection>
  );
};
