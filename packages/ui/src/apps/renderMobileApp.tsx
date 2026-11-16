import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';
import '@/styles/fonts';
import '@/styles/katex-css';
import '@/index.css';
import '@/lib/debug';
import { DiffWorkerProvider } from '@/contexts/DiffWorkerProvider';
import { FireworksProvider } from '@/contexts/FireworksContext';
import { ThemeProvider } from '@/components/providers/ThemeProvider';
import { ThemeSystemProvider } from '@/contexts/ThemeSystemContext';
import type { RuntimeAPIs } from '@/lib/api/types';
import { getDeviceInfo } from '@/lib/device';
import { markAppBootReady } from './appBootReady';
import { initializeSharedPreferences } from './initializeSharedPreferences';
import { installMobileWidgetSnapshotBridge } from './mobileWidgetSnapshot';
import { I18nProvider } from '@/lib/i18n';
import { preloadMarkdownRenderer } from '@/components/chat/markdownRendererLoader';
import { SessionAuthGate } from '@/components/auth/SessionAuthGate';
import { MobileApp } from './MobileApp';

export function renderMobileApp(apis: RuntimeAPIs) {
  window.__OPENCHAMBER_SURFACE__ = 'mobile';
  preloadMarkdownRenderer();
  initializeSharedPreferences({
    logLabel: '[mobile-main]',
    onAppearanceSettled: markAppBootReady,
  });

  installMobileWidgetSnapshotBridge();

  getDeviceInfo();

  const rootElement = document.getElementById('root');
  if (!rootElement) {
    throw new Error('Root element not found');
  }

  const capacitor = (window as typeof window & { Capacitor?: { isNativePlatform?: () => boolean } }).Capacitor;
  const isNativeShell = capacitor?.isNativePlatform?.() === true || window.location.protocol === 'capacitor:';
  const resolvedApis = isNativeShell
    ? { ...apis, notifications: { notifyAgentCompletion: async () => false, canNotify: () => false } }
    : apis;

  const app = <FireworksProvider><MobileApp apis={resolvedApis} /></FireworksProvider>;

  createRoot(rootElement).render(
    <StrictMode>
      <I18nProvider>
        <ThemeSystemProvider>
          <ThemeProvider>
            <DiffWorkerProvider>
              {isNativeShell ? app : <SessionAuthGate>{app}</SessionAuthGate>}
            </DiffWorkerProvider>
          </ThemeProvider>
        </ThemeSystemProvider>
      </I18nProvider>
    </StrictMode>,
  );
}
