import { StrictMode } from 'react'
import { createRoot } from 'react-dom/client'
import './i18n'
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

await syncDesktopSettings();
await initializeAppearancePreferences();
startAppearanceAutoSave();
startModelPrefsAutoSave();
startTypographyWatcher();
await applyPersistedDirectoryPreferences();

if (typeof window !== 'undefined') {
  (window as { debugContextTokens?: () => void }).debugContextTokens = () => {
    const sessionStore = (window as { __zustand_session_store__?: { getState: () => { currentSessionId?: string; messages: Map<string, { info: { role: string }; parts: { type: string }[] }[]>; sessionContextUsage: Map<string, unknown>; getContextUsage: (contextLimit: number, outputLimit: number) => unknown } } }).__zustand_session_store__;
    if (!sessionStore) {
      return;
    }

    const state = sessionStore.getState();
    const currentSessionId = state.currentSessionId;

    if (!currentSessionId) {
      return;
    }

    const sessionMessages = state.messages.get(currentSessionId) || [];
    const assistantMessages = sessionMessages.filter((m: { info: { role: string } }) => m.info.role === 'assistant');

    if (assistantMessages.length === 0) {
      return;
    }

    const lastMessage = assistantMessages[assistantMessages.length - 1];
    const tokens = (lastMessage.info as { tokens?: { input?: number; output?: number; reasoning?: number; cache?: { read?: number; write?: number } } }).tokens;

    if (tokens && typeof tokens === 'object') {

      console.debug('Token breakdown:', {
        base: (tokens.input || 0) + (tokens.output || 0) + (tokens.reasoning || 0),
        cache: tokens.cache ? (tokens.cache.read || 0) + (tokens.cache.write || 0) : 0
      });
    }

    void state.sessionContextUsage.get(currentSessionId);

    const configStore = (window as { __zustand_config_store__?: { getState: () => { getCurrentModel: () => { limit?: { context?: number } } | null } } }).__zustand_config_store__;
    if (configStore) {
      const currentModel = configStore.getState().getCurrentModel();
      const contextLimit = currentModel?.limit?.context || 0;
      const outputLimit =
        currentModel && currentModel.limit && typeof currentModel.limit === 'object'
          ? Math.max(((currentModel.limit as { output?: number }).output ?? 0), 0)
          : 0;

      if (contextLimit > 0) {

        void state.getContextUsage(contextLimit, outputLimit);
      }
    }
  };

}

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
