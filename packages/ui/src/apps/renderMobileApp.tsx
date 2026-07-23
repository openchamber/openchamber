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
import { installMobileWidgetSnapshotBridge } from './mobileWidgetSnapshot';
import { applyPersistedDirectoryPreferences } from '@/lib/directoryPersistence';
import { initializeLocale, I18nProvider } from '@/lib/i18n';
import { initializeAppearancePreferences, syncDesktopSettings } from '@/lib/persistence';
import { startModelPrefsAutoSave } from '@/lib/modelPrefsAutoSave';
import { startTypographyWatcher } from '@/lib/typographyWatcher';
import { preloadMarkdownRenderer } from '@/components/chat/markdownRendererLoader';
import { SessionAuthGate } from '@/components/auth/SessionAuthGate';
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
  preloadMarkdownRenderer();
  initializeSharedPreferences();

  // Expose the widget snapshot builder so the native shell can read the session overview
  // (attention count + recent sessions) and feed the home/lock-screen/Control Center widgets.
  installMobileWidgetSnapshotBridge();

  // Apply the device classes (`device-mobile`, `mobile-pointer`) to <html> BEFORE the
  // first React paint. They gate the mobile typography rules in mobile.css (larger
  // --text-* sizes); applied late from a hook effect, they bumped text size a frame
  // after mount and shifted the layout (connect / scan / saved-connection labels).
  getDeviceInfo();

  const rootElement = document.getElementById('root');
  if (!rootElement) {
    throw new Error('Root element not found');
  }

  // The native Capacitor app delivers notifications via APNs only (background, server-side
  // focus-gated). Disable the in-app notification dispatch on native with a no-op
  // notifications API: scheduling local notifications can't tell foreground from background
  // in a WKWebView and leaked while the app was open. (The Web Notifications API the web
  // runtime uses also doesn't display inside a WKWebView.)
  const capacitor = (window as typeof window & { Capacitor?: { isNativePlatform?: () => boolean } }).Capacitor;
  const isNativeShell = capacitor?.isNativePlatform?.() === true || window.location.protocol === 'capacitor:';
  const resolvedApis = isNativeShell
    ? { ...apis, notifications: { notifyAgentCompletion: async () => false, canNotify: () => false } }
    : apis;

  // Auth gating differs by shell: the native Capacitor app authenticates via
  // its own instance-connect flow (MobileConnectionWelcome asks for the
  // password per instance), while the plain mobile BROWSER against a
  // --ui-password server must keep the classic SessionAuthGate unlock page.
  const app = <MobileApp apis={resolvedApis} />;

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
