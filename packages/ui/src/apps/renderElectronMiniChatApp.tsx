import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';
import '@/styles/fonts';
import '@/styles/katex-css';
import '@/index.css';
import '@/lib/debug';
import { SessionAuthGate } from '@/components/auth/SessionAuthGate';
import { preloadMarkdownRenderer } from '@/components/chat/markdownRendererLoader';
import { ThemeProvider } from '@/components/providers/ThemeProvider';
import { ThemeSystemProvider } from '@/contexts/ThemeSystemContext';
import type { RuntimeAPIs } from '@/lib/api/types';
import { I18nProvider } from '@/lib/i18n';
import { leaveLastActiveSessionToMainWindow } from '@/sync/last-session-cache';
import { prefetchSessionBeforeMount } from '@/sync/sync-context';
import { ElectronMiniChatApp } from './ElectronMiniChatApp';
import { readMiniChatConfig } from './miniChatConfig';
import { initializeSharedPreferences } from './initializeSharedPreferences';

export function renderElectronMiniChatApp(apis: RuntimeAPIs) {
  initializeSharedPreferences({ logLabel: '[mini-chat-main]' });
  leaveLastActiveSessionToMainWindow();
  preloadMarkdownRenderer();
  const { mode, sessionId, directory } = readMiniChatConfig();
  if (mode === 'session' && sessionId && directory) {
    prefetchSessionBeforeMount({ sessionID: sessionId, directory });
  }

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
              <ElectronMiniChatApp apis={apis} />
            </SessionAuthGate>
          </ThemeProvider>
        </ThemeSystemProvider>
      </I18nProvider>
    </StrictMode>,
  );
}
