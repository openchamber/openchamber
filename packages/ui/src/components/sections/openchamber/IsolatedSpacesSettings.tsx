import React from 'react';

import { useI18n } from '@/lib/i18n';
import { updateDesktopSettings } from '@/lib/persistence';
import { useUIStore } from '@/stores/useUIStore';
import { SETTINGS_OPTION_STACK_CLASS, SettingsCheckboxRow, SettingsSection } from '../shared/SettingsSection';

/**
 * The switch of the isolated-spaces feature. The server reads it once when it starts, so the
 * row says the change takes effect after a restart; turning it off live, with the stop of
 * running spaces, is a later stage. Never mounted in VS Code: the feature has no entry point
 * there on purpose (decision 16 of the design), and nowhere until the feature is released,
 * see `lib/spaces/release.ts`.
 */
export const IsolatedSpacesSettings: React.FC = () => {
  const { t } = useI18n();
  const enabled = useUIStore((state) => state.isolatedSpacesEnabled);
  const setEnabled = useUIStore((state) => state.setIsolatedSpacesEnabled);

  const handleChange = React.useCallback((value: boolean) => {
    setEnabled(value);
    void updateDesktopSettings({ isolatedSpacesEnabled: value });
  }, [setEnabled]);

  return (
    <SettingsSection title={t('settings.openchamber.spaces.title')}>
      <div className={SETTINGS_OPTION_STACK_CLASS}>
        <SettingsCheckboxRow
          settingsItem="general.isolated-spaces"
          checked={enabled}
          onChange={handleChange}
          label={t('settings.openchamber.spaces.field.enabled')}
          ariaLabel={t('settings.openchamber.spaces.field.enabledAria')}
          description={t('settings.openchamber.spaces.field.enabledRestart')}
          info={t('settings.openchamber.spaces.field.enabledInfo')}
        />
      </div>
    </SettingsSection>
  );
};
