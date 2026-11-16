import React from 'react';

import {
  SettingsChipGroup,
  SettingsFieldRow,
  SettingsSection,
} from '@/components/sections/shared/SettingsSection';
import { useI18n, type I18nKey } from '@/lib/i18n';
import { canKeepScreenAwake } from '@/lib/platform';
import { useUIStore, type MobileKeepScreenAwake } from '@/stores/useUIStore';

const KEEP_SCREEN_AWAKE_OPTIONS: Array<{ value: MobileKeepScreenAwake; labelKey: I18nKey }> = [
  { value: 'off', labelKey: 'settings.mobileApp.keepScreenAwake.option.off' },
  { value: 'working', labelKey: 'settings.mobileApp.keepScreenAwake.option.working' },
  { value: 'always', labelKey: 'settings.mobileApp.keepScreenAwake.option.always' },
];

/** The phone app itself. Shares General's first slot with the desktop app section. */
export const MobileAppSettings: React.FC = () => {
  const { t } = useI18n();
  const keepScreenAwake = useUIStore((state) => state.mobileKeepScreenAwake);
  const setKeepScreenAwake = useUIStore((state) => state.setMobileKeepScreenAwake);

  if (!canKeepScreenAwake()) return null;

  return (
    <SettingsSection title={t('settings.layout.general.mobileApp.title')}>
      <SettingsFieldRow
        label={t('settings.mobileApp.keepScreenAwake.label')}
        info={t('settings.mobileApp.keepScreenAwake.info')}
        settingsItem="general.keep-screen-awake"
      >
        <SettingsChipGroup
          value={keepScreenAwake}
          options={KEEP_SCREEN_AWAKE_OPTIONS.map((option) => ({ value: option.value, label: t(option.labelKey) }))}
          onChange={setKeepScreenAwake}
          aria-label={t('settings.mobileApp.keepScreenAwake.label')}
        />
      </SettingsFieldRow>
    </SettingsSection>
  );
};
