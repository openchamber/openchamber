import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';
import { createConfiguredWebAPIs } from './runtimeConfig';
import type { RuntimeAPIs } from '@openchamber/ui/lib/api/types';
import { initializeLocale, I18nProvider } from '@openchamber/ui/lib/i18n';
import { ThemeSystemProvider } from '@openchamber/ui/contexts/ThemeSystemContext';
import { ThemeProvider } from '@openchamber/ui/components/providers/ThemeProvider';
import { RuntimeAPIProvider } from '@openchamber/ui/contexts/RuntimeAPIProvider';
import { PetOverlay } from '@openchamber/ui/components/chat/pets/PetOverlay';
import '@openchamber/ui/index.css';
import '@openchamber/ui/styles/fonts';
// Must load after the shared index.css so the transparent page background
// wins the cascade over the shared body background rules.
import './pet-overlay.css';

declare global {
  interface Window {
    __OPENCHAMBER_RUNTIME_APIS__?: RuntimeAPIs;
  }
}

window.__OPENCHAMBER_RUNTIME_APIS__ = createConfiguredWebAPIs();

const rootElement = document.getElementById('root');
if (!rootElement) {
  throw new Error('Root element not found');
}

initializeLocale();

createRoot(rootElement).render(
  <StrictMode>
    <I18nProvider>
      {/* The pet overlay shares the main window's origin, so the theme
          system hydrates from the same localStorage and applies the theme
          CSS variables the status bubble needs (surface/foreground/border). */}
      <ThemeSystemProvider>
        <ThemeProvider>
          <RuntimeAPIProvider apis={window.__OPENCHAMBER_RUNTIME_APIS__ ?? createConfiguredWebAPIs()}>
            <PetOverlay />
          </RuntimeAPIProvider>
        </ThemeProvider>
      </ThemeSystemProvider>
    </I18nProvider>
  </StrictMode>,
);
