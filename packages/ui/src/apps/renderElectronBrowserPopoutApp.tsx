import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';
import '@/styles/fonts';
import '@/index.css';
import '@/lib/debug';
import { SessionAuthGate } from '@/components/auth/SessionAuthGate';
import { ThemeProvider } from '@/components/providers/ThemeProvider';
import { ThemeSystemProvider } from '@/contexts/ThemeSystemContext';
import type { RuntimeAPIs } from '@/lib/api/types';
import { startAppearanceAutoSave } from '@/lib/appearanceAutoSave';
import { applyPersistedDirectoryPreferences } from '@/lib/directoryPersistence';
import { initializeLocale, I18nProvider } from '@/lib/i18n';
import { initializeAppearancePreferences, syncDesktopSettings } from '@/lib/persistence';
import { startTypographyWatcher } from '@/lib/typographyWatcher';
import { ElectronBrowserPopoutApp } from './ElectronBrowserPopoutApp';

const initializeSharedPreferences = () => {
  initializeLocale();

  void initializeAppearancePreferences().then(() => {
    void Promise.all([
      syncDesktopSettings(),
      applyPersistedDirectoryPreferences(),
    ]).catch((err) => {
      console.error('[browser-popout] settings init failed:', err);
    });

    startAppearanceAutoSave();
    startTypographyWatcher();
  }).catch((err) => {
    console.error('[browser-popout] appearance init failed:', err);
  });
};

export function renderElectronBrowserPopoutApp(apis: RuntimeAPIs) {
  initializeSharedPreferences();

  const rootElement = document.getElementById('root');
  if (!rootElement) {
    throw new Error('Root element not found');
  }

  createRoot(rootElement).render(
    <StrictMode>
      <I18nProvider>
        <ThemeSystemProvider>
          <ThemeProvider>
            <SessionAuthGate>
              <ElectronBrowserPopoutApp apis={apis} />
            </SessionAuthGate>
          </ThemeProvider>
        </ThemeSystemProvider>
      </I18nProvider>
    </StrictMode>,
  );
}
