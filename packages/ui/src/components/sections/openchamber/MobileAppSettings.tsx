import { SettingsSection, SettingsFieldRow, SettingsChipGroup, SETTINGS_HELPER_CLASS } from '@/components/sections/shared/SettingsSection';
import { useI18n } from '@/lib/i18n';
import { useUIStore } from '@/stores/useUIStore';

export function MobileAppSettings() {
  const { t } = useI18n();
  const mode = useUIStore((state) => state.mobileScreenAwakeMode);
  const setMode = useUIStore((state) => state.setMobileScreenAwakeMode);
  return (
    <SettingsSection title={t('settings.mobile.title')} divider={false}>
      <SettingsFieldRow
        label={t('settings.mobile.screenAwake.label')}
        info={t('settings.mobile.screenAwake.info')}
        settingsItem="general.mobile-screen-awake"
      >
        <SettingsChipGroup
          value={mode}
          onChange={setMode}
          aria-label={t('settings.mobile.screenAwake.label')}
          options={[
            { value: 'off', label: t('settings.mobile.screenAwake.off') },
            { value: 'working', label: t('settings.mobile.screenAwake.working') },
            { value: 'always', label: t('settings.mobile.screenAwake.always') },
          ]}
        />
      </SettingsFieldRow>
      <p className={SETTINGS_HELPER_CLASS}>{t('settings.mobile.screenAwake.battery')}</p>
    </SettingsSection>
  );
}
