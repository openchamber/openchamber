import React from 'react';
import { SettingsCheckboxRow, SettingsSection } from '@/components/sections/shared/SettingsSection';
import { isDesktopShell, isVSCodeRuntime, isWebRuntime } from '@/lib/desktop';
import { useDeviceInfo } from '@/lib/device';
import { useI18n } from '@/lib/i18n';
import { updateDesktopSettings } from '@/lib/persistence';
import { useUIStore } from '@/stores/useUIStore';

export const SessionNavigationSettings: React.FC = () => {
  const { t } = useI18n();
  const { isMobile } = useDeviceInfo();
  const recentSessionCyclingEnabled = useUIStore((state) => state.recentSessionCyclingEnabled);
  const setRecentSessionCyclingEnabled = useUIStore((state) => state.setRecentSessionCyclingEnabled);

  if (isMobile || isVSCodeRuntime()) return null;

  const showBrowserWarning = isWebRuntime() && !isDesktopShell();
  const handleChange = (enabled: boolean) => {
    setRecentSessionCyclingEnabled(enabled);
    void updateDesktopSettings({ recentSessionCyclingEnabled: enabled });
  };

  return (
    <SettingsSection
      title={t('settings.openchamber.sessionNavigation.title')}
    >
      <SettingsCheckboxRow
        settingsItem="sessions.recent-session-cycling"
        checked={recentSessionCyclingEnabled}
        onChange={handleChange}
        label={t('settings.openchamber.sessionNavigation.field.cycleRecentSessions')}
        ariaLabel={t('settings.openchamber.sessionNavigation.field.cycleRecentSessions')}
        info={t('settings.openchamber.sessionNavigation.field.cycleRecentSessionsInfo')}
        description={showBrowserWarning
          ? t('settings.openchamber.sessionNavigation.field.browserWarning')
          : undefined}
      />
    </SettingsSection>
  );
};
