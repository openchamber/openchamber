import { OpenCodeCompatibilityGate } from '@/components/update/OpenCodeCompatibilityGate';
import React from 'react';
import { AppStartupOverlay } from '@/components/ui/AppStartupOverlay';
import { MainLayout } from '@/components/layout/MainLayout';
import { AppLinkConfirmDialog } from '@/components/chat/AppLinkConfirmDialog';
import { SharedTrustConfirmDialog } from '@/components/projects/SharedTrustConfirmDialog';
import { FireworksProvider } from '@/contexts/FireworksContext';
import { Toaster } from '@/components/ui/sonner';
import { toast } from '@/components/ui';
import { Button } from '@/components/ui/button';
import { setStreamPerfMemoryDebugEnabled } from '@/stores/utils/streamDebug';
import { setRequestsInFlightTrackingEnabled } from '@/stores/utils/requestsInFlight';
import { ErrorBoundary } from '@/components/ui/ErrorBoundary';
// useEventStream removed — replaced by SyncProvider + SyncBridge
import { useMenuActions } from '@/hooks/useMenuActions';
import { useSessionStatusBootstrap } from '@/hooks/useSessionStatusBootstrap';
import { useTraySync } from '@/hooks/useTraySync';
import { useGlobalSessionsPolling } from '@/hooks/useGlobalSessionsPolling';
import { useRouter } from '@/hooks/useRouter';
import { usePushVisibilityBeacon } from '@/hooks/usePushVisibilityBeacon';
import { useWebNotificationStream } from '@/hooks/useWebNotificationStream';
import { useAgentMemorySync } from '@/hooks/useAgentMemorySync';
import { useBrowserProviderSync } from '@/hooks/useBrowserProviderSync';
import { useEnterprisePolicySync } from '@/hooks/useEnterprisePolicySync';
import { useRoutingSync } from '@/hooks/useRoutingSync';
import { useIntegrationCatalogPrefetch } from '@/hooks/useIntegrationCatalogPrefetch';
import { usePwaInstallPrompt } from '@/hooks/usePwaInstallPrompt';
import { useWindowTitle } from '@/hooks/useWindowTitle';
import { useRootScrollLock } from '@/hooks/useRootScrollLock';
import { useConfigStore } from '@/stores/useConfigStore';
import { isDesktopLocalOriginActive, isDesktopShell, restartDesktopApp, invokeDesktop, openHostSession, takePendingDesktopSessionLinks } from '@/lib/desktop';
import { runPendingDesktopHostActions } from '@/lib/desktopHostActions';
import {
  getInjectedBootOutcome,
  getBootInjectionStatus,
  resolveDesktopBootView,
  canDismissInitialLoading,
  shouldRestartDesktopBootFlow,
  type BootInjectionStatus,
  type DesktopBootView,
} from '@/lib/desktopBoot';
import type { RecoveryVariant } from '@/components/onboarding/DesktopConnectionRecovery';
import { useSessionUIStore } from '@/sync/session-ui-store';
import { openSessionLink } from '@/lib/router/openSessionFromRoute';
import { parseRoute } from '@/lib/router';
import { beginLastSessionRestore, type LastSessionRestoreResult } from '@/sync/last-session-restore';
import { markSessionViewed } from '@/sync/notification-store';
import { useDirectoryStore } from '@/stores/useDirectoryStore';
import { opencodeClient } from '@/lib/opencode/client';
import { runtimeFetch } from '@/lib/runtime-fetch';
import { getRuntimeKey, subscribeRuntimeEndpointChanged } from '@/lib/runtime-switch';
import { useAutoReviewStore } from '@/stores/useAutoReviewStore';
import { resumeAutoReviewRun } from '@/lib/reviewFlow';
import { SyncProvider } from '@/sync/sync-context';
import { ConfigUpdateOverlay } from '@/components/ui/ConfigUpdateOverlay';
import { RuntimeAPIProvider } from '@/contexts/RuntimeAPIProvider';
import { registerRuntimeAPIs } from '@/contexts/runtimeAPIRegistry';
import { useUIStore } from '@/stores/useUIStore';
import { useSourceControlAuthStore } from '@/stores/useSourceControlAuthStore';
import { useLinearAuthStore } from '@/stores/useLinearAuthStore';
import { useFeatureFlagsStore } from '@/stores/useFeatureFlagsStore';
import type { RuntimeAPIs } from '@/lib/api/types';
import { TooltipProvider } from '@/components/ui/tooltip';
import { lazyWithChunkRecovery } from '@/lib/chunkLoadRecovery';
import { useOnDemandComponent } from '@/hooks/useOnDemandComponent';
import { preloadFileTypeSprite } from '@/lib/fileTypeIcons';
import { useI18n } from '@/lib/i18n';
import { applyMobileKeyboardMode } from '@/lib/mobileKeyboardMode';
import { SyncAppEffects } from '@/apps/AppEffects';
import { isSameRuntimeEndpoint, resetAppForRuntimeEndpointChange } from '@/apps/runtimeEndpointReset';
import { useAppFontEffects } from '@/apps/useAppFontEffects';
import { OpenCodeUpdateToast } from '@/components/update/OpenCodeUpdateToast';
import { ProjectConfigErrorToast } from '@/components/projects/ProjectConfigErrorToast';
import { markStartupTrace, startupTraceEnabled } from '@/lib/startupTrace';
import { fetchStartupDiagnostics, getInitRecoveryDescriptionKey, type StartupDiagnostics } from '@/lib/startupDiagnostics';
import { fetchConnectedServerVersion, isServerBeforeOpenCode2 } from '@/lib/serverCompatibility';
import { OutdatedServerNotice } from '@/components/update/OutdatedServerNotice';

// Lazy-loaded heavy views — loaded on demand to reduce initial bundle size.
const OnboardingScreen = lazyWithChunkRecovery(() =>
  import('@/components/onboarding/OnboardingScreen').then((m) => ({ default: m.OnboardingScreen })),
);

const loadAboutDialog = () => import('@/components/ui/AboutDialog').then((m) => m.AboutDialog);
const loadMemoryDebugPanel = () => import('@/components/ui/MemoryDebugPanel').then((m) => m.MemoryDebugPanel);

// Loaded on its first open; stays mounted afterwards so the close animation plays.
const AboutDialogWrapper: React.FC = () => {
  const isAboutDialogOpen = useUIStore((s) => s.isAboutDialogOpen);
  const setAboutDialogOpen = useUIStore((s) => s.setAboutDialogOpen);
  const AboutDialog = useOnDemandComponent(isAboutDialogOpen, loadAboutDialog, () => setAboutDialogOpen(false));
  if (!AboutDialog) return null;
  return (
    <AboutDialog
      open={isAboutDialogOpen}
      onOpenChange={setAboutDialogOpen}
    />
  );
};

const MemoryDebugPanelLoader: React.FC<{ onClose: () => void }> = ({ onClose }) => {
  const MemoryDebugPanel = useOnDemandComponent(true, loadMemoryDebugPanel, onClose);
  return MemoryDebugPanel ? <MemoryDebugPanel onClose={onClose} /> : null;
};

const StartupInitializationRecovery: React.FC<{
  onRetry: () => void;
  isRetrying: boolean;
}> = ({ onRetry, isRetrying }) => {
  const { t } = useI18n();
  const [diagnostics, setDiagnostics] = React.useState<StartupDiagnostics | null>(null);

  React.useEffect(() => {
    const controller = new AbortController();
    const runtimeKey = getRuntimeKey();
    const timeout = setTimeout(() => controller.abort(), 5000);
    void fetchStartupDiagnostics(controller.signal).then((result) => {
      if (!controller.signal.aborted && getRuntimeKey() === runtimeKey) {
        setDiagnostics(result);
      }
    }).catch(() => {
      // Keep generic recovery when the server cannot supply current diagnostics.
    }).finally(() => clearTimeout(timeout));
    return () => {
      controller.abort();
      clearTimeout(timeout);
    };
  }, []);

  // A server before 2.0 answers this app's requests with its web page, which
  // surfaces as an unrelated load failure. Its own version says why.
  const [outdatedServerVersion, setOutdatedServerVersion] = React.useState<string | null>(null);
  React.useEffect(() => {
    const controller = new AbortController();
    const runtimeKey = getRuntimeKey();
    const timeout = setTimeout(() => controller.abort(), 5000);
    void fetchConnectedServerVersion(controller.signal).then((version) => {
      if (controller.signal.aborted || getRuntimeKey() !== runtimeKey) return;
      setOutdatedServerVersion(version && isServerBeforeOpenCode2(version) ? version : null);
    }).catch(() => undefined).finally(() => clearTimeout(timeout));
    return () => {
      controller.abort();
      clearTimeout(timeout);
    };
  }, []);

  const failure = useConfigStore((s) => s.lastInitFailure);
  // Server diagnostics outrank the client's guess: they prove the server answered.
  const failureMessage = diagnostics ? null : failure?.message ?? null;

  if (outdatedServerVersion) {
    return (
      <div className="flex h-full flex-col items-center overflow-y-auto bg-background px-6 py-6 text-foreground">
        <div className="my-auto flex w-full max-w-xl shrink-0 flex-col items-center gap-4 text-center">
          <OutdatedServerNotice version={outdatedServerVersion} />
          <Button type="button" variant="outline" onClick={onRetry} disabled={isRetrying}>
            {isRetrying ? t('startup.initRecovery.retrying') : t('startup.initRecovery.retry')}
          </Button>
        </div>
      </div>
    );
  }

  return (
    <div className="flex h-full flex-col items-center overflow-y-auto bg-background px-6 py-6 text-foreground">
      <div className="my-auto flex w-full max-w-xl shrink-0 flex-col items-center gap-4 text-center">
        <div className="flex flex-col gap-2">
          <h1 className="typography-title text-foreground">{t('startup.initRecovery.title')}</h1>
          <p className="typography-body text-muted-foreground">{t(getInitRecoveryDescriptionKey(diagnostics, failure))}</p>
        </div>
        {failureMessage && (
          <dl className="w-full min-w-0 text-left" aria-live="polite">
            <dt className="typography-meta text-muted-foreground">{t('startup.initRecovery.lastError')}</dt>
            <dd className="max-h-56 overflow-y-auto whitespace-pre-wrap break-words rounded-md bg-[var(--surface-muted)] px-3 py-2 font-mono typography-meta text-muted-foreground">{failureMessage}</dd>
          </dl>
        )}
        {diagnostics && (
          <dl className="w-full min-w-0 space-y-3 text-left" aria-live="polite">
            {diagnostics.binary && (
              <div>
                <dt className="typography-meta text-muted-foreground">{t('startup.initRecovery.binary')}</dt>
                <dd className="break-all font-mono typography-meta">{diagnostics.binary}</dd>
              </div>
            )}
            {diagnostics.error && (
              <div>
                <dt className="typography-meta text-muted-foreground">{t('startup.initRecovery.error')}</dt>
                <dd className="max-h-56 overflow-y-auto whitespace-pre-wrap break-words font-mono typography-meta text-[var(--status-error)]">{diagnostics.error}</dd>
              </div>
            )}
          </dl>
        )}
        <Button type="button" onClick={onRetry} disabled={isRetrying}>
          {isRetrying ? t('startup.initRecovery.retrying') : t('startup.initRecovery.retry')}
        </Button>
      </div>
    </div>
  );
};

type AppProps = {
  apis: RuntimeAPIs;
};

function App({ apis }: AppProps) {
  React.useEffect(() => {
    markStartupTrace('App:mounted');
    if (startupTraceEnabled()) {
      console.info('[startup-trace] enabled. Run console.table(window.__OPENCHAMBER_STARTUP_TRACE__) after startup.');
    }
  }, []);

  const initializeApp = useConfigStore((s) => s.initializeApp);
  const isInitialized = useConfigStore((s) => s.isInitialized);
  const isConnected = useConfigStore((s) => s.isConnected);
  // Loaded flags, not list lengths: a catalog shown from the persisted cache is
  // not a live load, and recovery must keep trying until one succeeds.
  const providersLoaded = useConfigStore((state) => state.providersLoaded);
  const agentsLoaded = useConfigStore((state) => state.agentsLoaded);
  const loadProviders = useConfigStore((state) => state.loadProviders);
  const loadAgents = useConfigStore((state) => state.loadAgents);
  const error = useSessionUIStore((s) => s.error);
  const clearError = useSessionUIStore((s) => s.clearError);
  const currentDirectory = useDirectoryStore((state) => state.currentDirectory);
  const isSwitchingDirectory = useDirectoryStore((state) => state.isSwitchingDirectory);
  const [showMemoryDebug, setShowMemoryDebug] = React.useState(false);
  const refreshSourceControlAuth = useSourceControlAuthStore((state) => state.refreshAll);
  const refreshLinearAuthStatus = useLinearAuthStore((state) => state.refreshStatus);
  const [isVSCodeRuntime, setIsVSCodeRuntime] = React.useState<boolean>(() => apis.runtime.isVSCode);
  const [initRetryExhausted, setInitRetryExhausted] = React.useState(false);
  const [initRetryEpoch, setInitRetryEpoch] = React.useState(0);
  const [runtimeEndpointEpoch, setRuntimeEndpointEpoch] = React.useState(0);
  const [manualInitRetrying, setManualInitRetrying] = React.useState(false);
  const wideChatLayoutEnabled = useUIStore((state) => state.wideChatLayoutEnabled);
  const mobileKeyboardMode = useUIStore((state) => state.mobileKeyboardMode);
  const isDesktopRuntime = React.useMemo(() => isDesktopShell(), []);
  const setPlanModeEnabled = useFeatureFlagsStore((state) => state.setPlanModeEnabled);
  const [bootInjectionStatus, setBootInjectionStatus] = React.useState<BootInjectionStatus>(() => {
    return getBootInjectionStatus();
  });
  const [bootView, setBootView] = React.useState<DesktopBootView | null>(() => {
    const outcome = getInjectedBootOutcome();
    return outcome !== null
      ? resolveDesktopBootView({ isDesktopShell: true, bootOutcome: outcome })
      : null;
  });
  const appReadyDispatchedRef = React.useRef(false);

  // The desktop shell opened Local because the default SSH instance did not
  // connect; say so once the app is up, or the switch looks like a lost setting.
  const { t } = useI18n();
  const sshFallbackNoticeShownRef = React.useRef(false);
  React.useEffect(() => {
    if (!isInitialized || bootInjectionStatus !== 'valid' || sshFallbackNoticeShownRef.current) return;
    const outcome = getInjectedBootOutcome();
    if (outcome?.target !== 'local' || outcome.status !== 'ok' || !outcome.sshStartupFallbackHostId) return;
    sshFallbackNoticeShownRef.current = true;
    toast.error(t('desktopHostSwitcher.startup.title'), {
      description: t('desktopHostSwitcher.startup.fellBackToLocal'),
    });
  }, [bootInjectionStatus, isInitialized, t]);

  React.useEffect(() => {
    setStreamPerfMemoryDebugEnabled(showMemoryDebug);
    setRequestsInFlightTrackingEnabled(showMemoryDebug);
    return () => {
      setStreamPerfMemoryDebugEnabled(false);
      setRequestsInFlightTrackingEnabled(false);
    };
  }, [showMemoryDebug]);

  React.useEffect(() => {
    applyMobileKeyboardMode(mobileKeyboardMode);
  }, [mobileKeyboardMode]);

  React.useEffect(() => {
    setIsVSCodeRuntime(apis.runtime.isVSCode);
  }, [apis.runtime.isVSCode]);

  React.useEffect(() => {
    // A change of runtime is reset by `installRuntimeEndpointReset`, which runs
    // even while a gate has this component unmounted. Same-runtime credential
    // changes reset only here, so a sign-in behind the login gate keeps state.
    return subscribeRuntimeEndpointChanged((detail) => {
      if (isSameRuntimeEndpoint(detail)) {
        resetAppForRuntimeEndpointChange(detail);
      }
      setRuntimeEndpointEpoch((epoch) => epoch + 1);
      setInitRetryExhausted(false);
      setInitRetryEpoch((epoch) => epoch + 1);
    });
  }, []);

  const autoReviewResumeSignature = useAutoReviewStore((state) => {
    const runtimeKey = getRuntimeKey();
    return Object.values(state.runsByOriginalSessionID)
      .filter((run) => run.status === 'running' && run.runtimeKey === runtimeKey)
      .map((run) => `${run.originalSessionID}:${run.phase}:${run.lastForwardedMessageID ?? ''}:${run.expectedAssistantParentID ?? ''}`)
      .sort()
      .join('|');
  });

  React.useEffect(() => {
    const runtimeKey = getRuntimeKey();
    const runs = Object.values(useAutoReviewStore.getState().runsByOriginalSessionID)
      .filter((run) => run.status === 'running' && run.runtimeKey === runtimeKey);
    for (const run of runs) {
      resumeAutoReviewRun(run.originalSessionID);
    }
  }, [autoReviewResumeSignature, runtimeEndpointEpoch]);

  React.useEffect(() => {
    document.documentElement.classList.toggle('wide-chat-layout', wideChatLayoutEnabled);
    return () => {
      document.documentElement.classList.remove('wide-chat-layout');
    };
  }, [wideChatLayoutEnabled]);

  React.useEffect(() => {
    registerRuntimeAPIs(apis);
    return () => registerRuntimeAPIs(null);
  }, [apis]);

  React.useEffect(() => {
    if (!isConnected) {
      return;
    }

    void refreshSourceControlAuth(apis.sourceControl, { force: true });
    void refreshLinearAuthStatus(apis.linear, { force: true });
    // `apis` is the same object across an instance switch, so without the epoch
    // this ran once for the whole app session and both statuses kept describing
    // whichever instance happened to be connected at startup. `isConnected` is
    // here to re-ask, not to gate: both integrations answer independently of
    // OpenCode, but a switch can race the transport and the retry is deduped.
  }, [apis.sourceControl, apis.linear, isConnected, refreshSourceControlAuth, refreshLinearAuthStatus, runtimeEndpointEpoch]);

  useAppFontEffects();

  const bootOutcomeKnown = bootInjectionStatus === 'valid';
  const bootViewIsMain = bootView?.screen === 'main';

  // Splash dismissal: the shell and composer are usable before OpenCode is
  // ready, so the splash leaves as soon as the shell mounts. Desktop shells
  // still require a valid boot outcome, which picks main, chooser or recovery.
  React.useEffect(() => {
    if (!canDismissInitialLoading({
      isDesktopShell: isDesktopRuntime,
      bootOutcomeKnown,
    })) {
      return;
    }

    // The shell is now interactive: fetch the file-type icons off the startup path.
    preloadFileTypeSprite();

    const timer = setTimeout(() => {
      const loadingElement = document.getElementById('initial-loading');
      if (loadingElement) {
        loadingElement.classList.add('fade-out');
        setTimeout(() => {
          loadingElement.remove();
        }, 300);
      }
    }, 150);

    return () => clearTimeout(timer);
  }, [isDesktopRuntime, bootOutcomeKnown]);

  // Deterministic malformed handling: update splash text so the user
  // sees a specific error instead of a generic spinner, but do NOT
  // dismiss the splash (that only happens on a valid outcome).
  React.useEffect(() => {
    if (!isDesktopRuntime || bootInjectionStatus !== 'malformed') {
      return;
    }

    const loadingElement = document.getElementById('initial-loading');
    if (loadingElement) {
      loadingElement.textContent = 'Desktop startup failed — please restart the app.';
    }
  }, [isDesktopRuntime, bootInjectionStatus]);

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
    // VS Code runtime bootstraps config + sessions after the managed OpenCode instance reports "connected".
    // Doing the default initialization here can race with startup and lead to one-shot failures.
    if (isVSCodeRuntime) {
      return;
    }
    void initializeApp();
  }, [initializeApp, isVSCodeRuntime]);

  React.useEffect(() => {
    if (isVSCodeRuntime || isInitialized) return;

    let active = true;
    let retryTimer: ReturnType<typeof setTimeout> | undefined;
    let retryCount = 0;
    const MAX_RETRIES = 10;
    const BASE_DELAY_MS = 1000;

    const retryInitialization = async () => {
      if (!active) return;
      if (retryCount >= MAX_RETRIES) {
        setInitRetryExhausted(true);
        return;
      }
      const state = useConfigStore.getState();
      if (state.isInitialized) {
        setInitRetryExhausted(false);
        return;
      }
      retryCount += 1;
      await state.initializeApp();

      const next = useConfigStore.getState();
      if (!active) return;
      if (next.isInitialized) {
        setInitRetryExhausted(false);
        return;
      }
      if (retryCount >= MAX_RETRIES) {
        setInitRetryExhausted(true);
        return;
      }
      // Each attempt already waits for OpenCode on the server (a held health
      // probe), so the gap between attempts stays short.
      const delay = Math.min(BASE_DELAY_MS * Math.pow(2, retryCount - 1), 4000);
      retryTimer = setTimeout(retryInitialization, delay);
    };

    retryTimer = setTimeout(retryInitialization, BASE_DELAY_MS);

    return () => {
      active = false;
      if (retryTimer) clearTimeout(retryTimer);
    };
  }, [initRetryEpoch, isInitialized, isVSCodeRuntime]);

  React.useEffect(() => {
    if (isInitialized) {
      setInitRetryExhausted(false);
    }
  }, [isInitialized]);

  React.useEffect(() => {
    if (!initRetryExhausted) return;

    const loadingElement = document.getElementById('initial-loading');
    if (loadingElement) {
      loadingElement.classList.add('fade-out');
      setTimeout(() => {
        loadingElement.remove();
      }, 300);
    }
  }, [initRetryExhausted]);

  // Startup recovery: poll until providers AND agents are loaded.
  // loadProviders/loadAgents resolve normally even on failure (errors swallowed),
  // so a reactive effect can't detect failure — we need an interval.
  React.useEffect(() => {
    if (isVSCodeRuntime || !isConnected) return;
    if (providersLoaded && agentsLoaded) return;

    let active = true;
    let retries = 0;
    const MAX_RETRIES = 15;
    const attempt = async () => {
      const state = useConfigStore.getState();
      if (state.providersLoaded && state.agentsLoaded) return;
      try {
        if (!state.providersLoaded) await loadProviders({ source: 'startupRecovery' });
        if (!useConfigStore.getState().agentsLoaded) await loadAgents({ source: 'startupRecovery' });
      } catch { /* retry next interval */ }
    };

    void attempt();
    const id = setInterval(() => {
      if (!active) return;
      if (++retries >= MAX_RETRIES) { clearInterval(id); return; }
      void attempt();
    }, 2000);
    return () => { active = false; clearInterval(id); };
  }, [isConnected, isVSCodeRuntime, loadAgents, loadProviders, providersLoaded, agentsLoaded]);

  React.useEffect(() => {
    if (isSwitchingDirectory) {
      return;
    }

    // VS Code runtime loads sessions via VSCodeLayout bootstrap to avoid startup races.
    if (isVSCodeRuntime) {
      return;
    }

    if (!isConnected) {
      return;
    }
    opencodeClient.setDirectory(currentDirectory);

    // Session loading is handled by the sync system's bootstrap — no manual loadSessions needed.
  }, [currentDirectory, isSwitchingDirectory, isConnected, isVSCodeRuntime]);

  React.useEffect(() => {
    if (typeof window === 'undefined') return;

    const handler = (event: Event) => {
      const detail = (event as CustomEvent<{ sessionId?: string; directory?: string; messageId?: string; runtimeKey?: string }>).detail;
      const sessionId = typeof detail?.sessionId === 'string' ? detail.sessionId.trim() : '';
      if (!sessionId) return;
      const directory = typeof detail?.directory === 'string' && detail.directory.trim().length > 0
        ? detail.directory.trim()
        : null;
      // A notification click names the runtime that owns the session. When
      // this window is on another instance, the desktop shell opens the
      // session in a window for the owning one.
      const runtimeKey = String(detail?.runtimeKey ?? '').trim();
      if (runtimeKey && runtimeKey !== getRuntimeKey() && openHostSession(runtimeKey, sessionId)) {
        return;
      }
      // A link (a desktop deep link, a link to this window's instance) carries
      // no directory; the route opener resolves it from the global session
      // list, as for a web link.
      if (!directory) {
        void openSessionLink(sessionId, typeof detail?.messageId === 'string' ? detail.messageId.trim() : null);
        return;
      }
      void useSessionUIStore.getState().setCurrentSession(sessionId, directory);
    };

    window.addEventListener('openchamber:open-session', handler as EventListener);
    // A link that launched the app arrived before this listener existed; the
    // desktop shell keeps it until the window asks. Taking is one-shot, so a
    // cleanup must not drop links already taken (Strict Mode re-runs this).
    void takePendingDesktopSessionLinks().then((links) => {
      for (const link of links) void openSessionLink(link.sessionId, link.messageId);
    });
    return () => window.removeEventListener('openchamber:open-session', handler as EventListener);
  }, []);

  // Host work the desktop shell queued (a confirmed pairing link, a relay host
  // to activate): on mount for links that launched the app, then whenever the
  // shell queues more.
  React.useEffect(() => {
    if (!isDesktopShell()) return;
    const run = () => {
      void runPendingDesktopHostActions((failure) => {
        toast.error(failure === 'invalid-link'
          ? t('settings.remoteInstances.direct.error.invalidConnectLink')
          : failure === 'unreachable'
            ? t('mobile.connect.error.unreachable')
            : t('onboarding.remoteConnection.errors.failedToSaveConnection'));
      });
    };
    window.addEventListener('openchamber:host-actions-ready', run);
    run();
    return () => window.removeEventListener('openchamber:host-actions-ready', run);
  }, [t]);

  // Launch continuity: reopen the session that was open when the app last
  // closed, once per page load. The shell shows before OpenCode is ready, so
  // the session is selected in a layout effect, before any passive effect of
  // the tree runs: ChatContainer's would otherwise open the automatic draft
  // first and the launch would flash it. A route that names a session wins and
  // is not preempted. The list check that follows reports `failed` while
  // OpenCode is starting and runs again once startup completes; see
  // beginLastSessionRestore.
  const lastSessionRestoreRef = React.useRef<{
    attempt: (() => Promise<LastSessionRestoreResult>) | null;
    running: boolean;
    done: boolean;
  }>({ attempt: null, running: false, done: false });
  React.useLayoutEffect(() => {
    const restore = lastSessionRestoreRef.current;
    if (restore.attempt) return;
    restore.attempt = beginLastSessionRestore({ selectNow: !parseRoute().sessionId });
  }, []);
  React.useEffect(() => {
    const restore = lastSessionRestoreRef.current;
    const run = () => {
      const attempt = restore.attempt;
      if (!attempt || restore.running || restore.done) return;
      const startedInitialized = useConfigStore.getState().isInitialized;
      restore.running = true;
      void attempt().then((result) => {
        restore.running = false;
        if (result !== 'failed' || startedInitialized) {
          restore.done = true;
          return;
        }
        // Startup completed while this attempt was failing: try once more now.
        if (useConfigStore.getState().isInitialized) run();
      });
    };
    run();
  }, [isInitialized]);

  // Open a draft Mini Chat window from the native File menu / tray. Uses a
  // dedicated single-fire event (not the menu-action channel) because draft
  // mini-chat windows are NOT deduplicated — a double dispatch would open two.
  React.useEffect(() => {
    if (typeof window === 'undefined') return;
    const onOpenMiniChat = () => {
      void invokeDesktop('desktop_open_draft_mini_chat_window', {
        directory: '',
        projectId: null,
      });
    };
    window.addEventListener('openchamber:open-mini-chat', onOpenMiniChat);
    return () => window.removeEventListener('openchamber:open-mini-chat', onOpenMiniChat);
  }, []);

  // When the window regains focus, mark the currently-selected session as seen.
  // Turn-completes that arrive while the app is backgrounded are intentionally
  // left unseen (see isViewedInCurrentSession); coming back to the window is the
  // signal that the user has now looked at it, so the marker clears.
  React.useEffect(() => {
    if (typeof window === 'undefined') return;
    const onFocus = () => {
      const sessionId = useSessionUIStore.getState().currentSessionId;
      if (sessionId) markSessionViewed(sessionId);
    };
    window.addEventListener('focus', onFocus);
    return () => window.removeEventListener('focus', onFocus);
  }, []);

  React.useEffect(() => {
    if (typeof window === 'undefined') return;

    const handler = (event: Event) => {
      const detail = (event as CustomEvent<{ directory?: string; projectId?: string }>).detail;
      const directory = typeof detail?.directory === 'string' && detail.directory.trim().length > 0
        ? detail.directory.trim()
        : null;
      const projectId = typeof detail?.projectId === 'string' && detail.projectId.trim().length > 0
        ? detail.projectId.trim()
        : null;
      const hasProjectTarget = Boolean(directory || projectId);
      useUIStore.getState().setSessionSwitcherOpen(false);
      useSessionUIStore.getState().openNewSessionDraft({
        target: hasProjectTarget ? 'project' : 'chat',
        selectedProjectId: hasProjectTarget ? projectId : null,
        directoryOverride: hasProjectTarget ? directory : null,
        preserveDirectoryOverride: Boolean(directory),
      });
    };

    window.addEventListener('openchamber:open-draft-session', handler as EventListener);
    return () => window.removeEventListener('openchamber:open-draft-session', handler as EventListener);
  }, []);

  React.useEffect(() => {
    if (typeof window === 'undefined') return;
    if (!isInitialized || isSwitchingDirectory) return;
    if (appReadyDispatchedRef.current) return;
    appReadyDispatchedRef.current = true;
    (window as unknown as { __openchamberAppReady?: boolean }).__openchamberAppReady = true;
    window.dispatchEvent(new Event('openchamber:app-ready'));
  }, [isInitialized, isSwitchingDirectory]);

  // useEventStream replaced by SyncProvider + SyncBridge

  // Session attention now handled by notification-store via SSE events (session.idle/session.error)

  usePushVisibilityBeacon();
  useWebNotificationStream();
  // Loaded here rather than by the Memory tab: the session index is built from
  // this snapshot, so leaving it to the panel meant a user who never opened
  // Project notes sent every message with no memory index at all.
  useAgentMemorySync(currentDirectory || null);
  useBrowserProviderSync();
  useRoutingSync();
  useEnterprisePolicySync();
  useIntegrationCatalogPrefetch(isInitialized && isConnected, runtimeEndpointEpoch);
  usePwaInstallPrompt();

  useWindowTitle();

  useRootScrollLock();

  useRouter();

  const handleToggleMemoryDebug = React.useCallback(() => {
    setShowMemoryDebug(prev => !prev);
  }, []);

  useMenuActions(handleToggleMemoryDebug);

  useTraySync();
  useGlobalSessionsPolling(true);

  useSessionStatusBootstrap();

  // Palette-only action: the memory debug panel has no keyboard shortcut.
  React.useEffect(() => {
    const handleToggle = () => setShowMemoryDebug((previous) => !previous);
    window.addEventListener('openchamber:memory-debug-toggle', handleToggle);
    return () => window.removeEventListener('openchamber:memory-debug-toggle', handleToggle);
  }, []);

  React.useEffect(() => {
    if (error) {

      setTimeout(() => clearError(), 5000);
    }
  }, [clearError, error]);

  // Poll for the injected boot outcome until it becomes available (desktop only).
  // The Rust backend sets window.__OPENCHAMBER_DESKTOP_BOOT_OUTCOME__ once the
  // sidecar reaches a stable state. We poll with exponential backoff to handle
  // potential race conditions during startup and config writes.
  React.useEffect(() => {
    if (!isDesktopRuntime || bootInjectionStatus !== 'not-injected') {
      return;
    }

    let cancelled = false;
    let attempts = 0;
    const BASE_INTERVAL = 200;
    const MAX_INTERVAL = 2000;
    const MAX_ATTEMPTS = 50; // 10 seconds total (200ms * 50 with exponential backoff cap)

    const pollWithBackoff = () => {
      if (cancelled) return;

      attempts++;
      const status = getBootInjectionStatus();

      if (status !== 'not-injected') {
        cancelled = true;
        setBootInjectionStatus(status);

        if (status === 'valid') {
          const outcome = getInjectedBootOutcome();
          if (outcome) {
            setBootView(resolveDesktopBootView({ isDesktopShell: true, bootOutcome: outcome }));
          }
        }
        // If status is 'malformed', we keep the splash visible with error text
        // handled by the separate useEffect below
        return;
      }

      // Exponential backoff with cap
      const nextInterval = Math.min(BASE_INTERVAL * Math.pow(1.1, attempts), MAX_INTERVAL);

      if (attempts >= MAX_ATTEMPTS) {
        // Max attempts reached - keep polling but show error
        const loadingElement = document.getElementById('initial-loading');
        if (loadingElement && !loadingElement.textContent?.includes('taking longer')) {
          loadingElement.textContent = 'Desktop startup is taking longer than expected...';
        }
      }

      window.setTimeout(pollWithBackoff, nextInterval);
    };

    // Start polling
    window.setTimeout(pollWithBackoff, BASE_INTERVAL);

    return () => {
      cancelled = true;
    };
  }, [isDesktopRuntime, bootInjectionStatus]);

  const handleDesktopBootDismiss = React.useCallback(async () => {
    if (shouldRestartDesktopBootFlow({
      isDesktopShell: isDesktopShell(),
      isDesktopLocalOriginActive: isDesktopLocalOriginActive(),
    })) {
      await restartDesktopApp();
      return;
    }

    window.location.reload();
  }, []);

  const handleManualInitRetry = React.useCallback(async () => {
    if (manualInitRetrying) return;

    setInitRetryExhausted(false);
    setManualInitRetrying(true);
    try {
      await useConfigStore.getState().initializeApp();
    } finally {
      setManualInitRetrying(false);
    }

    if (!useConfigStore.getState().isInitialized) {
      setInitRetryEpoch((value) => value + 1);
    }
  }, [manualInitRetrying]);

  // Map boot outcome kind to recovery variant
  const mapBootViewToRecoveryVariant = (view: DesktopBootView): RecoveryVariant | undefined => {
    if (view.screen === 'recovery') {
      return view.variant;
    }
    return undefined;
  };

  // Desktop boot view routing.
  // When the boot outcome resolves to a non-main screen (chooser, recovery),
  // render OnboardingScreen with appropriate mode/variant.
  if (isDesktopRuntime && bootView && bootView.screen !== 'main') {
    // First-launch chooser
    if (bootView.screen === 'chooser') {
      return (
        <ErrorBoundary>
          <div className="h-full text-foreground bg-background">
            <React.Suspense fallback={<div className="h-full" />}>
              <OnboardingScreen
                mode="first-launch"
                localAvailable={bootView.localAvailable !== false}
                onCliAvailable={handleDesktopBootDismiss}
                onChooseRemote={() => {
                  // Switch to remote tab - handled internally by OnboardingScreen
                }}
              />
            </React.Suspense>
          </div>
        </ErrorBoundary>
      );
    }

    // Recovery screens
    const recoveryVariant = mapBootViewToRecoveryVariant(bootView);
    const hostUrl = bootView.screen === 'recovery' && 'url' in bootView ? bootView.url : undefined;
    const hostId = bootView.screen === 'recovery' && 'hostId' in bootView ? bootView.hostId : undefined;

    return (
      <ErrorBoundary>
        <div className="h-full text-foreground bg-background">
          <React.Suspense fallback={<div className="h-full" />}>
            <OnboardingScreen
              mode="recovery"
              recoveryVariant={recoveryVariant}
              recoveryHostUrl={hostUrl}
              recoveryHostLabel={undefined}
              recoveryHostId={hostId}
              localAvailable={bootView.localAvailable !== false}
              onCliAvailable={handleDesktopBootDismiss}
            />
          </React.Suspense>
        </div>
      </ErrorBoundary>
    );
  }

  if (initRetryExhausted && !isInitialized && !isVSCodeRuntime) {
    return (
      <ErrorBoundary>
        <StartupInitializationRecovery
          key={runtimeEndpointEpoch}
          onRetry={() => { void handleManualInitRetry(); }}
          isRetrying={manualInitRetrying}
        />
      </ErrorBoundary>
    );
  }

  // The full provider tree mounts before OpenCode is ready and stays mounted
  // when initialization completes: the sidebar, composer and model picker are
  // usable from the start (catalogs come from the persisted cache, then
  // revalidate), and a message sent meanwhile waits for OpenCode.

  return (
    <ErrorBoundary>
      <SyncProvider key={runtimeEndpointEpoch} sdk={opencodeClient.getSdkClient()} directory={currentDirectory || ''}>
        <RuntimeAPIProvider apis={apis}>
          <FireworksProvider>
              <TooltipProvider delayDuration={300} skipDelayDuration={150}>
                <div className={isDesktopRuntime ? 'h-full text-foreground bg-transparent' : 'h-full text-foreground bg-background'}>
                  <SyncAppEffects backgroundWorkEnabled />
                  <OpenCodeUpdateToast />
                  <ProjectConfigErrorToast />
                  <MainLayout />
                  {isDesktopRuntime ? <AppStartupOverlay ready={bootOutcomeKnown && bootViewIsMain} /> : null}
                  <Toaster />
                  <AppLinkConfirmDialog />
                  <SharedTrustConfirmDialog />
                  <ConfigUpdateOverlay />
                  <AboutDialogWrapper />
                  {showMemoryDebug && (
                    <MemoryDebugPanelLoader onClose={() => setShowMemoryDebug(false)} />
                  )}
                </div>
              </TooltipProvider>
          </FireworksProvider>
        </RuntimeAPIProvider>
      </SyncProvider>
    </ErrorBoundary>
  );
}

export default function CompatibleApp(props: AppProps) {
  return <OpenCodeCompatibilityGate><App {...props} /></OpenCodeCompatibilityGate>;
}
