import React from 'react';
import { MainLayout } from '@/components/layout/MainLayout';
import { VSCodeLayout } from '@/components/layout/VSCodeLayout';
import { AgentManagerView } from '@/components/views/agent-manager';
import { ChatView } from '@/components/views';
import { FireworksProvider } from '@/contexts/FireworksContext';
import { Toaster } from '@/components/ui/sonner';
import { MemoryDebugPanel } from '@/components/ui/MemoryDebugPanel';
import { ErrorBoundary } from '@/components/ui/ErrorBoundary';
import { useEventStream } from '@/hooks/useEventStream';
import { useKeyboardShortcuts } from '@/hooks/useKeyboardShortcuts';
import { useMenuActions } from '@/hooks/useMenuActions';
import { useSessionStatusBootstrap } from '@/hooks/useSessionStatusBootstrap';
import { useServerSessionStatus } from '@/hooks/useServerSessionStatus';
import { useSessionAutoCleanup } from '@/hooks/useSessionAutoCleanup';
import { useQueuedMessageAutoSend } from '@/hooks/useQueuedMessageAutoSend';
import { useRouter } from '@/hooks/useRouter';
import { usePushVisibilityBeacon } from '@/hooks/usePushVisibilityBeacon';
import { usePwaManifestSync } from '@/hooks/usePwaManifestSync';
import { usePwaInstallPrompt } from '@/hooks/usePwaInstallPrompt';
import { useWindowTitle } from '@/hooks/useWindowTitle';
import { useGitHubPrBackgroundTracking } from '@/hooks/useGitHubPrBackgroundTracking';
import { GitPollingProvider } from '@/hooks/useGitPolling';
import { useConfigStore } from '@/stores/useConfigStore';
import { hasModifier } from '@/lib/utils';
import { isDesktopLocalOriginActive, isDesktopShell } from '@/lib/desktop';
import { OnboardingScreen } from '@/components/onboarding/OnboardingScreen';
import { useSessionStore } from '@/stores/useSessionStore';
import { useDirectoryStore } from '@/stores/useDirectoryStore';
import { opencodeClient } from '@/lib/opencode/client';
import { useFontPreferences } from '@/hooks/useFontPreferences';
import { CODE_FONT_OPTION_MAP, DEFAULT_MONO_FONT, DEFAULT_UI_FONT, UI_FONT_OPTION_MAP } from '@/lib/fontOptions';
import { ConfigUpdateOverlay } from '@/components/ui/ConfigUpdateOverlay';
import { AboutDialog } from '@/components/ui/AboutDialog';
import { RuntimeAPIProvider } from '@/contexts/RuntimeAPIProvider';
import { registerRuntimeAPIs } from '@/contexts/runtimeAPIRegistry';
import { VoiceProvider } from '@/components/voice';
import { useUIStore } from '@/stores/useUIStore';
import { useGitHubAuthStore } from '@/stores/useGitHubAuthStore';
import type { RuntimeAPIs } from '@/lib/api/types';
import { TooltipProvider } from '@/components/ui/tooltip';

const CLI_MISSING_ERROR_REGEX =
  /ENOENT|spawn\s+opencode|Unable\s+to\s+locate\s+the\s+opencode\s+CLI|OpenCode\s+CLI\s+not\s+found|opencode(\.exe)?\s+not\s+found|opencode(\.exe)?:\s*command\s+not\s+found|not\s+recognized\s+as\s+an\s+internal\s+or\s+external\s+command|env:\s*['"]?(node|bun)['"]?:\s*No\s+such\s+file\s+or\s+directory|(node|bun):\s*No\s+such\s+file\s+or\s+directory/i;
const CLI_ONBOARDING_HEALTH_POLL_MS = 1500;

const AboutDialogWrapper: React.FC = () => {
  const { isAboutDialogOpen, setAboutDialogOpen } = useUIStore();
  return (
    <AboutDialog
      open={isAboutDialogOpen}
      onOpenChange={setAboutDialogOpen}
    />
  );
};

type AppProps = {
  apis: RuntimeAPIs;
};

type EmbeddedSessionChatConfig = {
  sessionId: string;
  directory: string | null;
};

type EmbeddedVisibilityPayload = {
  visible?: unknown;
};

const readEmbeddedSessionChatConfig = (): EmbeddedSessionChatConfig | null => {
  if (typeof window === 'undefined') {
    return null;
  }

  const params = new URLSearchParams(window.location.search);
  if (params.get('ocPanel') !== 'session-chat') {
    return null;
  }

  const sessionIdRaw = params.get('sessionId');
  const sessionId = typeof sessionIdRaw === 'string' ? sessionIdRaw.trim() : '';
  if (!sessionId) {
    return null;
  }

  const directoryRaw = params.get('directory');
  const directory = typeof directoryRaw === 'string' && directoryRaw.trim().length > 0
    ? directoryRaw.trim()
    : null;

  return {
    sessionId,
    directory,
  };
};

function App({ apis }: AppProps) {
  const { initializeApp, isInitialized, isConnected } = useConfigStore();
  const providersCount = useConfigStore((state) => state.providers.length);
  const agentsCount = useConfigStore((state) => state.agents.length);
  const loadProviders = useConfigStore((state) => state.loadProviders);
  const loadAgents = useConfigStore((state) => state.loadAgents);
  const { error, clearError, loadSessions } = useSessionStore();
  const currentSessionId = useSessionStore((state) => state.currentSessionId);
  const setCurrentSession = useSessionStore((state) => state.setCurrentSession);
  const sessions = useSessionStore((state) => state.sessions);
  const currentDirectory = useDirectoryStore((state) => state.currentDirectory);
  const setDirectory = useDirectoryStore((state) => state.setDirectory);
  const isSwitchingDirectory = useDirectoryStore((state) => state.isSwitchingDirectory);
  const [showMemoryDebug, setShowMemoryDebug] = React.useState(false);
  const { uiFont, monoFont } = useFontPreferences();
  const refreshGitHubAuthStatus = useGitHubAuthStore((state) => state.refreshStatus);
  const [isVSCodeRuntime, setIsVSCodeRuntime] = React.useState<boolean>(() => apis.runtime.isVSCode);
  const [showCliOnboarding, setShowCliOnboarding] = React.useState(false);
  const [isEmbeddedVisible, setIsEmbeddedVisible] = React.useState(true);
  const isDesktopRuntime = React.useMemo(() => isDesktopShell(), []);
  const appReadyDispatchedRef = React.useRef(false);
  const embeddedSessionChat = React.useMemo<EmbeddedSessionChatConfig | null>(() => readEmbeddedSessionChatConfig(), []);
  const embeddedBackgroundWorkEnabled = !embeddedSessionChat || isEmbeddedVisible;

  React.useEffect(() => {
    setIsVSCodeRuntime(apis.runtime.isVSCode);
  }, [apis.runtime.isVSCode]);

  React.useEffect(() => {
    registerRuntimeAPIs(apis);
    return () => registerRuntimeAPIs(null);
  }, [apis]);

  React.useEffect(() => {
    if (embeddedSessionChat) {
      return;
    }

    void refreshGitHubAuthStatus(apis.github, { force: true });
  }, [apis.github, embeddedSessionChat, refreshGitHubAuthStatus]);

  useGitHubPrBackgroundTracking(embeddedBackgroundWorkEnabled ? apis.github : undefined, apis.git);

  React.useEffect(() => {
    if (typeof document === 'undefined') {
      return;
    }
    const root = document.documentElement;
    const uiStack = UI_FONT_OPTION_MAP[uiFont]?.stack ?? UI_FONT_OPTION_MAP[DEFAULT_UI_FONT].stack;
    const monoStack = CODE_FONT_OPTION_MAP[monoFont]?.stack ?? CODE_FONT_OPTION_MAP[DEFAULT_MONO_FONT].stack;

    root.style.setProperty('--font-sans', uiStack);
    root.style.setProperty('--font-heading', uiStack);
    root.style.setProperty('--font-family-sans', uiStack);
    root.style.setProperty('--font-mono', monoStack);
    root.style.setProperty('--font-family-mono', monoStack);
    root.style.setProperty('--ui-regular-font-weight', '400');

    if (document.body) {
      document.body.style.fontFamily = uiStack;
    }
  }, [uiFont, monoFont]);

  React.useEffect(() => {
    if (isInitialized) {
      const hideInitialLoading = () => {
        const loadingElement = document.getElementById('initial-loading');
        if (loadingElement) {
          loadingElement.classList.add('fade-out');

          setTimeout(() => {
            loadingElement.remove();
          }, 300);
        }
      };

      const timer = setTimeout(hideInitialLoading, 150);
      return () => clearTimeout(timer);
    }
  }, [isInitialized]);

  React.useEffect(() => {
    const fallbackTimer = setTimeout(() => {
      const loadingElement = document.getElementById('initial-loading');
      if (loadingElement && !isInitialized) {
        loadingElement.classList.add('fade-out');
        setTimeout(() => {
          loadingElement.remove();
        }, 300);
      }
    }, 5000);

    return () => clearTimeout(fallbackTimer);
  }, [isInitialized]);

  React.useEffect(() => {
    const init = async () => {
      // VS Code runtime bootstraps config + sessions after the managed OpenCode instance reports "connected".
      // Doing the default initialization here can race with startup and lead to one-shot failures.
      if (isVSCodeRuntime) {
        return;
      }
      await initializeApp();
    };

    init();
  }, [initializeApp, isVSCodeRuntime]);

  const startupRecoveryInProgressRef = React.useRef(false);
  const startupRecoveryLastAttemptRef = React.useRef(0);

  React.useEffect(() => {
    if (isVSCodeRuntime) {
      return;
    }
    if (!isConnected) {
      return;
    }
    if (providersCount > 0 && agentsCount > 0) {
      return;
    }
    if (startupRecoveryInProgressRef.current) {
      return;
    }

    const now = Date.now();
    if (now - startupRecoveryLastAttemptRef.current < 750) {
      return;
    }

    startupRecoveryLastAttemptRef.current = now;
    startupRecoveryInProgressRef.current = true;

    const repair = async () => {
      try {
        if (providersCount === 0) {
          await loadProviders();
        }
        if (agentsCount === 0) {
          await loadAgents();
        }
      } catch {
        // Keep UI responsive; we'll retry on next cycle.
      } finally {
        startupRecoveryInProgressRef.current = false;
      }
    };

    void repair();
  }, [agentsCount, isConnected, isVSCodeRuntime, loadAgents, loadProviders, providersCount]);

  React.useEffect(() => {
    if (isSwitchingDirectory) {
      return;
    }

    const syncDirectoryAndSessions = async () => {
      // VS Code runtime loads sessions via VSCodeLayout bootstrap to avoid startup races.
      if (isVSCodeRuntime) {
        return;
      }

      if (!isConnected) {
        return;
      }
      opencodeClient.setDirectory(currentDirectory);

      await loadSessions();
    };

    syncDirectoryAndSessions();
  }, [currentDirectory, isSwitchingDirectory, loadSessions, isConnected, isVSCodeRuntime]);

  React.useEffect(() => {
    if (!embeddedSessionChat || typeof window === 'undefined') {
      return;
    }

    const applyVisibility = (payload?: EmbeddedVisibilityPayload) => {
      const nextVisible = payload?.visible === true;
      setIsEmbeddedVisible(nextVisible);
    };

    const handleMessage = (event: MessageEvent) => {
      if (event.origin !== window.location.origin) {
        return;
      }

      const data = event.data as { type?: unknown; payload?: EmbeddedVisibilityPayload };
      if (data?.type !== 'openchamber:embedded-visibility') {
        return;
      }

      applyVisibility(data.payload);
    };

    const scopedWindow = window as unknown as {
      __openchamberSetEmbeddedVisibility?: (payload?: EmbeddedVisibilityPayload) => void;
    };

    scopedWindow.__openchamberSetEmbeddedVisibility = applyVisibility;
    window.addEventListener('message', handleMessage);

    return () => {
      window.removeEventListener('message', handleMessage);
      if (scopedWindow.__openchamberSetEmbeddedVisibility === applyVisibility) {
        delete scopedWindow.__openchamberSetEmbeddedVisibility;
      }
    };
  }, [embeddedSessionChat]);

  React.useEffect(() => {
    if (!embeddedSessionChat?.directory || isVSCodeRuntime) {
      return;
    }

    if (currentDirectory === embeddedSessionChat.directory) {
      return;
    }

    setDirectory(embeddedSessionChat.directory, { showOverlay: false });
  }, [currentDirectory, embeddedSessionChat, isVSCodeRuntime, setDirectory]);

  React.useEffect(() => {
    if (!embeddedSessionChat || isVSCodeRuntime) {
      return;
    }

    if (currentSessionId === embeddedSessionChat.sessionId) {
      return;
    }

    if (!sessions.some((session) => session.id === embeddedSessionChat.sessionId)) {
      return;
    }

    void setCurrentSession(embeddedSessionChat.sessionId);
  }, [currentSessionId, embeddedSessionChat, isVSCodeRuntime, sessions, setCurrentSession]);

  React.useEffect(() => {
    if (!embeddedSessionChat || typeof window === 'undefined') {
      return;
    }

    const handleStorage = (event: StorageEvent) => {
      if (event.storageArea !== window.localStorage) {
        return;
      }

      if (event.key !== 'ui-store') {
        return;
      }

      void useUIStore.persist.rehydrate();
    };

    window.addEventListener('storage', handleStorage);
    return () => {
      window.removeEventListener('storage', handleStorage);
    };
  }, [embeddedSessionChat]);

  React.useEffect(() => {
    if (typeof window === 'undefined') return;
    if (!isInitialized || isSwitchingDirectory) return;
    if (appReadyDispatchedRef.current) return;
    appReadyDispatchedRef.current = true;
    (window as unknown as { __openchamberAppReady?: boolean }).__openchamberAppReady = true;
    window.dispatchEvent(new Event('openchamber:app-ready'));
  }, [isInitialized, isSwitchingDirectory]);

  useEventStream({ enabled: embeddedBackgroundWorkEnabled });

  // Server-authoritative session status polling
  // Replaces SSE-dependent status updates with reliable HTTP polling
  useServerSessionStatus({ enabled: embeddedBackgroundWorkEnabled });

  usePushVisibilityBeacon({ enabled: embeddedBackgroundWorkEnabled });
  usePwaManifestSync();
  usePwaInstallPrompt();

  useWindowTitle();

  useRouter();

  useKeyboardShortcuts();

  const handleToggleMemoryDebug = React.useCallback(() => {
    setShowMemoryDebug(prev => !prev);
  }, []);

  useMenuActions(handleToggleMemoryDebug);

  useSessionStatusBootstrap({ enabled: embeddedBackgroundWorkEnabled });
  useSessionAutoCleanup({ enabled: embeddedBackgroundWorkEnabled });
  useQueuedMessageAutoSend({ enabled: embeddedBackgroundWorkEnabled });

  React.useEffect(() => {
    if (embeddedSessionChat) {
      return;
    }

    const handleKeyDown = (e: KeyboardEvent) => {
      if (hasModifier(e) && e.shiftKey && e.key === 'D') {
        e.preventDefault();
        setShowMemoryDebug(prev => !prev);
      }
    };

    window.addEventListener('keydown', handleKeyDown);
    return () => window.removeEventListener('keydown', handleKeyDown);
  }, [embeddedSessionChat]);

  React.useEffect(() => {
    if (embeddedSessionChat) {
      return;
    }

    if (error) {

      setTimeout(() => clearError(), 5000);
    }
  }, [clearError, embeddedSessionChat, error]);

  React.useEffect(() => {
    if (embeddedSessionChat) {
      return;
    }

    if (!isDesktopShell() || !isDesktopLocalOriginActive()) {
      return;
    }

    let cancelled = false;
    const run = async () => {
      const res = await fetch('/health', { method: 'GET' }).catch(() => null);
      if (!res || !res.ok || cancelled) return;
      const data = (await res.json().catch(() => null)) as null | {
        openCodeRunning?: unknown;
        isOpenCodeReady?: unknown;
        opencodeBinaryResolved?: unknown;
        lastOpenCodeError?: unknown;
      };
      if (!data || cancelled) return;
      const openCodeRunning = data.openCodeRunning === true;
      const isOpenCodeReady = data.isOpenCodeReady === true;
      const resolvedBinary = typeof data.opencodeBinaryResolved === 'string' ? data.opencodeBinaryResolved.trim() : '';
      const hasResolvedBinary = resolvedBinary.length > 0;
      const err = typeof data.lastOpenCodeError === 'string' ? data.lastOpenCodeError : '';
      const cliMissing =
        !openCodeRunning &&
        (CLI_MISSING_ERROR_REGEX.test(err) || (!hasResolvedBinary && !isOpenCodeReady));
      setShowCliOnboarding(cliMissing);
    };

    void run();
    const interval = window.setInterval(() => {
      void run();
    }, CLI_ONBOARDING_HEALTH_POLL_MS);

    return () => {
      cancelled = true;
      window.clearInterval(interval);
    };
  }, [embeddedSessionChat]);

  const handleCliAvailable = React.useCallback(() => {
    setShowCliOnboarding(false);
    window.location.reload();
  }, []);

  if (showCliOnboarding) {
    return (
      <ErrorBoundary>
        <div className="h-full text-foreground bg-transparent">
          <OnboardingScreen onCliAvailable={handleCliAvailable} />
        </div>
      </ErrorBoundary>
    );
  }

  if (embeddedSessionChat) {
    return (
      <ErrorBoundary>
        <RuntimeAPIProvider apis={apis}>
          <TooltipProvider delayDuration={700} skipDelayDuration={150}>
            <div className="h-full text-foreground bg-background">
              <ChatView />
              <Toaster />
            </div>
          </TooltipProvider>
        </RuntimeAPIProvider>
      </ErrorBoundary>
    );
  }

  // VS Code runtime - simplified layout without git/terminal views
  if (isVSCodeRuntime) {
    // Check if this is the Agent Manager panel
    const panelType = typeof window !== 'undefined' 
      ? (window as { __OPENCHAMBER_PANEL_TYPE__?: 'chat' | 'agentManager' }).__OPENCHAMBER_PANEL_TYPE__ 
      : 'chat';
    
    if (panelType === 'agentManager') {
    return (
      <ErrorBoundary>
        <RuntimeAPIProvider apis={apis}>
          <TooltipProvider delayDuration={700} skipDelayDuration={150}>
            <div className="h-full text-foreground bg-background">
              <AgentManagerView />
              <Toaster />
            </div>
          </TooltipProvider>
        </RuntimeAPIProvider>
      </ErrorBoundary>
    );
    }
    
    return (
      <ErrorBoundary>
        <RuntimeAPIProvider apis={apis}>
          <FireworksProvider>
            <TooltipProvider delayDuration={700} skipDelayDuration={150}>
              <div className="h-full text-foreground bg-background">
                <VSCodeLayout />
                <Toaster />
              </div>
            </TooltipProvider>
          </FireworksProvider>
        </RuntimeAPIProvider>
      </ErrorBoundary>
    );
  }

  return (
    <ErrorBoundary>
      <RuntimeAPIProvider apis={apis}>
        <GitPollingProvider>
          <FireworksProvider>
            <VoiceProvider>
              <TooltipProvider delayDuration={700} skipDelayDuration={150}>
                <div className={isDesktopRuntime ? 'h-full text-foreground bg-transparent' : 'h-full text-foreground bg-background'}>
                  <MainLayout />
                  <Toaster />
                  <ConfigUpdateOverlay />
                  <AboutDialogWrapper />
                  {showMemoryDebug && (
                    <MemoryDebugPanel onClose={() => setShowMemoryDebug(false)} />
                  )}
                </div>
              </TooltipProvider>
            </VoiceProvider>
          </FireworksProvider>
        </GitPollingProvider>
      </RuntimeAPIProvider>
    </ErrorBoundary>
  );
}

export default App;
