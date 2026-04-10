import { StrictMode } from 'react'
import { createRoot } from 'react-dom/client'
import { I18nextProvider } from 'react-i18next'
import './styles/fonts'
import './index.css'
import App from './App.tsx'
import { SessionAuthGate } from './components/auth/SessionAuthGate'
import { ThemeSystemProvider } from './contexts/ThemeSystemContext'
import { ThemeProvider } from './components/providers/ThemeProvider'
import i18n from './i18n'
import './lib/debug'
import { syncDesktopSettings, initializeAppearancePreferences } from './lib/persistence'
import { startAppearanceAutoSave } from './lib/appearanceAutoSave'
import { applyPersistedDirectoryPreferences } from './lib/directoryPersistence'
import { startTypographyWatcher } from './lib/typographyWatcher'
import { startModelPrefsAutoSave } from './lib/modelPrefsAutoSave'
import type { RuntimeAPIs } from './lib/api/types'

declare global {
  interface Window {
    __OPENCHAMBER_RUNTIME_APIS__?: RuntimeAPIs;
  }
}

const runtimeAPIs = (typeof window !== 'undefined' && window.__OPENCHAMBER_RUNTIME_APIS__) || (() => {
  throw new Error('Runtime APIs not provided for legacy UI entrypoint.');
})();

await Promise.all([
  syncDesktopSettings(),
  initializeAppearancePreferences(),
  applyPersistedDirectoryPreferences(),
]);
startAppearanceAutoSave();
startModelPrefsAutoSave();
startTypographyWatcher();


const rootElement = document.getElementById('root');
if (!rootElement) {
  throw new Error('Root element not found');
}

createRoot(rootElement).render(
  <StrictMode>
    <I18nextProvider i18n={i18n}>
      <ThemeSystemProvider>
        <ThemeProvider>
          <SessionAuthGate>
            <App apis={runtimeAPIs} />
          </SessionAuthGate>
        </ThemeProvider>
      </ThemeSystemProvider>
    </I18nextProvider>
  </StrictMode>,
);
