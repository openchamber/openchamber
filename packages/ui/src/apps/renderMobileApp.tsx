import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';
import '@/styles/fonts';
import '@/index.css';
import '@/lib/debug';
import { DiffWorkerProvider } from '@/contexts/DiffWorkerProvider';
import { ThemeProvider } from '@/components/providers/ThemeProvider';
import { ThemeSystemProvider } from '@/contexts/ThemeSystemContext';
import type { RuntimeAPIs } from '@/lib/api/types';
import { startAppearanceAutoSave } from '@/lib/appearanceAutoSave';
import { getDeviceInfo } from '@/lib/device';
import { markAppBootReady } from './appBootReady';
import { applyPersistedDirectoryPreferences } from '@/lib/directoryPersistence';
import { initializeLocale, I18nProvider } from '@/lib/i18n';
import { initializeAppearancePreferences, syncDesktopSettings } from '@/lib/persistence';
import { startModelPrefsAutoSave } from '@/lib/modelPrefsAutoSave';
import { startTypographyWatcher } from '@/lib/typographyWatcher';
import { MobileApp } from './MobileApp';

const initializeSharedPreferences = () => {
  initializeLocale();

  void initializeAppearancePreferences().then(() => {
    void Promise.all([
      syncDesktopSettings(),
      applyPersistedDirectoryPreferences(),
    ]).catch((err) => {
      console.error('[mobile-main] settings init failed:', err);
    });

    startAppearanceAutoSave();
    startModelPrefsAutoSave();
    startTypographyWatcher();
  }).catch((err) => {
    console.error('[mobile-main] appearance init failed:', err);
  }).finally(() => {
    // Persisted typography/appearance is now applied — release the splash gate so the
    // first UI paint is already at its final sizes.
    markAppBootReady();
  });
};

export function renderMobileApp(apis: RuntimeAPIs) {
  initializeSharedPreferences();

  // Apply the device classes (`device-mobile`, `mobile-pointer`) to <html> BEFORE the
  // first React paint. They gate the mobile typography rules in mobile.css (larger
  // --text-* sizes); applied late from a hook effect, they bumped text size a frame
  // after mount and shifted the layout (connect / scan / saved-connection labels).
  getDeviceInfo();

  const rootElement = document.getElementById('root');
  if (!rootElement) {
    throw new Error('Root element not found');
  }

  createRoot(rootElement).render(
    <StrictMode>
      <I18nProvider>
        <ThemeSystemProvider>
          <ThemeProvider>
            <DiffWorkerProvider>
              <MobileApp apis={apis} />
            </DiffWorkerProvider>
          </ThemeProvider>
        </ThemeSystemProvider>
      </I18nProvider>
    </StrictMode>,
  );
}
