import React from 'react';
import { ErrorBoundary } from '../ui/ErrorBoundary';
import { SessionSidebar } from '@/components/session/SessionSidebar';
import { ChatView, SettingsView } from '@/components/views';
import { useSessionStore } from '@/stores/useSessionStore';
import { useConfigStore } from '@/stores/useConfigStore';
import { ContextUsageDisplay } from '@/components/ui/ContextUsageDisplay';
import { McpDropdown } from '@/components/mcp/McpDropdown';
import { cn } from '@/lib/utils';
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuLabel,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from '@/components/ui/dropdown-menu';
import { useRuntimeAPIs } from '@/hooks/useRuntimeAPIs';
import { ProviderLogo } from '@/components/ui/ProviderLogo';
import { UsageProgressBar } from '@/components/sections/usage/UsageProgressBar';
import { PaceIndicator } from '@/components/sections/usage/PaceIndicator';
import { formatPercent, formatWindowLabel, QUOTA_PROVIDERS, calculatePace, calculateExpectedUsagePercent } from '@/lib/quota';
import { useQuotaAutoRefresh, useQuotaStore } from '@/stores/useQuotaStore';
import { updateDesktopSettings } from '@/lib/persistence';
import type { UsageWindow } from '@/types';
import { RiAddLine, RiArrowLeftLine, RiRefreshLine, RiRobot2Line, RiSettings3Line, RiTimerLine } from '@remixicon/react';
import { useLanguage } from '@/hooks/useLanguage';

const formatTime = (timestamp: number | null) => {
  if (!timestamp) return '-';
  try {
    return new Date(timestamp).toLocaleTimeString(undefined, {
      hour: 'numeric',
      minute: '2-digit',
    });
  } catch {
    return '-';
  }
};

// Width threshold for mobile vs desktop layout in settings
const MOBILE_WIDTH_THRESHOLD = 550;
// Width threshold for expanded layout (sidebar + chat side by side)
const EXPANDED_LAYOUT_THRESHOLD = 1400;
// Sessions sidebar width in expanded layout
const SESSIONS_SIDEBAR_WIDTH = 280;
const SESSIONS_SIDEBAR_MIN_WIDTH = Math.round(SESSIONS_SIDEBAR_WIDTH * 0.7);
const SESSIONS_SIDEBAR_MAX_WIDTH = 520;

type VSCodeView = 'sessions' | 'chat' | 'settings';

export const VSCodeLayout: React.FC = () => {
  const { t } = useLanguage();
  const runtimeApis = useRuntimeAPIs();

  const viewMode = React.useMemo<'sidebar' | 'editor'>(() => {
    const configured =
      typeof window !== 'undefined'
        ? (window as unknown as { __VSCODE_CONFIG__?: { viewMode?: unknown } }).__VSCODE_CONFIG__?.viewMode
        : null;
    return configured === 'editor' ? 'editor' : 'sidebar';
  }, []);

  const initialSessionId = React.useMemo<string | null>(() => {
    const configured =
      typeof window !== 'undefined'
        ? (window as unknown as { __VSCODE_CONFIG__?: { initialSessionId?: unknown } }).__VSCODE_CONFIG__?.initialSessionId
        : null;
    if (typeof configured === 'string' && configured.trim().length > 0) {
      return configured.trim();
    }
    return null;
  }, []);

  const hasAppliedInitialSession = React.useRef(false);

  const bootDraftOpen = React.useMemo(() => {
    try {
      return Boolean(useSessionStore.getState().newSessionDraft?.open);
    } catch {
      return false;
    }
  }, []);

  const [currentView, setCurrentView] = React.useState<VSCodeView>(() => (bootDraftOpen ? 'chat' : 'sessions'));
  const [containerWidth, setContainerWidth] = React.useState<number>(0);
  const [expandedSidebarWidth, setExpandedSidebarWidth] = React.useState<number>(SESSIONS_SIDEBAR_WIDTH);
  const [isResizingExpandedSidebar, setIsResizingExpandedSidebar] = React.useState(false);
  const containerRef = React.useRef<HTMLDivElement>(null);
  const expandedSidebarResizeStartXRef = React.useRef(0);
  const expandedSidebarResizeStartWidthRef = React.useRef(SESSIONS_SIDEBAR_WIDTH);
  const expandedSidebarResizePointerIdRef = React.useRef<number | null>(null);
  const currentSessionId = useSessionStore((state) => state.currentSessionId);
  const sessions = useSessionStore((state) => state.sessions);

  const activeSessionTitle = React.useMemo(() => {
    if (!currentSessionId) {
      return null;
    }
    return sessions.find((session) => session.id === currentSessionId)?.title || t('vscodeLayout.session');
  }, [currentSessionId, sessions, t]);
  const newSessionDraftOpen = useSessionStore((state) => Boolean(state.newSessionDraft?.open));
  const isSyncingMessages = useSessionStore((state) => state.isSyncing);
  const hasActiveSessionWork = useSessionStore((state) => {
    const statuses = state.sessionStatus;
    if (!statuses || statuses.size === 0) {
      return false;
    }
    for (const status of statuses.values()) {
      if (status?.type === 'busy' || status?.type === 'retry') {
        return true;
      }
    }
    return false;
  });
  const openNewSessionDraft = useSessionStore((state) => state.openNewSessionDraft);
  const [connectionStatus, setConnectionStatus] = React.useState<'connecting' | 'connected' | 'error' | 'disconnected'>(
    () => (typeof window !== 'undefined'
      ? (window as { __OPENCHAMBER_CONNECTION__?: { status?: string } }).__OPENCHAMBER_CONNECTION__?.status as
        'connecting' | 'connected' | 'error' | 'disconnected' | undefined
      : 'connecting') || 'connecting'
  );
  const configInitialized = useConfigStore((state) => state.isInitialized);
  const initializeConfig = useConfigStore((state) => state.initializeApp);
  const loadSessions = useSessionStore((state) => state.loadSessions);
  const loadMessages = useSessionStore((state) => state.loadMessages);
  const messages = useSessionStore((state) => state.messages);
  const [hasInitializedOnce, setHasInitializedOnce] = React.useState<boolean>(() => configInitialized);
  const [isInitializing, setIsInitializing] = React.useState<boolean>(false);
  const lastBootstrapAttemptAt = React.useRef<number>(0);

  // Navigate to chat when a session is selected
  React.useEffect(() => {
    if (currentSessionId) {
      setCurrentView('chat');
    }
  }, [currentSessionId]);

  React.useEffect(() => {
    const vscodeApi = runtimeApis.vscode;
    if (!vscodeApi) {
      return;
    }

    void vscodeApi.executeCommand('openchamber.setActiveSession', currentSessionId, activeSessionTitle);
  }, [activeSessionTitle, currentSessionId, runtimeApis.vscode]);

  // If the active session disappears (e.g., deleted), go back to sessions list
  React.useEffect(() => {
    if (viewMode === 'editor') {
      return;
    }

    if (currentView !== 'chat') {
      return;
    }

    if (currentSessionId || newSessionDraftOpen || isSyncingMessages || hasActiveSessionWork) {
      return;
    }

    const timeoutId = window.setTimeout(() => {
      const state = useSessionStore.getState();
      const stillNoSession = !state.currentSessionId;
      const draftStillClosed = !state.newSessionDraft?.open;
      const stillSyncing = state.isSyncing;
      const stillActiveWork = (() => {
        const statuses = state.sessionStatus;
        if (!statuses || statuses.size === 0) return false;
        for (const status of statuses.values()) {
          if (status?.type === 'busy' || status?.type === 'retry') return true;
        }
        return false;
      })();

      if (stillNoSession && draftStillClosed && !stillSyncing && !stillActiveWork) {
        setCurrentView('sessions');
      }
    }, 900);

    return () => {
      window.clearTimeout(timeoutId);
    };
  }, [currentSessionId, newSessionDraftOpen, currentView, viewMode, isSyncingMessages, hasActiveSessionWork]);

  const handleBackToSessions = React.useCallback(() => {
    setCurrentView('sessions');
  }, []);


  // Listen for connection status changes
  React.useEffect(() => {
    // Catch up with the latest status even if the extension posted the connection message
    // before this component registered the event listener.
    const current =
      (typeof window !== 'undefined'
        ? (window as { __OPENCHAMBER_CONNECTION__?: { status?: string } }).__OPENCHAMBER_CONNECTION__?.status
        : undefined) as 'connecting' | 'connected' | 'error' | 'disconnected' | undefined;
    if (current === 'connected' || current === 'connecting' || current === 'error' || current === 'disconnected') {
      setConnectionStatus(current);
    }

    const handler = (event: Event) => {
      const detail = (event as CustomEvent<{ status?: string; error?: string }>).detail;
      const status = detail?.status;
      if (status === 'connected' || status === 'connecting' || status === 'error' || status === 'disconnected') {
        setConnectionStatus(status);
      }
    };
    window.addEventListener('openchamber:connection-status', handler as EventListener);
    return () => window.removeEventListener('openchamber:connection-status', handler as EventListener);
  }, []);

  // Listen for navigation events from VS Code extension title bar buttons
  React.useEffect(() => {
    const handler = (event: Event) => {
      const detail = (event as CustomEvent<{ view?: string }>).detail;
      const view = detail?.view;
      if (view === 'settings') {
        setCurrentView('settings');
      } else if (view === 'chat') {
        setCurrentView('chat');
      } else if (view === 'sessions') {
        setCurrentView('sessions');
      }
    };
    window.addEventListener('openchamber:navigate', handler as EventListener);
    return () => window.removeEventListener('openchamber:navigate', handler as EventListener);
  }, []);

  // Bootstrap config and sessions when connected
  React.useEffect(() => {
    const runBootstrap = async () => {
      if (isInitializing || hasInitializedOnce || connectionStatus !== 'connected') {
        return;
      }
      const now = Date.now();
      if (now - lastBootstrapAttemptAt.current < 750) {
        return;
      }
      lastBootstrapAttemptAt.current = now;
      setIsInitializing(true);
      try {
        const debugEnabled = (() => {
          if (typeof window === 'undefined') return false;
          try {
            return window.localStorage.getItem('openchamber_stream_debug') === '1';
          } catch {
            return false;
          }
        })();

        if (debugEnabled) console.log('[OpenChamber][VSCode][bootstrap] attempt', { configInitialized });
        if (!configInitialized) {
          await initializeConfig();
        }
        const configStore = useConfigStore.getState();

        // Keep trying to fetch core datasets on cold starts.
        if (configStore.isConnected) {
          if (configStore.providers.length === 0) {
            await configStore.loadProviders();
          }
          if (configStore.agents.length === 0) {
            await configStore.loadAgents();
          }
        }

        const configState = useConfigStore.getState();
        // If OpenCode is still warming up, the initial provider/agent loads can fail and be swallowed by retries.
        // Only mark bootstrap complete when core datasets are present so we keep retrying on cold starts.
        if (!configState.isInitialized || !configState.isConnected || configState.providers.length === 0 || configState.agents.length === 0) {
          return;
        }
        await loadSessions();
        const sessionsError = useSessionStore.getState().error;
        if (debugEnabled) console.log('[OpenChamber][VSCode][bootstrap] post-load', {
          providers: configState.providers.length,
          agents: configState.agents.length,
          sessions: useSessionStore.getState().sessions.length,
          sessionsError,
        });
        if (typeof sessionsError === 'string' && sessionsError.length > 0) {
          return;
        }
        setHasInitializedOnce(true);
      } catch {
        // Ignore bootstrap failures
      } finally {
        setIsInitializing(false);
      }
    };
    void runBootstrap();
  }, [connectionStatus, configInitialized, hasInitializedOnce, initializeConfig, isInitializing, loadSessions]);

  React.useEffect(() => {
    if (viewMode !== 'editor') {
      return;
    }
    if (hasAppliedInitialSession.current) {
      return;
    }
    if (!hasInitializedOnce || connectionStatus !== 'connected') {
      return;
    }

    // No initialSessionId means open a new session draft
    if (!initialSessionId) {
      hasAppliedInitialSession.current = true;
      openNewSessionDraft();
      return;
    }

    if (!sessions.some((session) => session.id === initialSessionId)) {
      return;
    }

    hasAppliedInitialSession.current = true;
    void useSessionStore.getState().setCurrentSession(initialSessionId);
  }, [connectionStatus, hasInitializedOnce, initialSessionId, openNewSessionDraft, sessions, viewMode]);

  // Hydrate messages when viewing chat
  React.useEffect(() => {
    const hydrateMessages = async () => {
      if (!hasInitializedOnce || connectionStatus !== 'connected' || currentView !== 'chat' || newSessionDraftOpen) {
        return;
      }

      if (!currentSessionId) {
        return;
      }

      const hasMessagesEntry = messages.has(currentSessionId);
      if (hasMessagesEntry) {
        return;
      }

      try {
        await loadMessages(currentSessionId);
      } catch {
        /* ignored */
      }
    };

    void hydrateMessages();
  }, [connectionStatus, currentSessionId, currentView, hasInitializedOnce, loadMessages, messages, newSessionDraftOpen]);

  // Track container width for responsive settings layout
  React.useEffect(() => {
    const container = containerRef.current;
    if (!container) return;

    const observer = new ResizeObserver((entries) => {
      for (const entry of entries) {
        setContainerWidth(entry.contentRect.width);
      }
    });

    observer.observe(container);
    // Set initial width
    setContainerWidth(container.clientWidth);

    return () => observer.disconnect();
  }, []);

  const usesMobileLayout = containerWidth > 0 && containerWidth < MOBILE_WIDTH_THRESHOLD;
  const usesExpandedLayout = containerWidth >= EXPANDED_LAYOUT_THRESHOLD;

  const clampExpandedSidebarWidth = React.useCallback((value: number) => {
    return Math.min(SESSIONS_SIDEBAR_MAX_WIDTH, Math.max(SESSIONS_SIDEBAR_MIN_WIDTH, value));
  }, []);

  const handleExpandedSidebarResizeStart = React.useCallback((event: React.PointerEvent<HTMLDivElement>) => {
    try {
      event.currentTarget.setPointerCapture(event.pointerId);
    } catch {
      // ignore
    }
    expandedSidebarResizePointerIdRef.current = event.pointerId;
    expandedSidebarResizeStartXRef.current = event.clientX;
    expandedSidebarResizeStartWidthRef.current = expandedSidebarWidth;
    setIsResizingExpandedSidebar(true);
    event.preventDefault();
  }, [expandedSidebarWidth]);

  const handleExpandedSidebarResizeMove = React.useCallback((event: React.PointerEvent<HTMLDivElement>) => {
    if (expandedSidebarResizePointerIdRef.current !== event.pointerId) {
      return;
    }
    const delta = event.clientX - expandedSidebarResizeStartXRef.current;
    const nextWidth = clampExpandedSidebarWidth(expandedSidebarResizeStartWidthRef.current + delta);
    setExpandedSidebarWidth((current) => (current === nextWidth ? current : nextWidth));
  }, [clampExpandedSidebarWidth]);

  const handleExpandedSidebarResizeEnd = React.useCallback((event: React.PointerEvent<HTMLDivElement>) => {
    if (expandedSidebarResizePointerIdRef.current !== event.pointerId) {
      return;
    }
    try {
      event.currentTarget.releasePointerCapture(event.pointerId);
    } catch {
      // ignore
    }
    expandedSidebarResizePointerIdRef.current = null;
    setIsResizingExpandedSidebar(false);
  }, []);

  // In expanded layout, always show chat (with sidebar alongside)
  // Navigate to chat automatically when expanded layout is enabled and we're on sessions view
  React.useEffect(() => {
    if (usesExpandedLayout && currentView === 'sessions' && viewMode === 'sidebar') {
      setCurrentView('chat');
    }
  }, [usesExpandedLayout, currentView, viewMode]);

  return (
    <div ref={containerRef} className="h-full w-full bg-background text-foreground flex flex-col">
      {viewMode === 'editor' ? (
        // Editor mode: just chat, no sidebar
        <div className="flex flex-col h-full">
            <VSCodeHeader
            title={sessions.find((session) => session.id === currentSessionId)?.title || t('vscodeLayout.chat')}
            showMcp
            showContextUsage
          />
          <div className="flex-1 overflow-hidden">
            <ErrorBoundary>
              <ChatView />
            </ErrorBoundary>
          </div>
        </div>
      ) : currentView === 'settings' ? (
        // Settings view
        <SettingsView
          onClose={() => setCurrentView(usesExpandedLayout ? 'chat' : 'sessions')}
          forceMobile={usesMobileLayout}
        />
      ) : usesExpandedLayout ? (
        // Expanded layout: sessions sidebar + chat side by side
        <div className="flex h-full">
          {/* Sessions sidebar */}
          <div
            className={cn('relative h-full border-r border-border overflow-hidden flex-shrink-0', isResizingExpandedSidebar && 'select-none')}
            style={{ width: expandedSidebarWidth, minWidth: expandedSidebarWidth, maxWidth: expandedSidebarWidth }}
          >
            <SessionSidebar
              mobileVariant
              allowReselect
              hideDirectoryControls
              showOnlyMainWorkspace
            />
            <div
              className={cn(
                'absolute right-0 top-0 z-20 h-full w-[3px] cursor-col-resize transition-colors hover:bg-[var(--interactive-border)]/80',
                isResizingExpandedSidebar && 'bg-[var(--interactive-border)]'
              )}
              onPointerDown={handleExpandedSidebarResizeStart}
              onPointerMove={handleExpandedSidebarResizeMove}
              onPointerUp={handleExpandedSidebarResizeEnd}
              onPointerCancel={handleExpandedSidebarResizeEnd}
              role="separator"
              aria-orientation="vertical"
              aria-label={t('vscodeLayout.resizeSessionsSidebar')}
            />
          </div>
          {/* Chat content */}
          <div className="flex-1 flex flex-col min-w-0">
            <VSCodeHeader
              title={newSessionDraftOpen && !currentSessionId
                ? t('vscodeLayout.newSession')
                : sessions.find((session) => session.id === currentSessionId)?.title || t('vscodeLayout.chat')}
              showMcp
              showContextUsage
            />
            <div className="flex-1 overflow-hidden">
              <ErrorBoundary>
                <ChatView />
              </ErrorBoundary>
            </div>
          </div>
        </div>
      ) : (
        // Compact layout: drill-down between sessions list and chat
        <>
          {/* Sessions list view */}
          <div className={cn('flex flex-col h-full', currentView !== 'sessions' && 'hidden')}>
            <VSCodeHeader
              title={t('vscodeLayout.sessions')}
            />
            <div className="flex-1 overflow-hidden">
              <SessionSidebar
                mobileVariant
                allowReselect
                onSessionSelected={() => setCurrentView('chat')}
                hideDirectoryControls
                showOnlyMainWorkspace
              />
            </div>
          </div>
          {/* Chat view */}
          <div className={cn('flex flex-col h-full', currentView !== 'chat' && 'hidden')}>
            <VSCodeHeader
              title={newSessionDraftOpen && !currentSessionId
                ? t('vscodeLayout.newSession')
                : sessions.find((session) => session.id === currentSessionId)?.title || t('vscodeLayout.chat')}
              showBack
              onBack={handleBackToSessions}
              showMcp
              showContextUsage
              showRateLimits
            />
            <div className="flex-1 overflow-hidden">
              <ErrorBoundary>
                <ChatView />
              </ErrorBoundary>
            </div>
          </div>
        </>
      )}
    </div>
  );
};

interface VSCodeHeaderProps {
  title: string;
  showBack?: boolean;
  onBack?: () => void;
  onNewSession?: () => void;
  onSettings?: () => void;
  onAgentManager?: () => void;
  showMcp?: boolean;
  showContextUsage?: boolean;
  showRateLimits?: boolean;
}

const VSCodeHeader: React.FC<VSCodeHeaderProps> = ({ title, showBack, onBack, onNewSession, onSettings, onAgentManager, showMcp, showContextUsage, showRateLimits }) => {
  const { t } = useLanguage();
  const { getCurrentModel } = useConfigStore();
  const getContextUsage = useSessionStore((state) => state.getContextUsage);
  const quotaResults = useQuotaStore((state) => state.results);
  const fetchAllQuotas = useQuotaStore((state) => state.fetchAllQuotas);
  const isQuotaLoading = useQuotaStore((state) => state.isLoading);
  const quotaLastUpdated = useQuotaStore((state) => state.lastUpdated);
  const quotaDisplayMode = useQuotaStore((state) => state.displayMode);
  const dropdownProviderIds = useQuotaStore((state) => state.dropdownProviderIds);
  const loadQuotaSettings = useQuotaStore((state) => state.loadSettings);
  const setQuotaDisplayMode = useQuotaStore((state) => state.setDisplayMode);

  useQuotaAutoRefresh();

  React.useEffect(() => {
    void loadQuotaSettings();
  }, [loadQuotaSettings]);

  const currentModel = getCurrentModel();
  const limits = (currentModel?.limit && typeof currentModel.limit === 'object'
    ? currentModel.limit
    : null) as { context?: number; output?: number } | null;
  const contextLimit = typeof limits?.context === 'number' ? limits.context : 0;
  const outputLimit = typeof limits?.output === 'number' ? limits.output : 0;
  const contextUsage = getContextUsage(contextLimit, outputLimit);

  const rateLimitGroups = React.useMemo(() => {
    const groups: Array<{
      providerId: string;
      providerName: string;
      entries: Array<[string, UsageWindow]>;
      error?: string;
    }> = [];

    for (const provider of QUOTA_PROVIDERS) {
      if (!dropdownProviderIds.includes(provider.id)) {
        continue;
      }
      const result = quotaResults.find((entry) => entry.providerId === provider.id);
      const windows = (result?.usage?.windows ?? {}) as Record<string, UsageWindow>;
      const entries = Object.entries(windows);
      const error = (result && !result.ok && result.configured) ? result.error : undefined;
      if (entries.length > 0 || error) {
        groups.push({ providerId: provider.id, providerName: provider.name, entries, error });
      }
    }

    return groups;
  }, [dropdownProviderIds, quotaResults]);
  const hasRateLimits = rateLimitGroups.length > 0;

  const handleDisplayModeChange = React.useCallback(async (mode: 'usage' | 'remaining') => {
    setQuotaDisplayMode(mode);
    try {
      await updateDesktopSettings({ usageDisplayMode: mode });
    } catch (error) {
      console.warn('Failed to update usage display mode:', error);
    }
  }, [setQuotaDisplayMode]);

  return (
    <div className="flex items-center gap-1.5 pl-3 pr-2 py-1 border-b border-border bg-background shrink-0">
      {showBack && onBack && (
        <button
          onClick={onBack}
          className="inline-flex h-7 w-7 items-center justify-center text-muted-foreground hover:text-foreground transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-primary"
          aria-label={t('vscodeLayout.backToSessions')}
        >
          <RiArrowLeftLine className="h-5 w-5" />
        </button>
      )}
      <h1 className="text-sm font-medium truncate flex-1" title={title}>{title}</h1>
      {onNewSession && (
        <button
          onClick={onNewSession}
          className="inline-flex h-9 w-9 items-center justify-center p-2 text-muted-foreground hover:text-foreground transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-primary"
          aria-label={t('vscodeLayout.newSession')}
        >
          <RiAddLine className="h-5 w-5" />
        </button>
      )}
      {onAgentManager && (
        <button
          onClick={onAgentManager}
          className="inline-flex h-9 w-9 items-center justify-center p-2 text-muted-foreground hover:text-foreground transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-primary"
          aria-label={t('vscodeLayout.openAgentManager')}
        >
          <RiRobot2Line className="h-5 w-5" />
        </button>
      )}
      {showMcp && (
        <McpDropdown
          headerIconButtonClass="inline-flex h-9 w-9 items-center justify-center p-2 text-muted-foreground hover:text-foreground transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-primary"
        />
      )}
      {showRateLimits && (
        <DropdownMenu
          onOpenChange={(open) => {
            if (open && quotaResults.length === 0) {
              fetchAllQuotas();
            }
          }}
        >
          <DropdownMenuTrigger asChild>
            <button
              type="button"
              aria-label={t('vscodeLayout.rateLimits')}
              className="inline-flex h-9 w-9 items-center justify-center p-2 text-muted-foreground hover:text-foreground transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-primary"
              disabled={isQuotaLoading}
            >
              <RiTimerLine className="h-5 w-5" />
            </button>
          </DropdownMenuTrigger>
          <DropdownMenuContent
            align="end"
            className="w-80 max-h-[70vh] overflow-y-auto overflow-x-hidden bg-[var(--surface-elevated)] p-0"
          >
            <div className="sticky top-0 z-20 bg-[var(--surface-elevated)]">
              <DropdownMenuLabel className="flex items-center justify-between gap-3 typography-ui-header font-semibold text-foreground">
                <span>{t('vscodeLayout.rateLimits')}</span>
                <div className="flex items-center gap-1">
                  <div className="flex items-center rounded-md border border-[var(--interactive-border)] p-0.5">
                    <button
                      type="button"
                      className={
                        `px-2 py-0.5 rounded-sm typography-micro text-[10px] transition-colors ${
                          quotaDisplayMode === 'usage'
                            ? 'bg-interactive-selection text-interactive-selection-foreground'
                            : 'text-muted-foreground hover:text-foreground'
                        }`
                      }
                      onClick={() => void handleDisplayModeChange('usage')}
                      aria-label={t('vscodeLayout.showUsedQuota')}
                    >
                      {t('vscodeLayout.used')}
                    </button>
                    <button
                      type="button"
                      className={
                        `px-2 py-0.5 rounded-sm typography-micro text-[10px] transition-colors ${
                          quotaDisplayMode === 'remaining'
                            ? 'bg-interactive-selection text-interactive-selection-foreground'
                            : 'text-muted-foreground hover:text-foreground'
                        }`
                      }
                      onClick={() => void handleDisplayModeChange('remaining')}
                      aria-label={t('vscodeLayout.showRemainingQuota')}
                    >
                      {t('vscodeLayout.remaining')}
                    </button>
                  </div>
                  <button
                    type="button"
                    className="inline-flex h-7 w-7 items-center justify-center rounded-md text-muted-foreground transition-colors hover:text-foreground hover:bg-interactive-hover focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-primary"
                    onClick={() => fetchAllQuotas()}
                    disabled={isQuotaLoading}
                    aria-label={t('vscodeLayout.refreshRateLimits')}
                  >
                    <RiRefreshLine className="h-4 w-4" />
                  </button>
                </div>
              </DropdownMenuLabel>
            </div>
            <div className="border-b border-[var(--interactive-border)] px-2 pb-2 typography-micro text-muted-foreground text-[10px]">
              {t('vscodeLayout.lastUpdated', { time: formatTime(quotaLastUpdated) })}
            </div>
            {!hasRateLimits && (
              <DropdownMenuItem className="cursor-default" onSelect={(event) => event.preventDefault()}>
                <span className="typography-ui-label text-muted-foreground">{t('vscodeLayout.noRateLimitsAvailable')}</span>
              </DropdownMenuItem>
            )}
            {rateLimitGroups.map((group, index) => (
              <React.Fragment key={group.providerId}>
                <DropdownMenuLabel className="flex items-center gap-2 bg-[var(--surface-elevated)] typography-ui-label text-foreground">
                  <ProviderLogo providerId={group.providerId} className="h-4 w-4" />
                  {group.providerName}
                </DropdownMenuLabel>
                {group.entries.length === 0 ? (
                  <DropdownMenuItem
                    key={`${group.providerId}-empty`}
                    className="cursor-default"
                    onSelect={(event) => event.preventDefault()}
                  >
                    <span className="typography-ui-label text-muted-foreground">
                      {group.error ?? t('vscodeLayout.noRateLimitsReported')}
                    </span>
                  </DropdownMenuItem>
                ) : (
                  group.entries.map(([label, window]) => {
                    const displayPercent = quotaDisplayMode === 'remaining'
                      ? window.remainingPercent
                      : window.usedPercent;
                    const paceInfo = calculatePace(window.usedPercent, window.resetAt, window.windowSeconds, label);
                    const expectedMarker = paceInfo?.dailyAllocationPercent != null
                      ? (quotaDisplayMode === 'remaining'
                          ? 100 - calculateExpectedUsagePercent(paceInfo.elapsedRatio)
                          : calculateExpectedUsagePercent(paceInfo.elapsedRatio))
                      : null;
                    return (
                    <DropdownMenuItem
                      key={`${group.providerId}-${label}`}
                      className="cursor-default items-start"
                      onSelect={(event) => event.preventDefault()}
                    >
                      <span className="flex min-w-0 flex-1 flex-col gap-2">
                              <span className="flex min-w-0 items-center justify-between gap-3">
                                <span className="truncate typography-micro text-muted-foreground">{formatWindowLabel(label)}</span>
                                <span className="typography-ui-label text-foreground tabular-nums">
                                  {formatPercent(displayPercent) === '-' ? '' : formatPercent(displayPercent)}
                                </span>
                              </span>
                              <UsageProgressBar
                                percent={displayPercent}
                                tonePercent={window.usedPercent}
                                className="h-1"
                                expectedMarkerPercent={expectedMarker}
                              />
                              {paceInfo && (
                                <div className="mt-0.5">
                                  <PaceIndicator paceInfo={paceInfo} compact />
                                </div>
                              )}
                              <span className="flex items-center justify-between typography-micro text-muted-foreground text-[10px]">
                                <span>{window.resetAfterFormatted ?? window.resetAtFormatted ?? ''}</span>
                              </span>
                      </span>
                    </DropdownMenuItem>
                    );
                  })
                )}
                {index < rateLimitGroups.length - 1 && <DropdownMenuSeparator />}
              </React.Fragment>
            ))}
          </DropdownMenuContent>
        </DropdownMenu>
      )}
      {onSettings && (
        <button
          onClick={onSettings}
          className="inline-flex h-9 w-9 items-center justify-center p-2 text-muted-foreground hover:text-foreground transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-primary"
          aria-label={t('vscodeLayout.settings')}
        >
          <RiSettings3Line className="h-5 w-5" />
        </button>
      )}
      {showContextUsage && contextUsage && contextUsage.totalTokens > 0 && (
        <ContextUsageDisplay
          totalTokens={contextUsage.totalTokens}
          percentage={contextUsage.percentage}
          contextLimit={contextUsage.contextLimit}
          outputLimit={contextUsage.outputLimit ?? 0}
          size="compact"
        />
      )}
    </div>
  );
};
