import React from 'react';
import { AgentManagerView } from '@/components/views/agent-manager';
import { FireworksProvider } from '@/contexts/FireworksContext';
import { RuntimeAPIProvider } from '@/contexts/RuntimeAPIProvider';
import { registerRuntimeAPIs } from '@/contexts/runtimeAPIRegistry';
import { TooltipProvider } from '@/components/ui/tooltip';
import { Toaster } from '@/components/ui/sonner';
import { ConfigUpdateOverlay } from '@/components/ui/ConfigUpdateOverlay';
import { ErrorBoundary } from '@/components/ui/ErrorBoundary';
import { OpenCodeUpdateToast } from '@/components/update/OpenCodeUpdateToast';
import { VSCodeLayout } from '@/components/layout/VSCodeLayout';
import { usePushVisibilityBeacon } from '@/hooks/usePushVisibilityBeacon';
import { useRouter } from '@/hooks/useRouter';
import { useWindowTitle } from '@/hooks/useWindowTitle';
import { opencodeClient } from '@/lib/opencode/client';
import type { RuntimeAPIs } from '@/lib/api/types';
import { runtimeFetch } from '@/lib/runtime-fetch';
import { useFeatureFlagsStore } from '@/stores/useFeatureFlagsStore';
import { useGitHubAuthStore } from '@/stores/useGitHubAuthStore';
import { useDirectoryStore } from '@/stores/useDirectoryStore';
import { useUIStore } from '@/stores/useUIStore';
import { useSessionUIStore } from '@/sync/session-ui-store';
import { SyncProvider } from '@/sync/sync-context';
import { SyncAppEffects } from './AppEffects';
import { useAppFontEffects } from './useAppFontEffects';

type VSCodePanelType = 'chat' | 'agentManager';

type VSCodeConnectionStatus = 'connecting' | 'connected' | 'error' | 'disconnected';

type VSCodeConnectionState = {
  status: VSCodeConnectionStatus;
  error?: string;
  cliAvailable?: boolean;
};

declare global {
  interface Window {
    __OPENCHAMBER_PANEL_TYPE__?: VSCodePanelType;
    __OPENCHAMBER_CONNECTION__?: VSCodeConnectionState;
  }
}

const LocalSetupScreen = React.lazy(() =>
  import('@/components/onboarding/LocalSetupScreen').then((module) => ({ default: module.LocalSetupScreen })),
);

const readVSCodeConnection = (): VSCodeConnectionState => {
  const initial = window.__OPENCHAMBER_CONNECTION__;
  if (initial) {
    return initial;
  }
  const vscodeConfig = (window as Window & { __VSCODE_CONFIG__?: { connectionStatus?: string; cliAvailable?: boolean } }).__VSCODE_CONFIG__;
  const configStatus = vscodeConfig?.connectionStatus;
  const status = (configStatus as VSCodeConnectionStatus | undefined) || 'connecting';
  return {
    status,
    cliAvailable: vscodeConfig?.cliAvailable ?? true,
  };
};

const useVSCodeConnection = (): VSCodeConnectionState => {
  const [connection, setConnection] = React.useState<VSCodeConnectionState>(() => readVSCodeConnection());

  React.useEffect(() => {
    const onConnectionStatus = (event: Event) => {
      const detail = (event as CustomEvent<Partial<VSCodeConnectionState>>).detail;
      const prev = window.__OPENCHAMBER_CONNECTION__ ?? readVSCodeConnection();
      const next: VSCodeConnectionState = {
        status: detail?.status ?? prev.status,
        error: detail?.error ?? prev.error,
        cliAvailable: typeof detail?.cliAvailable === 'boolean' ? detail.cliAvailable : prev.cliAvailable,
      };
      window.__OPENCHAMBER_CONNECTION__ = next;
      setConnection(next);
    };

    window.addEventListener('openchamber:connection-status', onConnectionStatus);
    return () => window.removeEventListener('openchamber:connection-status', onConnectionStatus);
  }, []);

  return connection;
};

const shouldShowLocalSetup = (connection: VSCodeConnectionState): boolean => {
  if (connection.cliAvailable !== false) {
    return false;
  }
  return connection.status === 'connecting' || connection.status === 'error' || connection.status === 'disconnected';
};

type VSCodeAppProps = {
  apis: RuntimeAPIs;
};

export function VSCodeApp({ apis }: VSCodeAppProps) {
  const currentDirectory = useDirectoryStore((state) => state.currentDirectory);
  const error = useSessionUIStore((state) => state.error);
  const clearError = useSessionUIStore((state) => state.clearError);
  const wideChatLayoutEnabled = useUIStore((state) => state.wideChatLayoutEnabled);
  const refreshGitHubAuthStatus = useGitHubAuthStore((state) => state.refreshStatus);
  const setPlanModeEnabled = useFeatureFlagsStore((state) => state.setPlanModeEnabled);
  const panelType = typeof window !== 'undefined'
    ? window.__OPENCHAMBER_PANEL_TYPE__
    : 'chat';
  const connection = useVSCodeConnection();
  const showLocalSetup = panelType === 'chat' && shouldShowLocalSetup(connection);

  const handleLocalSetupRestart = React.useCallback(async () => {
    if (apis.settings.restartOpenCode) {
      await apis.settings.restartOpenCode();
      return;
    }
    await runtimeFetch('/api/config/reload', { method: 'POST' });
  }, [apis.settings]);

  React.useEffect(() => {
    registerRuntimeAPIs(apis);
    return () => registerRuntimeAPIs(null);
  }, [apis]);

  useAppFontEffects();
  usePushVisibilityBeacon({ enabled: true });
  useWindowTitle();
  useRouter();

  React.useEffect(() => {
    document.documentElement.classList.toggle('wide-chat-layout', wideChatLayoutEnabled);
    return () => {
      document.documentElement.classList.remove('wide-chat-layout');
    };
  }, [wideChatLayoutEnabled]);

  React.useEffect(() => {
    void refreshGitHubAuthStatus(apis.github, { force: true });
  }, [apis.github, refreshGitHubAuthStatus]);

  React.useEffect(() => {
    let cancelled = false;

    const run = async () => {
      const res = await runtimeFetch('/health', { method: 'GET' }).catch(() => null);
      if (!res || !res.ok || cancelled) return;
      const data = (await res.json().catch(() => null)) as null | {
        planModeExperimentalEnabled?: unknown;
      };
      if (!data || cancelled) return;
      const raw = data.planModeExperimentalEnabled;
      const enabled = raw === true || raw === 1 || raw === '1' || raw === 'true';
      setPlanModeEnabled(enabled);
    };

    void run();

    return () => {
      cancelled = true;
    };
  }, [setPlanModeEnabled]);

  React.useEffect(() => {
    if (!error) {
      return;
    }

    const timeout = window.setTimeout(() => clearError(), 5000);
    return () => window.clearTimeout(timeout);
  }, [clearError, error]);

  if (showLocalSetup) {
    return (
      <ErrorBoundary>
        <RuntimeAPIProvider apis={apis}>
          <React.Suspense fallback={null}>
            <LocalSetupScreen
              onBack={() => void handleLocalSetupRestart()}
              onCliAvailable={() => void handleLocalSetupRestart()}
            />
          </React.Suspense>
        </RuntimeAPIProvider>
      </ErrorBoundary>
    );
  }

  if (panelType === 'agentManager') {
    return (
      <ErrorBoundary>
        <SyncProvider sdk={opencodeClient.getSdkClient()} directory={currentDirectory || ''}>
          <RuntimeAPIProvider apis={apis}>
            <TooltipProvider delayDuration={300} skipDelayDuration={150}>
              <div className="h-full text-foreground bg-background">
                <SyncAppEffects embeddedBackgroundWorkEnabled={true} />
                <AgentManagerView />
                <OpenCodeUpdateToast />
                <Toaster position="top-center" />
              </div>
            </TooltipProvider>
          </RuntimeAPIProvider>
        </SyncProvider>
      </ErrorBoundary>
    );
  }

  return (
    <ErrorBoundary>
      <SyncProvider sdk={opencodeClient.getSdkClient()} directory={currentDirectory || ''}>
        <RuntimeAPIProvider apis={apis}>
          <FireworksProvider>
            <TooltipProvider delayDuration={300} skipDelayDuration={150}>
              <div className="h-full text-foreground bg-background">
                <SyncAppEffects embeddedBackgroundWorkEnabled={true} />
                <VSCodeLayout />
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
