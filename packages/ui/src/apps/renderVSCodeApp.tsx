import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';
import '@/styles/fonts';
import '@/styles/katex-css';
import '@/index.css';
import '@/lib/debug';
import { SessionAuthGate } from '@/components/auth/SessionAuthGate';
import { ThemeProvider } from '@/components/providers/ThemeProvider';
import { OpenCodeCompatibilityGate } from '@/components/update/OpenCodeCompatibilityGate';
import { ThemeSystemProvider } from '@/contexts/ThemeSystemContext';
import type { RuntimeAPIs } from '@/lib/api/types';
import { I18nProvider } from '@/lib/i18n';
import { VSCodeApp } from './VSCodeApp';
import { initializeSharedPreferences } from './initializeSharedPreferences';

export function renderVSCodeApp(apis: RuntimeAPIs) {
  initializeSharedPreferences({ logLabel: '[vscode-main]' });

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
              <OpenCodeCompatibilityGate>
                <VSCodeApp apis={apis} />
              </OpenCodeCompatibilityGate>
            </SessionAuthGate>
          </ThemeProvider>
        </ThemeSystemProvider>
      </I18nProvider>
    </StrictMode>,
  );
}
