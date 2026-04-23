import { StrictMode } from 'react'
import { createRoot } from 'react-dom/client'
import './styles/fonts'
import './index.css'
import App from './App.tsx'
import { SessionAuthGate } from './components/auth/SessionAuthGate'
import { ThemeSystemProvider } from './contexts/ThemeSystemContext'
import { ThemeProvider } from './components/providers/ThemeProvider'
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

// Keep appearance preferences blocking to avoid FOUC (flash of
// unstyled content) for users with non-default themes. Defer the
// remaining settings so they don't block first paint.
void initializeAppearancePreferences().then(() => {
  void Promise.all([
    syncDesktopSettings(),
    applyPersistedDirectoryPreferences(),
  ]).then(() => {
    startAppearanceAutoSave();
    startModelPrefsAutoSave();
    startTypographyWatcher();
  }).catch((err) => {
    console.error('[main] settings init failed:', err);
  });
}).catch((err) => {
  console.error('[main] appearance init failed:', err);
});


const rootElement = document.getElementById('root');
if (!rootElement) {
  throw new Error('Root element not found');
}

createRoot(rootElement).render(
  <StrictMode>
    <ThemeSystemProvider>
      <ThemeProvider>
        <SessionAuthGate>
          <App apis={runtimeAPIs} />
        </SessionAuthGate>
      </ThemeProvider>
    </ThemeSystemProvider>
  </StrictMode>,
);
