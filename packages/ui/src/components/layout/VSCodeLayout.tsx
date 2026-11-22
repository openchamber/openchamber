import React from 'react';
import { ErrorBoundary } from '../ui/ErrorBoundary';
import { SessionSidebar } from '@/components/session/SessionSidebar';
import { SessionDialogs } from '@/components/session/SessionDialogs';
import { ChatView } from '@/components/views/ChatView';
import { useSessionUIStore } from '@/sync/session-ui-store';
import { openSession } from '@/lib/router/openSessionFromRoute';
import { useViewportStore } from '@/sync/viewport-store';
import { useSessions, useDirectorySync, useSessionMessages, useSessionMessagesResolved } from '@/sync/sync-context';
import { useSubagentCostRollup } from '@/components/chat/work-status/useSubagentCostRollup';
import { useConfigStore } from '@/stores/useConfigStore';
import { useContextWindowLimits } from '@/hooks/useContextWindowLimits';
import { resolveGlobalSessionDirectory, useGlobalSessionsStore } from '@/stores/useGlobalSessionsStore';
import { buildSessionContextUsage, isSameContextUsage } from '@/stores/utils/tokenUtils';
import { ContextUsageDisplay } from '@/components/ui/ContextUsageDisplay';
import { toContextUsageReading } from '@/components/ui/contextUsageReading';
import { ArchiveAllDropdown } from '@/components/session/ArchiveAllDropdown';
import { SessionSwitcherDropdown } from '@/components/session/SessionSwitcherDropdown';
import { SessionsTabTitle } from '@/components/session/SessionsTabTitle';
import { handleSessionRenameKeyDown } from '@/components/session/sessionRenameKeyboard';
import { describeSessionActionError } from '@/components/session/sidebar/sessions/sessionActionError';
import { Button } from '@/components/ui/button';
import { DropdownMenu, DropdownMenuContent, DropdownMenuItem, DropdownMenuTrigger } from '@/components/ui/dropdown-menu';
import { useProjectsStore } from '@/stores/useProjectsStore';
import { useSessionDisplayStore } from '@/stores/useSessionDisplayStore';
import { useChatViewReveal } from '@/hooks/useChatViewReveal';
import { getVSCodeBootstrapConfig, getVSCodeBootstrapWorkspaceFolder } from '@/lib/vscodeBootstrap';
import { cn } from '@/lib/utils';
import { normalizePath } from '@/lib/pathNormalization';
import { useRuntimeAPIs } from '@/hooks/useRuntimeAPIs';
import { useKeybinds } from '@/hooks/useKeybind';
import { useTerminalSessionKeepalive } from '@/hooks/useTerminalSessionKeepalive';
import { useUpdatePolling } from '@/hooks/useUpdatePolling';
import { useI18n } from '@/lib/i18n';
import { toast } from '@/components/ui';
import { Icon } from "@/components/icon/Icon";
import type { Session } from '@/lib/opencode/model';
import type { SessionContextUsage } from '@/stores/types/sessionTypes';
import { useUIStore } from '@/stores/useUIStore';
import { useSessionListSync } from '@/components/session/sidebar/list/useSessionListSync';
import { RunOverview } from '@/components/multirun/RunOverview';
import { RunAutoFusion } from '@/lib/multirun/autoFusion';
import { WORK_STATUS_COLUMN_WIDTH } from '@/components/chat/work-status/useWorkStatusVisibility';
import { beginLayoutAnimation, LAYOUT_ANIMATION_EASING } from '@/lib/layoutAnimation';
import { useLayoutAnimationMs } from '@/hooks/useLayoutAnimationMs';
import { setChatCovered, setWorkStatusHost, useRightSlotStore } from './rightSlot';
import { useVSCodeSidebarResize } from './useVSCodeSidebarResize';

const EXPANDED_LAYOUT_THRESHOLD = 280 + 520;

type VSCodeView = 'sessions' | 'chat';

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

  const initialParallelComposer = React.useMemo<boolean>(() => getVSCodeBootstrapConfig()?.initialComposer === 'parallel', []);

  const bootstrapWorkspaceFolder = React.useMemo<string | null>(() => {
    return getVSCodeBootstrapWorkspaceFolder();
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
  const sidebarResize = useVSCodeSidebarResize();
  const sessionsSidebarOpen = useUIStore((state) => state.isSidebarOpen);
  const toggleSessionsSidebar = useUIStore((state) => state.toggleSidebar);
  const containerRef = React.useRef<HTMLDivElement>(null);
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
  const initialGlobalSessionDirectory = useGlobalSessionsStore((state) => {
    const session = initialSessionId ? state.entityById.get(initialSessionId) : null;
    return session ? resolveGlobalSessionDirectory(session) : null;
  });
  const initialLocalSessionDirectory = useDirectorySync(
    React.useCallback((state) => {
      const session = state.session.find((session) => session.id === initialSessionId);
      return session ? resolveGlobalSessionDirectory(session) : null;
    }, [initialSessionId]),
  );
  const initialSessionDirectory = initialGlobalSessionDirectory ?? initialLocalSessionDirectory;

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
      const stillActiveWork = false;

      if (stillNoSession && draftStillClosed && !stillSyncing && !stillActiveWork) {
        setCurrentView('sessions');
      }
    }, 900);

    return () => {
      window.clearTimeout(timeoutId);
    };
  }, [currentSessionId, newSessionDraftOpen, currentView, viewMode, isSyncingMessages, hasActiveSessionWork]);

  const handleBackToSessions = React.useCallback(() => {
    useUIStore.getState().setRunOverviewKey(null);
    setCurrentView('sessions');
  }, []);

  const runOverviewKey = useUIStore((state) => state.runOverviewKey);
  useChatViewReveal(setCurrentView, runOverviewKey);
  React.useEffect(() => useSessionUIStore.subscribe((state, prev) => {
    if (state.currentSessionId && state.currentSessionId !== prev.currentSessionId) {
      useUIStore.getState().setRunOverviewKey(null);
    }
  }), []);

  const handleSessionSelected = React.useCallback(() => {
    setCurrentView('chat');
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
        if (visited.has(sessionId)) return;
        visited.add(sessionId);
        const children = childrenMap.get(sessionId) ?? [];
        for (const childId of children) {
          const child = byId.get(childId);
          if (child?.time?.archived) continue;
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


  React.useEffect(() => {
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

  React.useEffect(() => {
    const handler = (event: Event) => {
      const detail = (event as CustomEvent<{ view?: string }>).detail;
      const view = detail?.view;
      if (view === 'chat') {
        setCurrentView('chat');
      } else if (view === 'sessions') {
        setCurrentView('sessions');
      }
    };
    window.addEventListener('openchamber:navigate', handler as EventListener);
    return () => window.removeEventListener('openchamber:navigate', handler as EventListener);
  }, []);

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

        if (configStore.isConnected) {
          if (!configStore.providersLoaded) {
            await configStore.loadProviders({ source: 'vscodeLayout:bootstrap' });
          }
          if (!useConfigStore.getState().agentsLoaded) {
            await configStore.loadAgents({ source: 'vscodeLayout:bootstrap' });
          }
        }

        const configState = useConfigStore.getState();
        if (!configState.isInitialized || !configState.isConnected || !configState.providersLoaded || !configState.agentsLoaded) {
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

    if (!initialSessionId) {
      hasAppliedInitialSession.current = true;
      openNewSessionDraft({ automatic: true, directoryOverride: bootstrapWorkspaceFolder });
      if (initialParallelComposer) useUIStore.getState().requestParallelComposer();
      return;
    }

    if (!initialSessionDirectory) {
      return;
    }

    hasAppliedInitialSession.current = true;
    void openSession(initialSessionId, { directory: initialSessionDirectory });
  }, [bootstrapWorkspaceFolder, connectionStatus, hasInitializedOnce, initialParallelComposer, initialSessionDirectory, initialSessionId, openNewSessionDraft, viewMode]);

  React.useEffect(() => {
    const container = containerRef.current;
    if (!container) return;

    const observer = new ResizeObserver((entries) => {
      for (const entry of entries) {
        setContainerWidth(entry.contentRect.width);
      }
    });

    observer.observe(container);
    setContainerWidth(container.clientWidth);

    return () => observer.disconnect();
  }, []);

  const usesExpandedLayout = containerWidth >= EXPANDED_LAYOUT_THRESHOLD;

  React.useEffect(() => {
    if (usesExpandedLayout && currentView === 'sessions' && viewMode === 'sidebar') {
      setCurrentView('chat');
    }
  }, [usesExpandedLayout, currentView, viewMode]);

  useSessionListSync({ isVSCode: true });
  useTerminalSessionKeepalive();

  return (
    <>
      <div ref={containerRef} className="h-full w-full bg-background text-foreground flex flex-col">
      {viewMode === 'editor' ? (
        <div className="flex flex-col h-full">
          <VSCodeHeader
            title={activeSessionTitle || t('vscodeLayout.title.chat')}
            showWorkStatus
            showContextUsage
            enableSessionSwitcher
          />
          <VSCodeChatArea active={!runOverviewKey} />
        </div>
      ) : usesExpandedLayout ? (
        <div className="flex h-full">
          {sessionsSidebarOpen ? (
            <div
              className={cn('relative h-full border-e border-border overflow-hidden flex-shrink-0', sidebarResize.isResizing && 'select-none')}
              style={{ width: sidebarResize.width, minWidth: sidebarResize.width, maxWidth: sidebarResize.width }}
            >
              <SessionSidebar
                mobileVariant
                allowReselect
                hideDirectoryControls
              />
              <div
                className={cn(
                  'absolute inset-e-0 top-0 z-20 h-full w-[3px] cursor-col-resize transition-colors hover:bg-[var(--interactive-border)]/80',
                  sidebarResize.isResizing && 'bg-[var(--interactive-border)]'
                )}
                ref={sidebarResize.handleRef}
                onPointerDown={sidebarResize.onPointerDown}
                onPointerMove={sidebarResize.onPointerMove}
                onPointerUp={sidebarResize.onPointerEnd}
                onPointerCancel={sidebarResize.onPointerEnd}
                onLostPointerCapture={sidebarResize.onPointerEnd}
                role="separator"
                aria-orientation="vertical"
                aria-label={t('vscodeLayout.actions.resizeSessionsSidebarAria')}
              />
            </div>
          ) : null}
          <div className="flex-1 flex flex-col min-w-0">
            <VSCodeHeader
              title={chatTitle}
              sessionsSidebarOpen={sessionsSidebarOpen}
              onToggleSessionsSidebar={toggleSessionsSidebar}
              showArchiveToggle
              showWorkStatus
              showContextUsage
              enableSessionSwitcher
            />
            <VSCodeChatArea active={currentView === 'chat' && !runOverviewKey} />
          </div>
        </div>
      ) : (
        <>
          {currentView === 'sessions' ? (
            <div className="flex flex-col h-full">
              <VSCodeHeader
                title={t('vscodeLayout.title.sessions')}
                onArchiveAll={handleArchiveAll}
                borderless
              />
              <div className="flex-1 overflow-hidden">
                <SessionSidebar
                  mobileVariant
                  allowReselect
                  onSessionSelected={handleSessionSelected}
                  hideDirectoryControls
                />
              </div>
            </div>
          ) : null}
          <div className={cn('flex flex-col h-full', currentView !== 'chat' && 'hidden')}>
            <VSCodeHeader
              title={chatTitle}
              hidden={currentView !== 'chat'}
              showBack
              onBack={handleBackToSessions}
              showWorkStatus
              showContextUsage
              enableSessionSwitcher
            />
            <VSCodeChatArea active={currentView === 'chat' && !runOverviewKey} />
          </div>
        </>
      )}
      <SessionDialogs />
      <RunAutoFusion />
      </div>
    </>
  );
};

const VSCodeChatArea: React.FC<{ active: boolean }> = ({ active }) => {
  const runOverviewOpen = useUIStore((state) => state.runOverviewKey !== null);
  const reserved = useRightSlotStore((state) => state.workStatusReserved);
  const layoutAnimationMs = useLayoutAnimationMs();
  React.useEffect(() => {
    setChatCovered(runOverviewOpen);
    return () => setChatCovered(false);
  }, [runOverviewOpen]);
  const column = reserved && !runOverviewOpen;
  const columnRef = React.useRef(column);
  React.useLayoutEffect(() => {
    if (columnRef.current === column) return;
    columnRef.current = column;
    beginLayoutAnimation(layoutAnimationMs);
  }, [column, layoutAnimationMs]);

  return (
    <div className="relative flex min-h-0 flex-1 overflow-hidden" data-chat-area="true">
      <div className="relative min-w-0 flex-1 overflow-hidden">
        <ErrorBoundary>
          <ChatView active={active} />
        </ErrorBoundary>
        <ErrorBoundary><RunOverview /></ErrorBoundary>
      </div>
      <div
        className="relative h-full shrink-0 overflow-clip transition-[width] motion-reduce:transition-none"
        style={{
          width: column ? WORK_STATUS_COLUMN_WIDTH : 0,
          transitionDuration: `${layoutAnimationMs}ms`,
          transitionTimingFunction: LAYOUT_ANIMATION_EASING,
        }}
      >
        <div ref={setWorkStatusHost} className={cn('absolute inset-y-0 inset-e-0 flex', runOverviewOpen && 'invisible')} />
      </div>
    </div>
  );
};

interface VSCodeHeaderProps {
  title: string;
  showBack?: boolean;
  onBack?: () => void;
  onArchiveAll?: () => void;
  showArchiveToggle?: boolean;
  onNewSession?: () => void;
  onSettings?: () => void;
  showWorkStatus?: boolean;
  sessionsSidebarOpen?: boolean;
  onToggleSessionsSidebar?: () => void;
  showContextUsage?: boolean;
  enableSessionSwitcher?: boolean;
  hidden?: boolean;
  borderless?: boolean;
}


const VSCodeHeader: React.FC<VSCodeHeaderProps> = ({ title, showBack, onBack, onArchiveAll, showArchiveToggle = Boolean(onArchiveAll), onNewSession, onSettings, showWorkStatus, sessionsSidebarOpen = false, onToggleSessionsSidebar, showContextUsage, enableSessionSwitcher, hidden = false, borderless }) => {
  const { t } = useI18n();
  const showArchivedSessions = useSessionDisplayStore((state) => state.showArchivedSessions);
  const toggleArchivedSessions = useSessionDisplayStore((state) => state.toggleArchivedSessions);
  const currentSessionId = useSessionUIStore((state) => state.currentSessionId);
  const activeProjectId = useProjectsStore((state) => state.activeProjectId);
  const { totalCost: sessionTotalCost } = useSubagentCostRollup(currentSessionId ?? null);
  const currentSessionMessages = useSessionMessages(currentSessionId ?? '');
  const currentSessionMessagesResolved = useSessionMessagesResolved(currentSessionId ?? '');
  const workStatusPanelEnabled = useUIStore((state) => state.workStatusPanelEnabled);
  const setWorkStatusPanelEnabled = useUIStore((state) => state.setWorkStatusPanelEnabled);
  const workStatusPanelFits = useUIStore((state) => state.workStatusPanelFits);
  const workStatusOverlayOpen = useUIStore((state) => state.workStatusOverlayOpen);
  const setWorkStatusOverlayOpen = useUIStore((state) => state.setWorkStatusOverlayOpen);
  const workStatusOverlayForm = workStatusPanelEnabled && !workStatusPanelFits;
  const workStatusToggleActive = workStatusOverlayForm ? workStatusOverlayOpen : workStatusPanelEnabled;
  const handleWorkStatusToggle = () => {
    if (workStatusOverlayForm) setWorkStatusOverlayOpen(!workStatusOverlayOpen);
    else setWorkStatusPanelEnabled(!workStatusPanelEnabled);
  };
  const workStatusToggleTitle = workStatusToggleActive
    ? t('header.workStatusPanel.hide')
    : t(workStatusOverlayForm ? 'header.workStatusPanel.showOverlay' : 'header.workStatusPanel.show');

  const updateSessionTitle = useSessionUIStore((state) => state.updateSessionTitle);
  const sessionTitle = useDirectorySync(
    React.useCallback((state) => (
      currentSessionId ? state.session.find((session) => session.id === currentSessionId)?.title ?? null : null
    ), [currentSessionId]),
  );
  const [renamingSessionId, setRenamingSessionId] = React.useState<string | null>(null);
  const [titleDraft, setTitleDraft] = React.useState('');
  const renameRequestedRef = React.useRef(false);
  const renameFormRef = React.useRef<HTMLFormElement | null>(null);
  const isRenaming = renamingSessionId !== null && renamingSessionId === currentSessionId;

  React.useEffect(() => {
    setRenamingSessionId(null);
  }, [currentSessionId]);

  const beginRename = () => {
    if (!currentSessionId) return;
    setTitleDraft(sessionTitle?.trim() || title);
    setRenamingSessionId(currentSessionId);
  };

  useKeybinds({
    rename_current_session: () => {
      if (!enableSessionSwitcher || hidden || !currentSessionId) return false;
      beginRename();
    },
  });

  const focusRenameInput = React.useCallback((node: HTMLInputElement | null) => {
    node?.focus();
    node?.select();
  }, []);

  const saveRename = React.useCallback(async () => {
    if (!renamingSessionId) return;
    const nextTitle = titleDraft.trim();
    setRenamingSessionId(null);
    if (!nextTitle || nextTitle === sessionTitle?.trim()) return;
    try {
      await updateSessionTitle(renamingSessionId, nextTitle);
    } catch (error) {
      console.error('[vscode-header] rename failed', error);
      toast.error(t('sessions.sidebar.session.rename.error', {
        detail: describeSessionActionError(error instanceof Error ? error : new Error(String(error)), t),
      }));
    }
  }, [renamingSessionId, sessionTitle, t, titleDraft, updateSessionTitle]);

  React.useEffect(() => {
    if (!isRenaming) return;
    const handleDocumentMouseDown = (event: MouseEvent) => {
      if (!(event.target instanceof Node) || !renameFormRef.current?.contains(event.target)) void saveRename();
    };
    document.addEventListener('mousedown', handleDocumentMouseDown);
    return () => document.removeEventListener('mousedown', handleDocumentMouseDown);
  }, [isRenaming, saveRename]);

  const { context: contextLimit, output: outputLimit } = useContextWindowLimits(currentSessionId ?? null);

  const contextUsage = React.useMemo<SessionContextUsage | null>(() => (
    currentSessionId ? buildSessionContextUsage(currentSessionMessages, contextLimit, outputLimit) : null
  ), [contextLimit, currentSessionId, currentSessionMessages, outputLimit]);
  const [stableContextUsage, setStableContextUsage] = React.useState<SessionContextUsage | null>(null);
  const isContextUsageResolvedForSession = !currentSessionId || currentSessionMessagesResolved;

  React.useEffect(() => {
    if (!currentSessionId) {
      setStableContextUsage((prev) => (prev === null ? prev : null));
      return;
    }

    if (contextUsage) {
      setStableContextUsage((prev) => (isSameContextUsage(prev, contextUsage) ? prev : contextUsage));
      return;
    }

    if (isContextUsageResolvedForSession) {
      setStableContextUsage((prev) => (prev === null ? prev : null));
    }
  }, [contextUsage, currentSessionId, isContextUsageResolvedForSession]);

  return (
    <div className={cn('flex items-center gap-1.5 ps-3 pe-2 py-1 bg-background shrink-0', !borderless && 'border-b border-border')}>
      {showBack && onBack && (
        <button
          onClick={onBack}
          className="inline-flex h-7 w-7 items-center justify-center text-muted-foreground hover:text-foreground transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
          aria-label={t('vscodeLayout.actions.backToSessionsAria')}
        >
          <Icon name="arrow-left" className="h-5 w-5" />
        </button>
      )}
      {onToggleSessionsSidebar && (
        <button
          type="button"
          onClick={onToggleSessionsSidebar}
          className={cn(
            '-ms-1 inline-flex h-7 w-7 shrink-0 items-center justify-center rounded-md transition-colors hover:bg-interactive-hover/60 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring',
            sessionsSidebarOpen ? 'text-foreground' : 'text-muted-foreground hover:text-foreground',
          )}
          aria-label={t(sessionsSidebarOpen ? 'vscodeLayout.actions.hideSessionsAria' : 'vscodeLayout.actions.showSessionsAria')}
          aria-pressed={sessionsSidebarOpen}
          title={t(sessionsSidebarOpen ? 'vscodeLayout.actions.hideSessionsAria' : 'vscodeLayout.actions.showSessionsAria')}
        >
          <Icon name="panel-left" className="h-4 w-4" />
        </button>
      )}
      {isRenaming ? (
        <form
          ref={renameFormRef}
          data-session-rename-form="vscode-header"
          className="flex min-w-0 flex-1 items-center gap-2 px-1"
          onSubmit={(event) => {
            event.preventDefault();
            void saveRename();
          }}
        >
          <input
            ref={focusRenameInput}
            value={titleDraft}
            onChange={(event) => setTitleDraft(event.target.value)}
            onKeyDown={(event) => handleSessionRenameKeyDown(event, () => setRenamingSessionId(null))}
            placeholder={t('sessions.sidebar.session.menu.rename')}
            className="min-w-0 flex-1 bg-transparent text-sm font-medium outline-none placeholder:text-muted-foreground"
          />
          <button
            type="submit"
            aria-label={t('sessions.sidebar.session.rename.save')}
            title={t('sessions.sidebar.session.rename.save')}
            className="shrink-0 text-muted-foreground hover:text-foreground"
          >
            <Icon name="check" className="size-4" />
          </button>
          <button
            type="button"
            onClick={() => setRenamingSessionId(null)}
            aria-label={t('sessions.sidebar.session.rename.cancel')}
            title={t('sessions.sidebar.session.rename.cancel')}
            className="shrink-0 text-muted-foreground hover:text-foreground"
          >
            <Icon name="close" className="size-4" />
          </button>
        </form>
      ) : enableSessionSwitcher ? (
        <>
          <SessionSwitcherDropdown variant="compact" scopeProjectId={activeProjectId}>
            <button
              type="button"
              aria-label={t('sessions.switcher.openAria')}
              className="inline-flex min-w-0 max-w-full items-center rounded-md px-1 py-0.5 -my-0.5 text-start transition-colors hover:bg-interactive-hover/60 focus-visible:outline-none focus-visible:bg-interactive-hover/60"
            >
              <span dir="auto" className="oc-ui-start-align text-sm font-medium truncate" title={title}>{title}</span>
            </button>
          </SessionSwitcherDropdown>
          {currentSessionId ? (
            <DropdownMenu
              onOpenChangeComplete={(open) => {
                if (!open && renameRequestedRef.current) {
                  renameRequestedRef.current = false;
                  beginRename();
                }
              }}
            >
              <DropdownMenuTrigger asChild>
                <Button variant="ghost" size="xs" className="w-6 shrink-0 px-0 text-muted-foreground hover:bg-transparent hover:text-foreground" aria-label={t('header.sessionActions.openAria')}>
                  <Icon name="more" className="size-4" />
                </Button>
              </DropdownMenuTrigger>
              <DropdownMenuContent align="start">
                <DropdownMenuItem onClick={() => { renameRequestedRef.current = true; }}>
                  <Icon name="pencil-ai" className="me-1 h-4 w-4" />
                  {t('sessions.sidebar.session.menu.rename')}
                </DropdownMenuItem>
              </DropdownMenuContent>
            </DropdownMenu>
          ) : null}
        </>
      ) : (
        <SessionsTabTitle title={title} />
      )}
      {isRenaming ? null : <div className="min-w-0 flex-1" />}
      {showArchiveToggle && (
        <button
          type="button"
          onClick={toggleArchivedSessions}
          className={cn(
            'inline-flex h-8 w-8 items-center justify-center p-2 transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring',
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
          className="inline-flex h-9 w-9 items-center justify-center p-2 text-muted-foreground hover:text-foreground transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
          aria-label={t('vscodeLayout.actions.newSessionAria')}
        >
          <Icon name="add" className="h-5 w-5" />
        </button>
      )}
      {showWorkStatus && (
        <button
          type="button"
          data-work-status-toggle="true"
          onClick={handleWorkStatusToggle}
          className={cn(
            'inline-flex h-7 w-7 items-center justify-center rounded-md transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring',
            workStatusToggleActive
              ? 'oc-selected text-interactive-selection-foreground'
              : 'text-muted-foreground hover:bg-interactive-hover/60 hover:text-foreground',
          )}
          aria-label={t('header.workStatusPanel.toggleAria')}
          aria-pressed={workStatusToggleActive}
          title={workStatusToggleTitle}
        >
          <Icon name="panel-card" className="h-4 w-4" />
        </button>
      )}
      {onSettings && (
        <button
          onClick={onSettings}
          className="inline-flex h-9 w-9 items-center justify-center p-2 text-muted-foreground hover:text-foreground transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
          aria-label={t('vscodeLayout.actions.settingsAria')}
        >
          <Icon name="settings-3" className="h-5 w-5" />
        </button>
      )}
      {showContextUsage && stableContextUsage && (
        <ContextUsageDisplay
          reading={toContextUsageReading(stableContextUsage)}
          contextLimit={stableContextUsage.contextLimit}
          outputLimit={stableContextUsage.outputLimit ?? 0}
          cost={(sessionTotalCost ?? 0) > 0 ? sessionTotalCost : null}
          className="h-9 shrink-0 ps-1 pe-1 typography-ui-label"
          valueClassName="font-semibold leading-none"
          hideIcon
          showPercentIcon
          percentIconClassName="h-4.5 w-4.5"
        />
      )}
    </div>
  );
};
