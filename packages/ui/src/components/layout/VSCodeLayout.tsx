import React from 'react';
import { ErrorBoundary } from '../ui/ErrorBoundary';
import { SessionSidebar } from '@/components/session/SessionSidebar';
import { SessionDialogs } from '@/components/session/SessionDialogs';
import { ChatView } from '@/components/views/ChatView';
import { useSessionUIStore } from '@/sync/session-ui-store';
import { useViewportStore } from '@/sync/viewport-store';
import { useSessions, useDirectorySync, useSessionMessages, useSessionMessagesResolved } from '@/sync/sync-context';
import { getSyncParts } from '@/sync/sync-refs';
import { useConfigStore } from '@/stores/useConfigStore';
import { resolveGlobalSessionDirectory, useGlobalSessionsStore } from '@/stores/useGlobalSessionsStore';
import { ContextUsageDisplay } from '@/components/ui/ContextUsageDisplay';
import { McpDropdown } from '@/components/mcp/McpDropdown';
import { ArchiveAllDropdown } from '@/components/session/ArchiveAllDropdown';
import { SessionSwitcherDropdown } from '@/components/session/SessionSwitcherDropdown';
import { SessionsTabTitle } from '@/components/session/SessionsTabTitle';
import { useProjectsStore } from '@/stores/useProjectsStore';
import { useSessionDisplayStore } from '@/stores/useSessionDisplayStore';
import { cn } from '@/lib/utils';
import { computeSessionCostAndCounts, computeSessionTokenRate } from '@/stores/utils/tokenUtils';
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuLabel,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from '@/components/ui/dropdown-menu';
import { useRuntimeAPIs } from '@/hooks/useRuntimeAPIs';
import { useUpdatePolling } from '@/hooks/useUpdatePolling';
import { useI18n } from '@/lib/i18n';
import { toast } from '@/components/ui';
import { ProviderLogo } from '@/components/ui/ProviderLogo';
import { UsageProgressBar } from '@/components/sections/usage/UsageProgressBar';
import { PaceIndicator } from '@/components/sections/usage/PaceIndicator';
import { Icon } from "@/components/icon/Icon";
import { formatQuotaValueLabel, formatQuotaResetLabel, formatWindowLabel, QUOTA_PROVIDERS, calculatePace, calculateExpectedUsagePercent } from '@/lib/quota';
import { useQuotaAutoRefresh, useQuotaStore } from '@/stores/useQuotaStore';
import { updateDesktopSettings } from '@/lib/persistence';
import { formatTimeForPreference } from '@/lib/timeFormat';
import { lazyWithChunkRecovery } from '@/lib/chunkLoadRecovery';
import type { Session } from '@opencode-ai/sdk/v2';
import type { UsageWindow } from '@/types';
import type { SessionContextUsage } from '@/stores/types/sessionTypes';
import { useUIStore, type TimeFormatPreference } from '@/stores/useUIStore';

const SettingsView = lazyWithChunkRecovery(() => import('@/components/views/SettingsView').then(m => ({ default: m.SettingsView })));

const formatTime = (timestamp: number | null, timeFormatPreference: TimeFormatPreference) => {
  if (!timestamp) return '-';
  try {
    return formatTimeForPreference(timestamp, timeFormatPreference, { fallback: '-' });
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

const normalizePath = (value?: string | null): string | null => {
  if (typeof value !== 'string') return null;
  const trimmed = value.trim();
  if (!trimmed) return null;
  const replaced = trimmed.replace(/\\/g, '/');
  if (replaced === '/') return '/';
  return replaced.length > 1 ? replaced.replace(/\/+$/, '') : replaced;
};

type VSCodeView = 'sessions' | 'chat' | 'settings';

export const VSCodeLayout: React.FC = () => {
  const { t } = useI18n();
  const runtimeApis = useRuntimeAPIs();
  useUpdatePolling();

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
      return Boolean(useSessionUIStore.getState().newSessionDraft?.open);
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
  const currentSessionId = useSessionUIStore((state) => state.currentSessionId);
  const sessions = useSessions();
  const globalActiveSessions = useGlobalSessionsStore((state) => state.activeSessions);
  const globalArchivedSessions = useGlobalSessionsStore((state) => state.archivedSessions);
  const projects = useProjectsStore((state) => state.projects);
  const activeProjectId = useProjectsStore((state) => state.activeProjectId);

  const activeWorkspacePath = React.useMemo(() => {
    const activeProject = activeProjectId
      ? projects.find((project) => project.id === activeProjectId) ?? null
      : projects[0] ?? null;
    return normalizePath(activeProject?.path ?? null);
  }, [activeProjectId, projects]);
  const newSessionDraftOpen = useSessionUIStore((state) => Boolean(state.newSessionDraft?.open));
  const activeSessionTitleValue = useDirectorySync(
    React.useCallback((state) => {
      if (!currentSessionId) {
        return null;
      }
      return state.session.find((session) => session.id === currentSessionId)?.title || null;
    }, [currentSessionId]),
  );
  const initialSessionExists = useDirectorySync(
    React.useCallback((state) => {
      if (!initialSessionId) {
        return false;
      }
      return state.session.some((session) => session.id === initialSessionId);
    }, [initialSessionId]),
  );

  const activeSessionTitle = currentSessionId
    ? activeSessionTitleValue || t('vscodeLayout.title.sessionFallback')
    : null;
  const chatTitle = newSessionDraftOpen && !currentSessionId
    ? t('vscodeLayout.title.newSession')
    : activeSessionTitle || t('vscodeLayout.title.chat');
  const isSyncingMessages = useViewportStore((state) => state.isSyncing);
  const hasActiveSessionWork = useDirectorySync((state) => {
    const statuses = state.session_status;
    if (!statuses || Object.keys(statuses).length === 0) {
      return false;
    }
    for (const status of Object.values(statuses)) {
      if (status?.type === 'busy' || status?.type === 'retry') {
        return true;
      }
    }
    return false;
  });
  const openNewSessionDraft = useSessionUIStore((state) => state.openNewSessionDraft);
  const [connectionStatus, setConnectionStatus] = React.useState<'connecting' | 'connected' | 'error' | 'disconnected'>(
    () => (typeof window !== 'undefined'
      ? (window as { __OPENCHAMBER_CONNECTION__?: { status?: string } }).__OPENCHAMBER_CONNECTION__?.status as
        'connecting' | 'connected' | 'error' | 'disconnected' | undefined
      : 'connecting') || 'connecting'
  );
  const configInitialized = useConfigStore((state) => state.isInitialized);
  const initializeConfig = useConfigStore((state) => state.initializeApp);
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

  React.useEffect(() => {
    if (viewMode !== 'editor' || !currentSessionId || !activeSessionTitle) {
      return;
    }

    const vscodeApi = runtimeApis.vscode;
    if (!vscodeApi) {
      return;
    }

    void vscodeApi.executeCommand('openchamber.updateSessionEditorTitle', currentSessionId, activeSessionTitle);
  }, [activeSessionTitle, currentSessionId, runtimeApis.vscode, viewMode]);

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
      const state = useSessionUIStore.getState();
      const stillNoSession = !state.currentSessionId;
      const draftStillClosed = !state.newSessionDraft?.open;
      const stillSyncing = useViewportStore.getState().isSyncing;
      const stillActiveWork = false; // sync bootstrap tracks session status

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

  const isSessionInActiveWorkspace = React.useCallback((session: Session): boolean => {
    if (!activeWorkspacePath) {
      return false;
    }

    const sessionDirectory = resolveGlobalSessionDirectory(session);
    if (sessionDirectory) {
      return sessionDirectory.toLowerCase() === activeWorkspacePath.toLowerCase();
    }

    return false;
  }, [activeWorkspacePath]);

  const traversalSessions = React.useMemo(() => {
    const byId = new Map<string, Session>();
    for (const session of sessions) byId.set(session.id, session);
    for (const session of globalActiveSessions) byId.set(session.id, session);
    for (const session of globalArchivedSessions) byId.set(session.id, session);
    return Array.from(byId.values());
  }, [globalActiveSessions, globalArchivedSessions, sessions]);

  /** Collect root session IDs and all descendants (subagent sessions). */
  const collectSessionIdsWithDescendants = React.useCallback(
    (allSessions: Session[], rootSessions: Session[]): string[] => {
      const byId = new Map<string, Session>();
      for (const session of allSessions) byId.set(session.id, session);

      const childrenMap = new Map<string, string[]>();
      for (const session of allSessions) {
        const parentID = session.parentID;
        if (parentID) {
          const list = childrenMap.get(parentID) ?? [];
          list.push(session.id);
          childrenMap.set(parentID, list);
        }
      }

      const ids = new Set<string>();
      const addDescendants = (sessionId: string, visited: Set<string>) => {
        if (visited.has(sessionId)) return; // cycle guard
        visited.add(sessionId);
        const children = childrenMap.get(sessionId) ?? [];
        for (const childId of children) {
          const child = byId.get(childId);
          if (child?.time?.archived) continue; // skip already-archived children
          ids.add(childId);
          addDescendants(childId, visited);
        }
      };

      for (const session of rootSessions) {
        ids.add(session.id);
        addDescendants(session.id, new Set());
      }

      return Array.from(ids);
    },
    [],
  );

  const handleArchiveAll = React.useCallback(async () => {
    const store = useSessionUIStore.getState();
    const rootSessions = traversalSessions.filter((session) => !session.time?.archived && isSessionInActiveWorkspace(session));
    const allIds = collectSessionIdsWithDescendants(traversalSessions, rootSessions);
    if (allIds.length === 0) return;

    const { archivedIds, failedIds } = await store.archiveSessions(allIds);
    if (archivedIds.length > 0) {
      toast.success(t('vscodeLayout.actions.archiveAllSuccess', { count: archivedIds.length }));
    }
    if (failedIds.length > 0) {
      toast.error(t('vscodeLayout.actions.archiveAllError', { count: failedIds.length }));
    }
  }, [collectSessionIdsWithDescendants, isSessionInActiveWorkspace, traversalSessions, t]);


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
            await configStore.loadProviders({ source: 'vscodeLayout:bootstrap' });
          }
          if (configStore.agents.length === 0) {
            await configStore.loadAgents({ source: 'vscodeLayout:bootstrap' });
          }
        }

        const configState = useConfigStore.getState();
        // If OpenCode is still warming up, the initial provider/agent loads can fail and be swallowed by retries.
        // Only mark bootstrap complete when core datasets are present so we keep retrying on cold starts.
        if (!configState.isInitialized || !configState.isConnected || configState.providers.length === 0 || configState.agents.length === 0) {
          return;
        }
        if (debugEnabled) console.log('[OpenChamber][VSCode][bootstrap] post-load', {
          providers: configState.providers.length,
          agents: configState.agents.length,
        });
        setHasInitializedOnce(true);
      } catch {
        // Ignore bootstrap failures
      } finally {
        setIsInitializing(false);
      }
    };
    void runBootstrap();
  }, [connectionStatus, configInitialized, hasInitializedOnce, initializeConfig, isInitializing]);

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

    if (!initialSessionExists) {
      return;
    }

    hasAppliedInitialSession.current = true;
    void useSessionUIStore.getState().setCurrentSession(initialSessionId);
  }, [connectionStatus, hasInitializedOnce, initialSessionExists, initialSessionId, openNewSessionDraft, viewMode]);

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
            title={activeSessionTitle || t('vscodeLayout.title.chat')}
            showMcp
            showContextUsage
            showRateLimits
            enableSessionSwitcher
          />
          <div className="flex-1 overflow-hidden">
            <ErrorBoundary>
              <ChatView />
            </ErrorBoundary>
          </div>
        </div>
      ) : currentView === 'settings' ? (
        // Settings view
        <React.Suspense fallback={null}>
          <SettingsView
            onClose={() => setCurrentView(usesExpandedLayout ? 'chat' : 'sessions')}
            forceMobile={usesMobileLayout}
          />
        </React.Suspense>
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
              aria-label={t('vscodeLayout.actions.resizeSessionsSidebarAria')}
            />
          </div>
          {/* Chat content */}
          <div className="flex-1 flex flex-col min-w-0">
            <VSCodeHeader
              title={chatTitle}
              showMcp
              showContextUsage
              showRateLimits
              enableSessionSwitcher
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
          {currentView === 'sessions' ? (
            <div className="flex flex-col h-full">
              <VSCodeHeader
                title={t('vscodeLayout.title.sessions')}
                onArchiveAll={handleArchiveAll}
              />
              <div className="flex-1 overflow-hidden">
                <SessionSidebar
                  mobileVariant
                  allowReselect
                  onSessionSelected={() => setCurrentView('chat')}
                  hideDirectoryControls
                />
              </div>
            </div>
          ) : null}
          {/* Chat view */}
          <div className={cn('flex flex-col h-full', currentView !== 'chat' && 'hidden')}>
            <VSCodeHeader
              title={chatTitle}
              showBack
              onBack={handleBackToSessions}
              showMcp
              showContextUsage
              showRateLimits
              enableSessionSwitcher
            />
            <div className="flex-1 overflow-hidden">
              <ErrorBoundary>
                <ChatView />
              </ErrorBoundary>
            </div>
          </div>
        </>
      )}
      <SessionDialogs />
    </div>
  );
};

interface VSCodeHeaderProps {
  title: string;
  showBack?: boolean;
  onBack?: () => void;
  onArchiveAll?: () => void;
  onNewSession?: () => void;
  onSettings?: () => void;
  onAgentManager?: () => void;
  showMcp?: boolean;
  showContextUsage?: boolean;
  showRateLimits?: boolean;
  enableSessionSwitcher?: boolean;
}


const VSCodeHeader: React.FC<VSCodeHeaderProps> = ({ title, showBack, onBack, onArchiveAll, onNewSession, onSettings, onAgentManager, showMcp, showContextUsage, showRateLimits, enableSessionSwitcher }) => {
  const { t } = useI18n();
  const showArchivedSessions = useSessionDisplayStore((state) => state.showArchivedSessions);
  const toggleArchivedSessions = useSessionDisplayStore((state) => state.toggleArchivedSessions);
  const getCurrentModel = useConfigStore((state) => state.getCurrentModel);
  const providers = useConfigStore((state) => state.providers);
  const currentSessionId = useSessionUIStore((state) => state.currentSessionId);
  const activeProjectId = useProjectsStore((state) => state.activeProjectId);
  const currentSessionMessages = useSessionMessages(currentSessionId ?? '');
  const currentSessionMessagesResolved = useSessionMessagesResolved(currentSessionId ?? '');
  const quotaResults = useQuotaStore((state) => state.results);
  const fetchAllQuotas = useQuotaStore((state) => state.fetchAllQuotas);
  const isQuotaLoading = useQuotaStore((state) => state.isLoading);
  const quotaLastUpdated = useQuotaStore((state) => state.lastUpdated);
  const quotaDisplayMode = useQuotaStore((state) => state.displayMode);
  const showPredValues = useQuotaStore((state) => state.showPredValues);
  const timeFormatPreference = useUIStore((state) => state.timeFormatPreference);
  const dropdownProviderIds = useQuotaStore((state) => state.dropdownProviderIds);
  const loadQuotaSettings = useQuotaStore((state) => state.loadSettings);
  const setQuotaDisplayMode = useQuotaStore((state) => state.setDisplayMode);

  useQuotaAutoRefresh();

  React.useEffect(() => {
    void loadQuotaSettings();
  }, [loadQuotaSettings]);

  const currentModel = getCurrentModel();
  const headerMessageSummary = React.useMemo(() => {
    type AssistantTokens = { input: number; output: number; reasoning: number; cache: { read: number; write: number } };
    let latestAssistantModel: ReturnType<typeof getCurrentModel> | undefined;
    let lastTokens: AssistantTokens | undefined;
    let lastMessageId: string | undefined;

    for (let i = currentSessionMessages.length - 1; i >= 0; i -= 1) {
      const message = currentSessionMessages[i] as { role?: unknown; providerID?: unknown; modelID?: unknown; tokens?: AssistantTokens };
      if (message.role !== 'assistant') {
        continue;
      }

      if (!latestAssistantModel && typeof message.providerID === 'string' && typeof message.modelID === 'string') {
        const provider = providers.find((entry) => entry.id === message.providerID);
        latestAssistantModel = provider?.models.find((entry) => entry.id === message.modelID);
      }

      if (!lastTokens && message.tokens) {
        const total = message.tokens.input + message.tokens.output + message.tokens.reasoning + (message.tokens.cache?.read ?? 0) + (message.tokens.cache?.write ?? 0);
        if (total > 0) {
          lastTokens = message.tokens;
          lastMessageId = (currentSessionMessages[i] as { id?: string }).id;
        }
      }

      if (latestAssistantModel && lastTokens) {
        break;
      }
    }

    return { latestAssistantModel, lastTokens, lastMessageId };
  }, [currentSessionMessages, providers]);
  const latestAssistantModel = headerMessageSummary.latestAssistantModel;
  const modelForLimits = currentModel?.limit ? currentModel : latestAssistantModel;
  const limit = modelForLimits && typeof modelForLimits.limit === 'object' && modelForLimits.limit !== null
    ? (modelForLimits.limit as Record<string, unknown>)
    : null;
  const contextLimit = limit && typeof limit.context === 'number' ? limit.context : 0;
  const outputLimit = limit && typeof limit.output === 'number' ? limit.output : 0;

  const contextUsage = React.useMemo<SessionContextUsage | null>(() => {
    if (!currentSessionId || !headerMessageSummary.lastTokens) {
      return null;
    }

    const lastTokens = headerMessageSummary.lastTokens;
    const totalTokens = lastTokens.input + lastTokens.output + lastTokens.reasoning + (lastTokens.cache?.read ?? 0) + (lastTokens.cache?.write ?? 0);
    const thresholdLimit = contextLimit > 0 ? contextLimit : 200000;
    const percentage = contextLimit > 0 ? Math.round((totalTokens / contextLimit) * 100) : 0;
    const normalizedOutput = outputLimit > 0 ? Math.round((lastTokens.output / outputLimit) * 100) : undefined;

    const { totalCost, userCount, assistantCount } = computeSessionCostAndCounts(currentSessionMessages);
    const { avgTokensPerSecond, lastTokensPerSecond } = computeSessionTokenRate(currentSessionMessages, getSyncParts);

    return {
      totalTokens,
      percentage,
      contextLimit: contextLimit || 0,
      outputLimit: outputLimit || undefined,
      normalizedOutput,
      thresholdLimit,
      lastMessageId: headerMessageSummary.lastMessageId,
      cost: totalCost > 0 ? totalCost : undefined,
      totalMessages: currentSessionMessages.length,
      userMessages: userCount,
      assistantMessages: assistantCount,
      tokensPerSecond: avgTokensPerSecond > 0 ? avgTokensPerSecond : undefined,
      lastTokensPerSecond: lastTokensPerSecond > 0 ? lastTokensPerSecond : undefined,
    };
  }, [contextLimit, currentSessionId, currentSessionMessages, headerMessageSummary.lastMessageId, headerMessageSummary.lastTokens, outputLimit]);
  const [stableContextUsage, setStableContextUsage] = React.useState<SessionContextUsage | null>(null);
  const isContextUsageResolvedForSession = !currentSessionId || currentSessionMessagesResolved;

  React.useEffect(() => {
    if (!currentSessionId) {
      setStableContextUsage((prev) => (prev === null ? prev : null));
      return;
    }

    if (contextUsage && contextUsage.totalTokens > 0) {
      setStableContextUsage((prev) => {
        if (
          prev
          && prev.totalTokens === contextUsage.totalTokens
          && prev.percentage === contextUsage.percentage
          && prev.contextLimit === contextUsage.contextLimit
          && (prev.outputLimit ?? 0) === (contextUsage.outputLimit ?? 0)
          && (prev.normalizedOutput ?? 0) === (contextUsage.normalizedOutput ?? 0)
          && prev.thresholdLimit === contextUsage.thresholdLimit
          && prev.lastMessageId === contextUsage.lastMessageId
          && (prev.cost ?? 0) === (contextUsage.cost ?? 0)
          && (prev.totalMessages ?? 0) === (contextUsage.totalMessages ?? 0)
          && (prev.userMessages ?? 0) === (contextUsage.userMessages ?? 0)
          && (prev.assistantMessages ?? 0) === (contextUsage.assistantMessages ?? 0)
          && (prev.tokensPerSecond ?? 0) === (contextUsage.tokensPerSecond ?? 0)
          && (prev.lastTokensPerSecond ?? 0) === (contextUsage.lastTokensPerSecond ?? 0)
        ) {
          return prev;
        }
        return contextUsage;
      });
      return;
    }

    if (isContextUsageResolvedForSession) {
      setStableContextUsage((prev) => (prev === null ? prev : null));
    }
  }, [contextUsage, currentSessionId, isContextUsageResolvedForSession]);

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
          aria-label={t('vscodeLayout.actions.backToSessionsAria')}
        >
          <Icon name="arrow-left" className="h-5 w-5" />
        </button>
      )}
      {enableSessionSwitcher ? (
        <SessionSwitcherDropdown variant="compact" scopeProjectId={activeProjectId}>
          <button
            type="button"
            aria-label={t('sessions.switcher.openAria')}
            className="inline-flex min-w-0 max-w-full items-center rounded-md px-1 py-0.5 -my-0.5 text-left transition-colors hover:bg-interactive-hover/60 focus-visible:outline-none focus-visible:bg-interactive-hover/60"
          >
            <span className="text-sm font-medium truncate" title={title}>{title}</span>
          </button>
        </SessionSwitcherDropdown>
      ) : (
        <SessionsTabTitle title={title} />
      )}
      <div className="min-w-0 flex-1" />
      {onArchiveAll && (
        <button
          type="button"
          onClick={toggleArchivedSessions}
          className={cn(
            'inline-flex h-8 w-8 items-center justify-center p-2 transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-primary',
            showArchivedSessions ? 'text-primary' : 'text-muted-foreground hover:text-foreground',
          )}
          aria-label={t('sessions.sidebar.header.displayMode.showArchived')}
          aria-pressed={showArchivedSessions}
          title={t('sessions.sidebar.header.displayMode.showArchived')}
        >
          <Icon name="archive-stack" className="h-5 w-5" />
        </button>
      )}
      {onArchiveAll && <ArchiveAllDropdown onArchiveAll={onArchiveAll} />}
      {onNewSession && (
        <button
          onClick={onNewSession}
          className="inline-flex h-9 w-9 items-center justify-center p-2 text-muted-foreground hover:text-foreground transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-primary"
          aria-label={t('vscodeLayout.actions.newSessionAria')}
        >
          <Icon name="add" className="h-5 w-5" />
        </button>
      )}
      {onAgentManager && (
        <button
          onClick={onAgentManager}
          className="inline-flex h-9 w-9 items-center justify-center p-2 text-muted-foreground hover:text-foreground transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-primary"
          aria-label={t('vscodeLayout.actions.openAgentManagerAria')}
        >
          <Icon name="robot-2" className="h-5 w-5" />
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
              aria-label={t('vscodeLayout.quota.actions.rateLimitsAria')}
              className="inline-flex h-9 w-9 items-center justify-center p-2 text-muted-foreground hover:text-foreground transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-primary"
              disabled={isQuotaLoading}
            >
              <Icon name="timer" className="h-5 w-5" />
            </button>
          </DropdownMenuTrigger>
          <DropdownMenuContent
            align="end"
            className="w-80 max-h-[70vh] overflow-y-auto overflow-x-hidden bg-[var(--surface-elevated)] p-0"
          >
            <div className="sticky top-0 z-20 bg-[var(--surface-elevated)]">
              <DropdownMenuLabel className="flex items-center justify-between gap-3 typography-ui-header font-semibold text-foreground">
                <span>{t('vscodeLayout.quota.title')}</span>
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
                      aria-label={t('vscodeLayout.quota.actions.showUsedAria')}
                    >
                      {t('vscodeLayout.quota.mode.used')}
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
                      aria-label={t('vscodeLayout.quota.actions.showRemainingAria')}
                    >
                      {t('vscodeLayout.quota.mode.remaining')}
                    </button>
                  </div>
                  <button
                    type="button"
                    className="inline-flex h-7 w-7 items-center justify-center rounded-md text-muted-foreground transition-colors hover:text-foreground hover:bg-interactive-hover focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-primary"
                    onClick={() => fetchAllQuotas()}
                    disabled={isQuotaLoading}
                    aria-label={t('vscodeLayout.quota.actions.refreshAria')}
                  >
                    <Icon name="refresh" className="h-4 w-4" />
                  </button>
                </div>
              </DropdownMenuLabel>
            </div>
            <div className="border-b border-[var(--interactive-border)] px-2 pb-2 typography-micro text-muted-foreground text-[10px]">
              {t('vscodeLayout.quota.lastUpdated', { time: formatTime(quotaLastUpdated, timeFormatPreference) })}
            </div>
            {!hasRateLimits && (
              <DropdownMenuItem className="cursor-default" closeOnClick={false}>
                <span className="typography-ui-label text-muted-foreground">{t('vscodeLayout.quota.noRateLimitsAvailable')}</span>
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
                    closeOnClick={false}
                  >
                    <span className="typography-ui-label text-muted-foreground">
                      {group.error ?? t('vscodeLayout.quota.noRateLimitsReported')}
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
                    const metricLabel = formatQuotaValueLabel(window.valueLabel, displayPercent);
                    return (
                    <DropdownMenuItem
                      key={`${group.providerId}-${label}`}
                      className="cursor-default items-start"
                      closeOnClick={false}
                    >
                      <span className="flex min-w-0 flex-1 flex-col gap-2">
                              <span className="flex min-w-0 items-center justify-between gap-3">
                                <span className="truncate typography-micro text-muted-foreground">{formatWindowLabel(label)}</span>
                                <span className="typography-ui-label text-foreground tabular-nums">
                                  {metricLabel === '-' ? '' : metricLabel}
                                </span>
                              </span>
                              <UsageProgressBar
                                percent={displayPercent}
                                tonePercent={window.usedPercent}
                                className="h-1"
                                expectedMarkerPercent={expectedMarker}
                              />
                              {paceInfo && showPredValues && (
                                <div className="mt-0.5">
                                  <PaceIndicator paceInfo={paceInfo} compact />
                                </div>
                              )}
                              <span className="flex items-center justify-between typography-micro text-muted-foreground text-[10px]">
                                <span>{formatQuotaResetLabel(window.resetAt, window.resetAfterFormatted ?? window.resetAtFormatted, timeFormatPreference)}</span>
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
          aria-label={t('vscodeLayout.actions.settingsAria')}
        >
          <Icon name="settings-3" className="h-5 w-5" />
        </button>
      )}
      {showContextUsage && stableContextUsage && stableContextUsage.totalTokens > 0 && (
        <ContextUsageDisplay
          totalTokens={stableContextUsage.totalTokens}
          percentage={stableContextUsage.percentage}
          contextLimit={stableContextUsage.contextLimit}
          outputLimit={stableContextUsage.outputLimit ?? 0}
          cost={stableContextUsage.cost}
          totalMessages={stableContextUsage.totalMessages}
          userMessages={stableContextUsage.userMessages}
          assistantMessages={stableContextUsage.assistantMessages}
          tokensPerSecond={stableContextUsage.tokensPerSecond}
          lastTokensPerSecond={stableContextUsage.lastTokensPerSecond}
          className="h-9 shrink-0 pl-1 pr-1 typography-ui-label"
          valueClassName="font-semibold leading-none"
          hideIcon
          showPercentIcon
          percentIconClassName="h-4.5 w-4.5"
        />
      )}
    </div>
  );
};
