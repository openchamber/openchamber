import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';
import '@/styles/fonts';
import '@/index.css';
import '@/lib/debug';
import { ThemeProvider } from '@/components/providers/ThemeProvider';
import { ThemeSystemProvider } from '@/contexts/ThemeSystemContext';
import type { RuntimeAPIs } from '@/lib/api/types';
import { initializeLocale, I18nProvider } from '@/lib/i18n';
import { initializeAppearancePreferences, syncDesktopSettings } from '@/lib/persistence';
import { ElectronPetApp } from './ElectronPetApp';

// The pet only needs locale + appearance so its status bubble matches the user's
// theme. It deliberately skips the chat-only preference machinery (model prefs,
// directory persistence, typography watcher) the mini-chat root sets up.
const initializePetPreferences = () => {
  initializeLocale();

  void initializeAppearancePreferences()
    .then(() => syncDesktopSettings())
    .catch((err) => {
      console.error('[pet-main] settings init failed:', err);
    });
};

export function renderElectronPetApp(apis: RuntimeAPIs) {
  initializePetPreferences();

  const rootElement = document.getElementById('root');
  if (!rootElement) {
    throw new Error('Root element not found');
  }

  // No SessionAuthGate: the pet makes no authenticated OpenCode calls, so gating
  // it behind UI auth would only blank the overlay on password-protected setups.
  createRoot(rootElement).render(
    <StrictMode>
      <I18nProvider>
        <ThemeSystemProvider>
          <ThemeProvider>
            <ElectronPetApp apis={apis} />
          </ThemeProvider>
        </ThemeSystemProvider>
      </I18nProvider>
    </StrictMode>,
  );
}
