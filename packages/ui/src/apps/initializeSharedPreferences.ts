import { startAppearanceAutoSave } from '@/lib/appearanceAutoSave';
import { applyPersistedDirectoryPreferences } from '@/lib/directoryPersistence';
import { initializeLocale } from '@/lib/i18n';
import { startModelPrefsAutoSave } from '@/lib/modelPrefsAutoSave';
import { initializeAppearancePreferences, syncDesktopSettings } from '@/lib/persistence';
import { startTypographyWatcher } from '@/lib/typographyWatcher';
import { startDeviceSettingsReport } from '@/lib/settings/deviceSettingsReport';

type InitializeSharedPreferencesOptions = {
  /** Console prefix for init failures, for example `[vscode-main]`. */
  logLabel: string;
  /** Runs once appearance init settles, whether it succeeded or failed. */
  onAppearanceSettled?: () => void;
  /** Report this window's device settings (`deviceSettingsReport.ts`); off for auxiliary windows. */
  reportDeviceSettings?: boolean;
};

/** Boots the preferences every renderer shares: locale, appearance, directory, and autosave. */
export const initializeSharedPreferences = ({
  logLabel,
  onAppearanceSettled,
  reportDeviceSettings = true,
}: InitializeSharedPreferencesOptions): void => {
  initializeLocale();

  void initializeAppearancePreferences().then(() => {
    void Promise.all([
      syncDesktopSettings(),
      applyPersistedDirectoryPreferences(),
    ]).catch((err) => {
      console.error(`${logLabel} settings init failed:`, err);
    });

    startAppearanceAutoSave();
    startModelPrefsAutoSave();
    startTypographyWatcher();
    if (reportDeviceSettings) startDeviceSettingsReport();
  }).catch((err) => {
    console.error(`${logLabel} appearance init failed:`, err);
  }).finally(() => {
    onAppearanceSettled?.();
  });
};
