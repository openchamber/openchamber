import React from 'react';

import { SettingsCheckboxRow, SettingsSection } from '@/components/sections/shared/SettingsSection';
import { useI18n } from '@/lib/i18n';
import { useSessionDisplayStore } from '@/stores/useSessionDisplayStore';

export const MobileLandingSettings: React.FC = () => {
  const { t } = useI18n();
  const mobileLandingMode = useSessionDisplayStore((state) => state.mobileLandingMode);
  const setMobileLandingMode = useSessionDisplayStore((state) => state.setMobileLandingMode);

  return (
    <SettingsSection title={t('settings.openchamber.mobileLanding.title')}>
      <SettingsCheckboxRow
        settingsItem="sessions.mobile-landing"
        label={t('settings.openchamber.mobileLanding.recents.label')}
        info={t('settings.openchamber.mobileLanding.recents.description')}
        checked={mobileLandingMode === 'recents'}
        onChange={(checked) => setMobileLandingMode(checked ? 'recents' : 'last-session')}
      />
    </SettingsSection>
  );
};
