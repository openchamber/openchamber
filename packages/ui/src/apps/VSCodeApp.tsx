import React from 'react';
import { FireworksProvider } from '@/contexts/FireworksContext';
import { RuntimeAPIProvider } from '@/contexts/RuntimeAPIProvider';
import { useRuntimeAPIs } from '@/hooks/useRuntimeAPIs';
import { registerRuntimeAPIs } from '@/contexts/runtimeAPIRegistry';
import { TooltipProvider } from '@/components/ui/tooltip';
import { Toaster } from '@/components/ui/sonner';
import { ConfigUpdateOverlay } from '@/components/ui/ConfigUpdateOverlay';
import { ErrorBoundary } from '@/components/ui/ErrorBoundary';
import { OpenCodeUpdateToast } from '@/components/update/OpenCodeUpdateToast';
import { AppLinkConfirmDialog } from '@/components/chat/AppLinkConfirmDialog';
import { SharedTrustConfirmDialog } from '@/components/projects/SharedTrustConfirmDialog';
import { VSCodeLayout } from '@/components/layout/VSCodeLayout';
import { useEnterprisePolicySync } from '@/hooks/useEnterprisePolicySync';
import { usePushVisibilityBeacon } from '@/hooks/usePushVisibilityBeacon';
import { useGlobalSessionsPolling } from '@/hooks/useGlobalSessionsPolling';
import { useRouter } from '@/hooks/useRouter';
import { useWindowTitle } from '@/hooks/useWindowTitle';
import { useRootScrollLock } from '@/hooks/useRootScrollLock';
import { useSettingsKeyboardShortcuts } from '@/hooks/useSettingsKeyboardShortcuts';
import { useOnDemandComponent } from '@/hooks/useOnDemandComponent';
import { useDeviceInfo } from '@/lib/device';
import { getVSCodeBootstrapConfig } from '@/lib/vscodeBootstrap';
import { useConfigStore } from '@/stores/useConfigStore';
import { toast } from '@/components/ui';
import { opencodeClient } from '@/lib/opencode/client';
import type { RuntimeAPIs } from '@/lib/api/types';
import { useSourceControlAuthStore } from '@/stores/useSourceControlAuthStore';
import { useSourceControlProviderRegistry } from '@/lib/source-control/providers/registry';
import { useDirectoryStore } from '@/stores/useDirectoryStore';
import { useUIStore } from '@/stores/useUIStore';
import { onHostSurfaceSeen } from '@/lib/surfaceAttention';
import { markSessionViewed } from '@/sync/notification-store';
import { useSessionUIStore } from '@/sync/session-ui-store';
import { SyncProvider } from '@/sync/sync-context';
import { SyncAppEffects } from './AppEffects';
import { useAppFontEffects } from './useAppFontEffects';
import { connectVSCodeSettingsNavigation } from './vscodeSettingsNavigation';

const loadSettingsView = () => import('@/components/views/SettingsView').then((module) => module.SettingsView);

function VSCodeSettings() {
  const apis = useRuntimeAPIs();
  const { screenWidth } = useDeviceInfo();
  useSettingsKeyboardShortcuts();
  const close = React.useCallback(() => {
    void apis.vscode?.executeCommand('openchamber.closeSettings').catch((error: Error) => {
      toast.error(error.message);
    });
  }, [apis.vscode]);
  const SettingsView = useOnDemandComponent(true, loadSettingsView, close);

  React.useEffect(() => {
    useUIStore.getState().setSettingsDialogOpen(true);
    void useConfigStore.getState().loadSessionDefaults();
    const unsubscribe = useUIStore.subscribe((state, previous) => {
      if (!state.isSettingsDialogOpen && previous.isSettingsDialogOpen) close();
    });
    // Navigation can arrive before the Settings chunk has loaded. The host
    // waits for this mounted owner and retains only the newest request.
    void apis.vscode?.executeCommand('openchamber.settingsReady').catch((error: Error) => {
      toast.error(error.message);
    });
    return unsubscribe;
  }, [apis.vscode, close]);

  return SettingsView ? <SettingsView onClose={close} forceMobile={screenWidth < 550} isWindowed /> : null;
}

type VSCodeAppProps = {
  apis: RuntimeAPIs;
};

export function VSCodeApp({ apis }: VSCodeAppProps) {
  const isSettingsPanel = getVSCodeBootstrapConfig()?.panelType === 'settings';
  const currentDirectory = useDirectoryStore((state) => state.currentDirectory);
  const error = useSessionUIStore((state) => state.error);
  const clearError = useSessionUIStore((state) => state.clearError);
  const wideChatLayoutEnabled = useUIStore((state) => state.wideChatLayoutEnabled);
  const refreshSourceControlAuth = useSourceControlAuthStore((state) => state.refreshAll);
  const refreshSourceControlProviders = useSourceControlProviderRegistry((state) => state.refresh);

  React.useEffect(() => {
    registerRuntimeAPIs(apis);
    return () => registerRuntimeAPIs(null);
  }, [apis]);

  useAppFontEffects();
  usePushVisibilityBeacon({ enabled: true });
  useWindowTitle();
  useRootScrollLock();
  useRouter();
  useGlobalSessionsPolling(!isSettingsPanel);
  useEnterprisePolicySync();

  React.useEffect(() => {
    if (isSettingsPanel || !apis.vscode) return;
    return connectVSCodeSettingsNavigation(apis.vscode, (error) => {
      toast.error(error.message);
    });
  }, [apis.vscode, isSettingsPanel]);

  // Same as the window-focus effect in App.tsx: when the user can see this
  // webview again, the selected session counts as seen. VS Code learns that from
  // the extension host, not from a DOM focus event.
  React.useEffect(() => {
    if (isSettingsPanel) return;
    return onHostSurfaceSeen(() => {
      const sessionId = useSessionUIStore.getState().currentSessionId;
      if (sessionId) markSessionViewed(sessionId);
    });
  }, [isSettingsPanel]);

  React.useEffect(() => {
    document.documentElement.classList.toggle('wide-chat-layout', wideChatLayoutEnabled);
    return () => {
      document.documentElement.classList.remove('wide-chat-layout');
    };
  }, [wideChatLayoutEnabled]);

  React.useEffect(() => {
    void refreshSourceControlProviders(apis.sourceControl);
    void refreshSourceControlAuth(apis.sourceControl, { force: true });
  }, [apis.sourceControl, refreshSourceControlAuth, refreshSourceControlProviders]);

  React.useEffect(() => {
    if (!error) {
      return;
    }

    const timeout = window.setTimeout(() => clearError(), 5000);
    return () => window.clearTimeout(timeout);
  }, [clearError, error]);

  return (
    <ErrorBoundary>
      <SyncProvider sdk={opencodeClient.getSdkClient()} directory={isSettingsPanel ? '' : currentDirectory || ''}>
        <RuntimeAPIProvider apis={apis}>
          <FireworksProvider>
            <TooltipProvider delayDuration={300} skipDelayDuration={150}>
              <div className="h-full text-foreground bg-background">
                {isSettingsPanel ? <VSCodeSettings /> : (
                  <>
                    <SyncAppEffects backgroundWorkEnabled />
                    <VSCodeLayout />
                  </>
                )}
                <AppLinkConfirmDialog />
                <SharedTrustConfirmDialog />
                <OpenCodeUpdateToast />
                <Toaster position="top-center" />
                <ConfigUpdateOverlay />
              </div>
            </TooltipProvider>
          </FireworksProvider>
        </RuntimeAPIProvider>
      </SyncProvider>
    </ErrorBoundary>
  );
}
