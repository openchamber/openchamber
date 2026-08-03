import React from 'react';

import { McpIcon } from '@/components/icons/McpIcon';
import { McpDropdownContent } from '@/components/mcp/McpDropdown';
import { AboutSettings } from '@/components/sections/openchamber/AboutSettings';
import { OpenCodeUpdateToast } from '@/components/update/OpenCodeUpdateToast';
import { MobileAppUpdateToast } from '@/components/update/MobileAppUpdateToast';
import { ConfigUpdateOverlay } from '@/components/ui/ConfigUpdateOverlay';
import { Button } from '@/components/ui/button';
import { Icon } from '@/components/icon/Icon';
import { OpenChamberLogo } from '@/components/ui/OpenChamberLogo';
import { ChatView } from '@/components/views/ChatView';
import { PlanView } from '@/components/views/PlanView';
import { SettingsView } from '@/components/views/SettingsView';
import { TerminalView } from '@/components/views/TerminalView';
import { ErrorBoundary } from '@/components/ui/ErrorBoundary';
import { RuntimeAPIProvider } from '@/contexts/RuntimeAPIProvider';
import { registerRuntimeAPIs } from '@/contexts/runtimeAPIRegistry';
import { TooltipProvider } from '@/components/ui/tooltip';
import { Toaster } from '@/components/ui/sonner';
import { usePushVisibilityBeacon } from '@/hooks/usePushVisibilityBeacon';
import { useRouter } from '@/hooks/useRouter';
import { useUpdatePolling } from '@/hooks/useUpdatePolling';
import { useWindowTitle } from '@/hooks/useWindowTitle';
import { opencodeClient } from '@/lib/opencode/client';
import type { RuntimeAPIs } from '@/lib/api/types';
import { useOrientation } from '@/lib/device';
import { useI18n } from '@/lib/i18n';
import { isIPadApp } from '@/lib/platform';
import { runtimeFetch } from '@/lib/runtime-fetch';
import { getRuntimeApiBaseUrl, getRuntimeKey, subscribeRuntimeEndpointChanged, switchRuntimeEndpoint } from '@/lib/runtime-switch';
import { refreshGlobalSessions, resolveGlobalSessionDirectory } from '@/stores/useGlobalSessionsStore';
import { clearLastActiveSession, readLastActiveSession } from '@/sync/last-session-cache';
import { cn } from '@/lib/utils';
import { useConfigStore } from '@/stores/useConfigStore';
import { useDirectoryStore } from '@/stores/useDirectoryStore';
import { useFeatureFlagsStore } from '@/stores/useFeatureFlagsStore';
import { useGitHubAuthStore } from '@/stores/useGitHubAuthStore';
import { useGitStatus, useGitStore } from '@/stores/useGitStore';
import { useMcpConfigStore, type McpDraft } from '@/stores/useMcpConfigStore';
import { useMcpStore } from '@/stores/useMcpStore';
import { useProjectsStore } from '@/stores/useProjectsStore';
import {
  listProjectWorktrees,
  partitionWorktreesByRegisteredProject,
  worktreeMapsEqual,
} from '@/lib/worktrees/worktreeManager';
import { useUIStore } from '@/stores/useUIStore';
import { useUpdateStore } from '@/stores/useUpdateStore';
import { useSessionUIStore } from '@/sync/session-ui-store';
import { SyncProvider } from '@/sync/sync-context';

import { SyncAppEffects } from './AppEffects';
import { ProjectContextPanel } from '@/components/layout/RightSidebarTabs';
import { MobileChangesSurface } from './MobileChangesSurface';
import { MobileFilesSurface } from './MobileFilesSurface';
import { BusyDots } from '@/components/chat/message/parts/BusyDots';
import { MobileConnectionWelcome, type MobileConnectionNotice } from './MobileConnectionWelcome';
import { MobileHeader } from './MobileHeader';
import { MobileInstancesSurface } from './MobileInstancesSurface';
import { MobileOverflowMenu, type OverflowItem } from './MobileOverflowMenu';
import { MobileSessionsSheet } from './MobileSessionsSheet';
import { MobileFullscreenSurface } from './MobileFullscreenSurface';
import { MobileWorkspaceDrawer, type MobileWorkspaceTab } from './MobileWorkspaceDrawer';
import { DedicatedMobileAppProvider, type MobileAppActions } from './mobileAppContext';
import { autoConnectLastInstance, getAutoConnectTargetLabel, reprobeActiveConnection, type AutoConnectOutcome } from './mobileConnections';
import { isCapacitorMobileApp, useNativeAndroidBackButton, useNativeMobileChrome, useNativeMobileLifecycle } from './mobileNativeChrome';
import { normalizePath } from './mobilePaths';
import { reconnectAppForTransportSwitch, resetAppForRuntimeEndpointChange } from './runtimeEndpointReset';
import { useAppFontEffects } from './useAppFontEffects';
import { useFontsReady } from './useFontsReady';
import { useDeepLinkHandlers, useDeepLinkSource } from './deepLinkNavigation';
import { useEdgeSwipe } from './useEdgeSwipe';
import { useNativePushRegistration } from './useNativePushRegistration';
import { IpadSidebarResizeHandle } from './IpadSidebarResizeHandle';
import {
  IPAD_LEFT_SIDEBAR_WIDTH,
  IPAD_RIGHT_SIDEBAR_WIDTH,
  useIpadSidebarResize,
} from './ipadSidebarResize';

const MOBILE_SETTINGS_PAGES = [
  'general',
  'appearance',
  'chat',
  'notifications',
  'sessions',
  'git',
  'magic-prompts',
  'behavior',
  'mcp',
  'harness',
  'providers',
  'usage',
  'voice',
  'about',
] as const;

type MobileAppProps = {
  apis: RuntimeAPIs;
};

const NATIVE_RESUME_SYNC_EVENT_THROTTLE_MS = 1_000;

/** The fullscreen overlay surfaces reachable from the overflow menu. Exactly
    one can be open at a time — opening another replaces it, closing returns
    to the chat. The sessions drawer, the workspace drawer (Changes / Files /
    Terminal tabs on phones), and the overflow menu are separate layers.
    'terminal' is iPad-only here — phones get it as a workspace tab. */
type MobileSurface = 'terminal' | 'mcp' | 'notes' | 'instances' | 'settings' | 'update';

const MobileShell: React.FC<{ onActiveConnectionDeleted: () => void }> = ({ onActiveConnectionDeleted }) => {
  const { t } = useI18n();
  const [sessionsSheetOpen, setSessionsSheetOpen] = React.useState(false);
  const [activeSurface, setActiveSurface] = React.useState<MobileSurface | null>(null);
  // Phone right drawer with the workspace tabs; the tab persists across
  // open/close so the right-edge swipe reopens where the user left off.
  const [workspaceOpen, setWorkspaceOpen] = React.useState(false);
  const [workspaceTab, setWorkspaceTab] = React.useState<MobileWorkspaceTab>('changes');
  const [isMcpRefreshing, setIsMcpRefreshing] = React.useState(false);
  // A plan opened from the Project notes surface, shown as a second fullscreen
  // layer on top of it (back returns to the notes).
  const [openPlan, setOpenPlan] = React.useState<{ path: string; title: string } | null>(null);
  const [settingsInitialMobileStage, setSettingsInitialMobileStage] = React.useState<'nav' | 'page-content'>('nav');
  const [overflowOpen, setOverflowOpen] = React.useState(false);
  // When set, the Changes surface opens directly into the per-file diff for this path.
  const [pendingChangesDiff, setPendingChangesDiff] = React.useState<{ path: string; staged: boolean } | null>(null);
  const currentDirectory = useDirectoryStore((state) => state.currentDirectory);
  const setSettingsPage = useUIStore((state) => state.setSettingsPage);
  const updateAvailable = useUpdateStore((state) => state.available);
  const updateRuntimeType = useUpdateStore((state) => state.runtimeType);
  const showCapacitorOnlyFeatures = React.useMemo(() => isCapacitorMobileApp(), []);
  const mcpServers = useMcpConfigStore((state) => state.mcpServers);
  const setMcpDraft = useMcpConfigStore((state) => state.setMcpDraft);
  const setSelectedMcp = useMcpConfigStore((state) => state.setSelectedMcp);
  const refreshMcpStatus = useMcpStore((state) => state.refresh);
  const loadMcpConfigs = useMcpConfigStore((state) => state.loadMcpConfigs);
  const gitStatus = useGitStatus(normalizePath(currentDirectory) || null);
  const dirtyChangeCount = gitStatus?.files?.length ?? 0;

  // NOTE: pendingChangesDiff is intentionally NOT cleared on close — it keys
  // the persistent Changes pane in the workspace drawer, and clearing it would
  // remount the pane (losing its navigation) on every close.
  const closeSurface = React.useCallback(() => {
    setActiveSurface(null);
    setOpenPlan(null);
  }, []);

  const openSurface = React.useCallback((surface: MobileSurface) => {
    setActiveSurface(surface);
  }, []);

  const closeWorkspace = React.useCallback(() => {
    setWorkspaceOpen(false);
  }, []);

  const openSettingsSurface = React.useCallback((stage: 'nav' | 'page-content') => {
    setSettingsInitialMobileStage(stage);
    openSurface('settings');
  }, [openSurface]);

  // iPad (Capacitor): sessions live in a persistent full-height left sidebar
  // and Changes/Files in a right sidebar, instead of phone sheets/surfaces.
  const isIPad = React.useMemo(() => isIPadApp(), []);
  const orientation = useOrientation();
  const isPortrait = orientation === 'portrait';
  const [ipadSidebarOpen, setIpadSidebarOpen] = React.useState(isIPad && !isPortrait);
  const [ipadRightPanel, setIpadRightPanel] = React.useState<'files' | 'changes' | null>(null);

  const toggleIpadSidebar = React.useCallback(() => {
    const willOpen = !ipadSidebarOpen;
    // Portrait doesn't fit both side panels next to a usable chat column:
    // opening one closes the other (iPadOS behaves the same way).
    if (willOpen && isPortrait) setIpadRightPanel(null);
    setIpadSidebarOpen(willOpen);
  }, [ipadSidebarOpen, isPortrait]);

  const openFilesSurface = React.useCallback(() => {
    if (isIPad) {
      setPendingChangesDiff(null);
      setIpadRightPanel('files');
      if (isPortrait) setIpadSidebarOpen(false);
      return;
    }
    setWorkspaceTab('files');
    setWorkspaceOpen(true);
  }, [isIPad, isPortrait]);

  const openChangesSurface = React.useCallback((diff: { path: string; staged: boolean } | null = null) => {
    setPendingChangesDiff(diff);
    if (isIPad) {
      setIpadRightPanel('changes');
      if (isPortrait) setIpadSidebarOpen(false);
      return;
    }
    setWorkspaceTab('changes');
    setWorkspaceOpen(true);
  }, [isIPad, isPortrait]);

  const closeIpadRightPanel = React.useCallback(() => {
    setIpadRightPanel(null);
    setPendingChangesDiff(null);
  }, []);

  const toggleIpadRightPanel = React.useCallback((panel: 'files' | 'changes') => {
    if (ipadRightPanel === panel) {
      closeIpadRightPanel();
      return;
    }
    if (panel === 'files') openFilesSurface();
    else openChangesSurface();
  }, [closeIpadRightPanel, ipadRightPanel, openChangesSurface, openFilesSurface]);

  // Keep the right panel's content mounted through the width-collapse
  // animation; drop it once the panel is fully closed.
  const lastIpadRightPanelRef = React.useRef<'files' | 'changes'>('changes');
  if (ipadRightPanel) lastIpadRightPanelRef.current = ipadRightPanel;
  const [ipadRightContentMounted, setIpadRightContentMounted] = React.useState(false);
  React.useEffect(() => {
    if (!isIPad) return;
    if (ipadRightPanel) {
      setIpadRightContentMounted(true);
      return;
    }
    const id = window.setTimeout(() => setIpadRightContentMounted(false), 240);
    return () => window.clearTimeout(id);
  }, [ipadRightPanel, isIPad]);
  const renderedIpadRightPanel = ipadRightPanel ?? lastIpadRightPanelRef.current;

  const leftResize = useIpadSidebarResize('left', 'openchamber.ipad.leftSidebarWidth', IPAD_LEFT_SIDEBAR_WIDTH);
  const rightResize = useIpadSidebarResize('right', 'openchamber.ipad.rightSidebarWidth', IPAD_RIGHT_SIDEBAR_WIDTH);

  const mobileActions = React.useMemo<MobileAppActions>(
    () => ({
      openChanges: ({ diffPath, staged } = {}) => {
        openChangesSurface(diffPath ? { path: diffPath, staged: staged === true } : null);
      },
      openFiles: () => openFilesSurface(),
      openSettings: () => openSettingsSurface('nav'),
    }),
    [openChangesSurface, openFilesSurface, openSettingsSurface],
  );

  // Expose the shell's panel-opening actions to the deep-link layer so openchamber:// URLs
  // (and notification taps / widgets) can navigate to these surfaces. Session and
  // new-session intents resolve directly against the store, so they aren't wired here.
  const deepLinkHandlers = React.useMemo(
    () => ({
      openSessions: () => {
        if (isIPad) setIpadSidebarOpen(true);
        else setSessionsSheetOpen(true);
      },
      openView: (target: 'files' | 'mcp' | 'instances' | 'update') => {
        if (target === 'files') {
          openFilesSurface();
          return;
        }
        // Phones host MCP as a workspace tab now; iPad still uses the surface.
        if (target === 'mcp' && !isIPad) {
          setWorkspaceTab('mcp');
          setWorkspaceOpen(true);
          return;
        }
        openSurface(target);
      },
      openChanges: ({ path, staged }: { path?: string; staged?: boolean } = {}) => {
        openChangesSurface(path ? { path, staged: staged === true } : null);
      },
      openSettings: (section?: string) => {
        if (section) setSettingsPage(section as Parameters<typeof setSettingsPage>[0]);
        openSettingsSurface(section ? 'page-content' : 'nav');
      },
    }),
    [isIPad, openChangesSurface, openFilesSurface, openSettingsSurface, openSurface, setSettingsPage],
  );
  useDeepLinkHandlers(deepLinkHandlers);

  // Edge swipes on the chat: left edge opens the sessions drawer (the iPad
  // sidebar on iPad), right edge reopens the most recent overflow surface
  // (the last right panel on iPad).
  const chatMainRef = React.useRef<HTMLElement>(null);
  useEdgeSwipe(chatMainRef, {
    onLeftEdgeSwipe: () => {
      if (isIPad) setIpadSidebarOpen(true);
      else setSessionsSheetOpen(true);
    },
    onRightEdgeSwipe: () => {
      if (isIPad) {
        if (lastIpadRightPanelRef.current === 'files') openFilesSurface();
        else openChangesSurface();
        return;
      }
      setWorkspaceOpen(true);
    },
  });

  // Top-most layer first: a plan or fullscreen surface can now sit ABOVE a
  // drawer (opened from the drawer footer / workspace tabs), so they close
  // before the drawers underneath.
  const handleNativeBack = React.useCallback(() => {
    if (overflowOpen) {
      setOverflowOpen(false);
      return true;
    }
    if (openPlan) {
      setOpenPlan(null);
      return true;
    }
    if (activeSurface) {
      closeSurface();
      return true;
    }
    if (workspaceOpen) {
      closeWorkspace();
      return true;
    }
    if (sessionsSheetOpen) {
      setSessionsSheetOpen(false);
      return true;
    }
    return false;
  }, [activeSurface, closeSurface, closeWorkspace, openPlan, overflowOpen, sessionsSheetOpen, workspaceOpen]);

  useNativeAndroidBackButton(handleNativeBack);

  // Server updates are actionable from a browser (hosted mobile) but not from
  // the Capacitor shell — the native app updates through the store, and the
  // server it CONNECTS to is updated elsewhere.
  const showUpdateItem = !showCapacitorOnlyFeatures
    && updateAvailable
    && (updateRuntimeType === 'desktop' || updateRuntimeType === 'web');

  const openMcpCreateSettings = React.useCallback(() => {
    const baseName = 'new-mcp-server';
    let newName = baseName;
    let counter = 1;
    while (mcpServers.some((server) => server.name === newName)) {
      newName = `${baseName}-${counter}`;
      counter += 1;
    }

    const draft: McpDraft = {
      name: newName,
      scope: 'user',
      type: 'local',
      command: [],
      url: '',
      environment: [],
      headers: [],
      oauthEnabled: true,
      oauthClientId: '',
      oauthClientSecret: '',
      oauthScope: '',
      oauthRedirectUri: '',
      timeout: '',
      enabled: true,
    };

    setMcpDraft(draft);
    setSelectedMcp(newName);
    setSettingsPage('mcp');
    openSettingsSurface('page-content');
  }, [mcpServers, openSettingsSurface, setMcpDraft, setSelectedMcp, setSettingsPage]);

  const refreshMcpOverlay = React.useCallback(() => {
    if (isMcpRefreshing) return;
    setIsMcpRefreshing(true);
    const directory = currentDirectory || null;
    const minSpinPromise = new Promise((resolve) => window.setTimeout(resolve, 500));
    void Promise.all([
      refreshMcpStatus({ directory, silent: true }),
      loadMcpConfigs({ force: true }),
      minSpinPromise,
    ]).finally(() => setIsMcpRefreshing(false));
  }, [currentDirectory, isMcpRefreshing, loadMcpConfigs, refreshMcpStatus]);

  const overflowItems: OverflowItem[] = React.useMemo(
    () => {
      const items: OverflowItem[] = [];
      // Phones get Files/Changes/Terminal as workspace-drawer tabs; the iPad
      // exposes Files/Changes as header shortcuts and keeps Terminal here.
      if (isIPad) {
        items.push({
          key: 'terminal',
          icon: 'terminal',
          label: t('mobile.menu.terminal'),
          onSelect: () => openSurface('terminal'),
        });
      }
      items.push({
        key: 'mcp',
        iconNode: <McpIcon className="size-5 shrink-0 text-muted-foreground" />,
        label: t('mobile.menu.mcp'),
        onSelect: () => openSurface('mcp'),
      });
      items.push({
        key: 'notes',
        icon: 'sticky-note',
        label: t('contextRail.surface.notes'),
        onSelect: () => openSurface('notes'),
      });
      if (showCapacitorOnlyFeatures) {
        items.push({
          key: 'instances',
          icon: 'server',
          label: t('mobile.menu.instances'),
          onSelect: () => openSurface('instances'),
        });
      }
      if (showUpdateItem) {
        items.push({
          key: 'update',
          icon: 'download',
          label: t('mobile.menu.update'),
          onSelect: () => openSurface('update'),
        });
      }
      items.push({
        key: 'settings',
        icon: 'settings-3',
        label: t('mobile.menu.settings'),
        onSelect: () => openSettingsSurface('nav'),
      });
      return items;
    },
    [isIPad, openSettingsSurface, openSurface, showCapacitorOnlyFeatures, showUpdateItem, t],
  );

  return (
    <DedicatedMobileAppProvider actions={mobileActions}>
      <div
        className="oc-mobile-app-shell main-content-safe-area flex h-[100dvh] flex-row bg-background text-foreground"
        data-page-scroll-lock="true"
      >
        {/* iPad: persistent full-height sessions sidebar; the chat column and
            its header butt against it (iPadOS-style split layout). Always
            mounted so open/close animates width, same as the desktop Sidebar. */}
        {isIPad ? (
          <aside
            ref={leftResize.asideRef}
            className={cn(
              'relative flex h-full shrink-0 flex-col overflow-hidden border-r border-border/70 bg-sidebar will-change-[width] motion-reduce:transition-none',
              !ipadSidebarOpen && 'border-r-0',
            )}
            style={{
              width: ipadSidebarOpen ? leftResize.width : 0,
              minWidth: ipadSidebarOpen ? leftResize.width : 0,
              maxWidth: ipadSidebarOpen ? leftResize.width : 0,
              ['--oc-ipad-sidebar-width' as string]: `${leftResize.width}px`,
              overflowX: 'clip',
              paddingTop: 'var(--oc-safe-area-top, 0px)',
              transitionProperty: leftResize.isResizing ? 'none' : 'width, min-width, max-width',
              transitionDuration: '200ms',
              transitionTimingFunction: 'cubic-bezier(0.22, 1, 0.36, 1)',
            }}
            aria-hidden={!ipadSidebarOpen}
            data-page-scroll-lock="true"
          >
            {ipadSidebarOpen ? (
              <IpadSidebarResizeHandle
                side="left"
                isResizing={leftResize.isResizing}
                ariaLabel={t('sidebar.resize.leftPanelAria')}
                handleProps={leftResize.handleProps}
              />
            ) : null}
            <div
              className={cn(
                'flex h-full shrink-0 flex-col transition-opacity duration-200 ease-[cubic-bezier(0.22,1,0.36,1)] motion-reduce:transition-none',
                leftResize.isResizing && 'pointer-events-none',
                !ipadSidebarOpen && 'pointer-events-none select-none opacity-0',
              )}
              style={{ width: 'var(--oc-ipad-sidebar-width)', overflowX: 'hidden' }}
            >
              <ErrorBoundary>
                <MobileSessionsSheet
                  open
                  variant="sidebar"
                  // The surface asks to close after picking a session/project or
                  // creating a worktree; the persistent landscape sidebar stays
                  // put, portrait gives the space back to the chat.
                  onOpenChange={(value) => {
                    if (!value && isPortrait) setIpadSidebarOpen(false);
                  }}
                />
              </ErrorBoundary>
            </div>
          </aside>
        ) : null}

        <div className="flex h-full min-w-0 flex-1 flex-col" data-page-scroll-lock="true">
          <MobileHeader
            onOpenSessions={() => (isIPad ? toggleIpadSidebar() : setSessionsSheetOpen(true))}
            // Phones dropped the overflow menu: its items live in the sessions
            // drawer footer and the workspace tabs now. iPad keeps it until
            // the dedicated iPad layout pass.
            onOpenMenu={isIPad ? () => setOverflowOpen(true) : undefined}
            onOpenWorkspace={isIPad ? undefined : () => setWorkspaceOpen(true)}
            surfaceShortcuts={isIPad ? {
              activePanel: ipadRightPanel,
              changesDirty: dirtyChangeCount > 0,
              onToggleFiles: () => toggleIpadRightPanel('files'),
              onToggleChanges: () => toggleIpadRightPanel('changes'),
            } : undefined}
          />
          <main ref={chatMainRef} className="relative min-h-0 flex-1 overflow-hidden" data-page-scroll-lock="true">
            <div className="h-full w-full">
              <ErrorBoundary>
                <ChatView />
              </ErrorBoundary>
            </div>
          </main>
        </div>

        {/* iPad: Changes/Files live in a full-height right sidebar instead of
            the phone's fullscreen surfaces. Width animates like the desktop
            RightSidebar; content stays mounted through the collapse. */}
        {isIPad ? (
          <aside
            ref={rightResize.asideRef}
            className={cn(
              'relative flex h-full shrink-0 flex-col overflow-hidden border-l border-border/70 bg-background will-change-[width] motion-reduce:transition-none',
              !ipadRightPanel && 'border-l-0',
            )}
            style={{
              width: ipadRightPanel ? rightResize.width : 0,
              minWidth: ipadRightPanel ? rightResize.width : 0,
              maxWidth: ipadRightPanel ? rightResize.width : 0,
              ['--oc-ipad-sidebar-width' as string]: `${rightResize.width}px`,
              overflowX: 'clip',
              paddingTop: 'var(--oc-safe-area-top, 0px)',
              transitionProperty: rightResize.isResizing ? 'none' : 'width, min-width, max-width',
              transitionDuration: '200ms',
              transitionTimingFunction: 'cubic-bezier(0.22, 1, 0.36, 1)',
            }}
            aria-hidden={!ipadRightPanel}
            data-page-scroll-lock="true"
          >
            {ipadRightPanel ? (
              <IpadSidebarResizeHandle
                side="right"
                isResizing={rightResize.isResizing}
                ariaLabel={t('sidebar.resize.rightPanelAria')}
                handleProps={rightResize.handleProps}
              />
            ) : null}
            <div
              className={cn(
                'flex h-full shrink-0 flex-col transition-opacity duration-200 ease-[cubic-bezier(0.22,1,0.36,1)] motion-reduce:transition-none',
                rightResize.isResizing && 'pointer-events-none',
                !ipadRightPanel && 'pointer-events-none select-none opacity-0',
              )}
              style={{ width: 'var(--oc-ipad-sidebar-width)', overflowX: 'hidden' }}
            >
              {ipadRightContentMounted ? (
                <ErrorBoundary>
                  {renderedIpadRightPanel === 'files' ? (
                    <MobileFilesSurface onClose={closeIpadRightPanel} />
                  ) : (
                    <MobileChangesSurface
                      onClose={closeIpadRightPanel}
                      initialDiffPath={pendingChangesDiff?.path ?? null}
                      initialDiffStaged={pendingChangesDiff?.staged === true}
                    />
                  )}
                </ErrorBoundary>
              ) : null}
            </div>
          </aside>
        ) : null}

        {isIPad ? (
          <MobileOverflowMenu
            open={overflowOpen}
            onClose={() => setOverflowOpen(false)}
            items={overflowItems}
            rightOffset={ipadRightPanel ? rightResize.width : 0}
          />
        ) : null}

        {/* Mounted permanently on phones (parked off-screen while closed) so
            the sessions/worktree state stays warm and the drawer opens with
            data already on screen — see MobileSessionsDrawerContainer. */}
        {!isIPad ? (
          <MobileSessionsSheet
            open={sessionsSheetOpen}
            onOpenChange={setSessionsSheetOpen}
            footer={{
              instanceLabel: showCapacitorOnlyFeatures ? getAutoConnectTargetLabel() : null,
              onOpenInstances: showCapacitorOnlyFeatures ? () => openSurface('instances') : undefined,
              onOpenSettings: () => openSettingsSurface('nav'),
              onOpenUpdate: showUpdateItem ? () => openSurface('update') : undefined,
            }}
          />
        ) : null}

        {/* Mounted only while open (like the sessions sheet) so each surface
            computes its safe-area / fixed-position layout fresh on open. Keeping
            them always-mounted left a stale startup layout, which made the
            top-inset dimming appear only intermittently on iOS. */}
        {!isIPad ? (
          <MobileWorkspaceDrawer
            open={workspaceOpen}
            onClose={closeWorkspace}
            tab={workspaceTab}
            onTabChange={setWorkspaceTab}
            pendingChangesDiff={pendingChangesDiff}
            onOpenPlan={setOpenPlan}
            onOpenMcpSettings={openMcpCreateSettings}
          />
        ) : null}

        {activeSurface === 'terminal' ? (
          <MobileFullscreenSurface
            open
            onClose={closeSurface}
            ariaLabel={t('mobile.menu.terminal')}
            title={t('mobile.menu.terminal')}
            disableEscapeDismiss
          >
            <ErrorBoundary>
              <TerminalView visible />
            </ErrorBoundary>
          </MobileFullscreenSurface>
        ) : null}

        {activeSurface === 'mcp' ? (
          <MobileFullscreenSurface
            open
            onClose={closeSurface}
            ariaLabel={t('mcpDropdown.title')}
            title={t('mcpDropdown.title')}
            trailing={(
              <>
                <button
                  type="button"
                  className="flex size-10 items-center justify-center rounded-full text-muted-foreground transition-colors hover:bg-interactive-hover hover:text-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-primary"
                  onClick={openMcpCreateSettings}
                  aria-label={t('settings.mcp.sidebar.actions.addServerTitle')}
                  title={t('settings.mcp.sidebar.actions.addServerTitle')}
                  style={{ touchAction: 'manipulation' }}
                >
                  <Icon name="add" className="size-5" />
                </button>
                <button
                  type="button"
                  className="flex size-10 items-center justify-center rounded-full text-muted-foreground transition-colors hover:bg-interactive-hover hover:text-foreground disabled:opacity-60 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-primary"
                  onClick={refreshMcpOverlay}
                  disabled={isMcpRefreshing}
                  aria-label={t('mcpDropdown.actions.refreshAria')}
                  title={t('mcpDropdown.actions.refreshAria')}
                  style={{ touchAction: 'manipulation' }}
                >
                  <Icon name="refresh" className={cn('size-5', isMcpRefreshing && 'animate-spin')} />
                </button>
              </>
            )}
          >
            <ErrorBoundary>
              <McpDropdownContent
                active
                className="h-full"
                listClassName="max-h-none"
                hideHeader
                mobileListDensity
              />
            </ErrorBoundary>
          </MobileFullscreenSurface>
        ) : null}

        {activeSurface === 'notes' ? (
          <MobileFullscreenSurface
            open
            onClose={closeSurface}
            ariaLabel={t('contextRail.surface.notes')}
            title={t('contextRail.surface.notes')}
          >
            <ErrorBoundary>
              <ProjectContextPanel
                onActionComplete={closeSurface}
                onOpenPlan={setOpenPlan}
              />
            </ErrorBoundary>
          </MobileFullscreenSurface>
        ) : null}

        {/* Layered above whichever surface opened it — the notes fullscreen
            surface (iPad) or the workspace drawer's Notes tab (phones). */}
        {openPlan ? (
          <MobileFullscreenSurface
            open
            onClose={() => setOpenPlan(null)}
            ariaLabel={openPlan.title}
            title={openPlan.title}
          >
            <ErrorBoundary>
              <PlanView
                targetPath={openPlan.path}
                onNavigatedToChat={() => {
                  closeSurface();
                  closeWorkspace();
                }}
              />
            </ErrorBoundary>
          </MobileFullscreenSurface>
        ) : null}

        {activeSurface === 'instances' && showCapacitorOnlyFeatures ? (
          <MobileFullscreenSurface
            open
            onClose={closeSurface}
            ariaLabel={t('mobile.menu.instances')}
            title={t('mobile.menu.instances')}
          >
            <MobileInstancesSurface
              onConnect={closeSurface}
              onActiveConnectionDeleted={onActiveConnectionDeleted}
            />
          </MobileFullscreenSurface>
        ) : null}

        {activeSurface === 'settings' ? (
          <MobileFullscreenSurface
            open
            onClose={closeSurface}
            ariaLabel={t('mobile.menu.settings')}
            headerless
          >
            <ErrorBoundary>
              <SettingsView
                forceMobile
                isWindowed
                initialMobileStage={settingsInitialMobileStage}
                // About exists for server updates — meaningful in a browser
                // (hosted mobile), not in the Capacitor shell (store updates).
                visiblePageSlugs={MOBILE_SETTINGS_PAGES.filter(
                  (page) => !(showCapacitorOnlyFeatures && page === 'about'),
                )}
                onClose={closeSurface}
              />
            </ErrorBoundary>
          </MobileFullscreenSurface>
        ) : null}

        {activeSurface === 'update' ? (
          <MobileFullscreenSurface
            open
            onClose={closeSurface}
            ariaLabel={t('mobile.menu.update')}
            title={t('mobile.menu.update')}
          >
            <ErrorBoundary>
              <div className="h-full overflow-auto px-5 py-4">
                <AboutSettings initialUpdateDialogOpen />
              </div>
            </ErrorBoundary>
          </MobileFullscreenSurface>
        ) : null}
      </div>
    </DedicatedMobileAppProvider>
  );
};

export function MobileApp({ apis }: MobileAppProps) {
  const { t } = useI18n();
  const initializeApp = useConfigStore((state) => state.initializeApp);
  const isInitialized = useConfigStore((state) => state.isInitialized);
  const isConnected = useConfigStore((state) => state.isConnected);
  const connectionPhase = useConfigStore((state) => state.connectionPhase);
  const providersCount = useConfigStore((state) => state.providers.length);
  const agentsCount = useConfigStore((state) => state.agents.length);
  const loadProviders = useConfigStore((state) => state.loadProviders);
  const loadAgents = useConfigStore((state) => state.loadAgents);
  const currentDirectory = useDirectoryStore((state) => state.currentDirectory);
  const error = useSessionUIStore((state) => state.error);
  const clearError = useSessionUIStore((state) => state.clearError);
  const setIsMobile = useUIStore((state) => state.setIsMobile);
  const refreshGitHubAuthStatus = useGitHubAuthStore((state) => state.refreshStatus);
  const setPlanModeEnabled = useFeatureFlagsStore((state) => state.setPlanModeEnabled);
  const projects = useProjectsStore((state) => state.projects);
  const [connectionEpoch, setConnectionEpoch] = React.useState(0);
  const [runtimeEndpointEpoch, setRuntimeEndpointEpoch] = React.useState(0);
  const [showConnectionRecovery, setShowConnectionRecovery] = React.useState(false);
  // Cold-launch auto-connect to the last instance: 'pending'/'attempting' hold the
  // splash so we don't flash the connect screen; 'done' means we either connected or
  // exhausted the attempt (then the connect screen shows).
  const [autoConnectPhase, setAutoConnectPhase] = React.useState<'pending' | 'attempting' | 'done'>('pending');
  // Why the cold-launch auto-connect fell through to the connect screen.
  const [autoConnectNotice, setAutoConnectNotice] = React.useState<MobileConnectionNotice | null>(null);
  // The instance the splash says we are connecting to. Read once on mount —
  // auto-connect targets the most-recent saved connection from the same list.
  const autoConnectLabel = React.useMemo(() => getAutoConnectTargetLabel(), []);
  // Bumped to force a re-render (and thus a fresh `sdk` prop for SyncProvider)
  // after a same-device transport swap — reconnects the sync layer in place with
  // no remount. The value itself is unused; only the re-render matters.
  const [, bumpTransportSwitch] = React.useReducer((count: number) => count + 1, 0);
  const isNativeMobileApp = React.useMemo(() => isCapacitorMobileApp(), []);
  const lastNativeResumeSyncEventAtRef = React.useRef(0);
  const nativeResumeValidationSeqRef = React.useRef(0);

  const handleNativeResume = React.useCallback(() => {
    const apiBaseUrl = getRuntimeApiBaseUrl();
    const validationSeq = nativeResumeValidationSeqRef.current + 1;
    nativeResumeValidationSeqRef.current = validationSeq;

    if (!apiBaseUrl) {
      // Already disconnected — e.g. a previous re-probe ran mid network flux
      // (Android Wi-Fi switch with no cellular fallback) and found nothing
      // reachable. When a resume/online signal arrives, silently retry the last
      // saved instance instead of dead-ending on the connect screen until the
      // user restarts the app. Success fires runtime-endpoint-changed, which
      // re-bootstraps everything.
      void autoConnectLastInstance();
      return;
    }

    // Re-probe the active device's transports on resume: the network may have
    // changed while the app slept, so hot-switch LAN⇄relay if a better transport
    // is now reachable — no re-pairing. A 'switched' outcome already fired the
    // runtime-endpoint-changed subscription (which re-bootstraps the app), so we
    // only refresh in place when the transport is 'unchanged'.
    const refreshInPlace = () => {
      void initializeApp();
      void refreshGitHubAuthStatus(apis.github, { force: true });
      if (providersCount === 0) void loadProviders({ source: 'mobileApp:nativeResume' });
      if (agentsCount === 0) void loadAgents({ source: 'mobileApp:nativeResume' });
    };
    const disconnect = () => {
      switchRuntimeEndpoint({ apiBaseUrl: '', clientToken: null, runtimeKey: 'mobile-disconnected' });
      setConnectionEpoch((value) => value + 1);
    };

    void reprobeActiveConnection().then((outcome) => {
      if (nativeResumeValidationSeqRef.current !== validationSeq) return;
      if (outcome === 'no-connection') {
        disconnect();
        return;
      }
      if (outcome === 'needs-login') {
        // Token explicitly rejected (revoked/expired) — tell the user why they
        // land back on the connect screen instead of silently bouncing them.
        setAutoConnectNotice({ kind: 'auth-expired', label: getAutoConnectTargetLabel() ?? '' });
        disconnect();
        return;
      }
      if (outcome === 'unreachable') {
        // Right after a resume or Wi-Fi switch the network is often still
        // settling (on Android without a SIM there is NO connectivity at all for
        // a few seconds), so a single fast probe races the network coming up.
        // Retry once after a grace period before tearing the connection down.
        window.setTimeout(() => {
          if (nativeResumeValidationSeqRef.current !== validationSeq) return;
          void reprobeActiveConnection().then((retry) => {
            if (nativeResumeValidationSeqRef.current !== validationSeq) return;
            if (retry === 'switched') return;
            if (retry === 'unchanged') {
              refreshInPlace();
              return;
            }
            if (retry === 'needs-login') {
              setAutoConnectNotice({ kind: 'auth-expired', label: getAutoConnectTargetLabel() ?? '' });
            }
            disconnect();
          });
        }, 4000);
        return;
      }
      if (outcome === 'switched') return;

      refreshInPlace();
    });

    const now = Date.now();
    if (now - lastNativeResumeSyncEventAtRef.current >= NATIVE_RESUME_SYNC_EVENT_THROTTLE_MS) {
      lastNativeResumeSyncEventAtRef.current = now;
      window.dispatchEvent(new Event('openchamber:system-resume'));
    }
  }, [agentsCount, apis.github, initializeApp, loadAgents, loadProviders, providersCount, refreshGitHubAuthStatus]);

  useNativeMobileChrome();
  useNativeMobileLifecycle(handleNativeResume);

  // Network-change re-probe. The resume hook only fires on background→foreground,
  // but on Android switching Wi-Fi (quick-settings tile) does NOT background the
  // app — no visibility/appState event ever fires, so the app would sit on a dead
  // LAN transport instead of hot-switching to relay. The webview's `online` event
  // fires on connectivity changes (new Wi-Fi, cellular back, airplane off), so
  // run the same re-probe then. Debounced: the first seconds after `online` the
  // route is often not usable yet, and rapid offline/online flaps must collapse
  // into one probe. iOS also gets this (harmless — same seq-guarded operation the
  // resume path runs; a concurrent duplicate supersedes via the seq ref).
  React.useEffect(() => {
    if (!isNativeMobileApp) return;
    let timer: number | undefined;
    const handleOnline = () => {
      window.clearTimeout(timer);
      timer = window.setTimeout(() => handleNativeResume(), 1500);
    };
    window.addEventListener('online', handleOnline);
    return () => {
      window.removeEventListener('online', handleOnline);
      window.clearTimeout(timer);
    };
  }, [isNativeMobileApp, handleNativeResume]);

  React.useEffect(() => {
    registerRuntimeAPIs(apis);
    return () => registerRuntimeAPIs(null);
  }, [apis]);

  // Switching instances (or disconnecting) only changes the runtime endpoint; the
  // stores still hold the previous instance's data. Mirror the web App.tsx reset
  // sequence so the UI fully re-bootstraps against the new server instead of going
  // stale. The SyncProvider is keyed by runtimeEndpointEpoch so it remounts too.
  React.useEffect(() => {
    return subscribeRuntimeEndpointChanged((detail) => {
      // A LAN⇄relay swap for the SAME device keeps the runtime key stable. Treat
      // that as a transport-only change: rebind the sync layer to the new
      // transport but keep the user's session/connection state — no reconnecting
      // screen, no bounce back to the draft. Only a real instance switch (key
      // change) does the full reset.
      const sameDevice = Boolean(detail.runtimeKey) && detail.runtimeKey === detail.previousRuntimeKey;
      if (sameDevice) {
        // Transport-only swap for the same device: rebind the SDK to the new
        // transport and force a re-render so SyncProvider receives the new `sdk`
        // prop. Its event-pipeline + bootstrap effects (keyed on `sdk`) then
        // reconnect over the new transport WITHOUT remounting — so the message
        // pagination refs, the open session, and the whole view are preserved.
        // No key bump, no flash, no bounce to the draft.
        reconnectAppForTransportSwitch();
        bumpTransportSwitch();
        return;
      }
      resetAppForRuntimeEndpointChange(detail);
      setRuntimeEndpointEpoch((epoch) => epoch + 1);
      setConnectionEpoch((epoch) => epoch + 1);
    });
  }, []);

  // On cold launch, silently reconnect to the most-recent saved instance so a
  // returning user — and notification deep-links — land in the app instead of the
  // connect screen. The splash is held while we try (see render below). If there's
  // no saved instance, it's unreachable, or it needs a (re)login, we fall through
  // to the connect screen. A successful switchRuntimeEndpoint fires the endpoint-
  // changed subscription above, which bumps the epochs and bootstraps the app.
  React.useEffect(() => {
    if (!isNativeMobileApp || isConnected || getRuntimeApiBaseUrl()) {
      setAutoConnectPhase('done');
      return;
    }
    let cancelled = false;
    setAutoConnectPhase('attempting');
    void autoConnectLastInstance()
      .catch((): AutoConnectOutcome => ({ status: 'no-candidate' }))
      .then((outcome) => {
        if (cancelled) return;
        // Landing on the connect screen silently reads as data loss — say WHY
        // the saved instance didn't come back (unreachable vs revoked auth).
        if (outcome.status === 'unreachable') {
          setAutoConnectNotice({ kind: 'unreachable', label: outcome.label });
        } else if (outcome.status === 'needs-login') {
          setAutoConnectNotice({ kind: 'auth-expired', label: outcome.label });
        }
        setAutoConnectPhase('done');
      });
    return () => {
      cancelled = true;
    };
    // Run once on mount — auto-connect is a cold-launch concern only.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // Cold launch with a PERSISTED runtime endpoint (the auto-connect effect
  // above skips this case): the app used to just sit on the recovery splash
  // for 8s while bootstrap failed, then show a vague "unable to reach server"
  // screen. Classify the failure with a fast re-probe instead: unreachable or
  // rejected auth drops straight to the connect screen with a banner saying
  // why; a switched/alive transport lets bootstrap proceed as usual.
  React.useEffect(() => {
    // NOTE: do NOT gate on isConnected here — the persisted store can claim a
    // stale `isConnected: true` at mount, which would skip the classification
    // exactly when it's needed. Check it at resolution time instead.
    if (!isNativeMobileApp || !getRuntimeApiBaseUrl()) return;
    let cancelled = false;
    const dropToConnectScreen = (notice: MobileConnectionNotice | null) => {
      if (notice) setAutoConnectNotice(notice);
      switchRuntimeEndpoint({ apiBaseUrl: '', clientToken: null, runtimeKey: 'mobile-disconnected' });
      setConnectionEpoch((value) => value + 1);
    };
    void reprobeActiveConnection().then(async (outcome) => {
      if (cancelled) return;
      // A genuinely live connection established itself while we probed.
      if (outcome === 'switched' || outcome === 'unchanged') return;
      const label = getAutoConnectTargetLabel();
      if (outcome === 'needs-login') {
        dropToConnectScreen({ kind: 'auth-expired', label: label ?? '' });
        return;
      }
      if (outcome === 'unreachable') {
        dropToConnectScreen(label ? { kind: 'unreachable', label } : null);
        return;
      }
      // 'no-connection': at cold start the runtime key may not map to a saved
      // connection yet — fall back to the auto-connect path, which both
      // classifies the failure and connects when everything is actually fine.
      const fallback = await autoConnectLastInstance().catch((): AutoConnectOutcome => ({ status: 'no-candidate' }));
      if (cancelled || fallback.status === 'connected') return;
      if (fallback.status === 'needs-login') {
        dropToConnectScreen({ kind: 'auth-expired', label: fallback.label });
      } else if (fallback.status === 'unreachable') {
        dropToConnectScreen({ kind: 'unreachable', label: fallback.label });
      } else {
        dropToConnectScreen(null);
      }
    });
    return () => {
      cancelled = true;
    };
    // Run once on mount — a cold-launch classification only; live drops are
    // handled by the resume/online re-probe paths.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  React.useEffect(() => {
    setIsMobile(true);
  }, [setIsMobile]);

  React.useEffect(() => {
    // Never bootstrap without a runtime endpoint on native: with apiBaseUrl ''
    // the resolver falls back to the webview's own origin, where Capacitor's
    // static server answers every request with index.html — the bootstrap
    // "succeeds" against a fake backend and flips isConnected back on, leaving
    // the user in an empty shell after a disconnect.
    if (isNativeMobileApp && !getRuntimeApiBaseUrl()) return;
    void initializeApp();
  }, [connectionEpoch, initializeApp, isNativeMobileApp]);

  React.useEffect(() => {
    if (!isConnected) return;
    if (providersCount === 0) void loadProviders({ source: 'mobileApp:recovery' });
    if (agentsCount === 0) void loadAgents({ source: 'mobileApp:recovery' });
  }, [agentsCount, isConnected, loadAgents, loadProviders, providersCount]);

  // Cold-launch continuity: after the launch instance connects, reopen the
  // session that was open on this instance last time — but only after an
  // authoritative sessions snapshot confirms it still exists, and only if the
  // user hasn't opened a session in the meantime. An open new-session draft
  // does NOT block the restore: ChatContainer auto-opens the draft whenever no
  // session is active, so at this point it reflects the boot default, not a
  // user choice. Runs once per successful launch connect; in-app instance
  // switches keep using the in-memory per-runtime session memory instead.
  const lastSessionRestoreDoneRef = React.useRef(false);
  // While true, a logo overlay covers the shell so the user never sees the
  // intermediate auto-opened draft before the restore decision lands.
  const [lastSessionRestorePending, setLastSessionRestorePending] = React.useState(isNativeMobileApp);
  React.useEffect(() => {
    if (!isNativeMobileApp || !isConnected || lastSessionRestoreDoneRef.current) return;
    if (useSessionUIStore.getState().currentSessionId) {
      lastSessionRestoreDoneRef.current = true;
      setLastSessionRestorePending(false);
      return;
    }
    const runtimeKey = getRuntimeKey();
    const persisted = readLastActiveSession(runtimeKey);
    if (!persisted) {
      lastSessionRestoreDoneRef.current = true;
      setLastSessionRestorePending(false);
      return;
    }
    let cancelled = false;
    // Safety valve: the overlay must never strand the user on the splash if
    // the snapshot hangs — fall through to the draft after a bounded wait.
    const overlayTimeoutId = window.setTimeout(() => setLastSessionRestorePending(false), 6000);
    void (async () => {
      // `null` = fetch failure — keep the ref unset so the next connect (a
      // stale persisted isConnected can fire this early) retries the restore.
      const snapshot = await refreshGlobalSessions().catch(() => null);
      if (cancelled) return;
      if (!snapshot) {
        setLastSessionRestorePending(false);
        return;
      }
      lastSessionRestoreDoneRef.current = true;
      const session = snapshot.activeSessions.find((entry) => entry.id === persisted.sessionId);
      if (!session) {
        // Authoritative snapshot says the session is gone (deleted/archived) —
        // drop the stale pointer instead of retrying it on every launch.
        clearLastActiveSession(runtimeKey);
        setLastSessionRestorePending(false);
        return;
      }
      const latest = useSessionUIStore.getState();
      if (!latest.currentSessionId) {
        void latest.setCurrentSession(
          session.id,
          resolveGlobalSessionDirectory(session) ?? persisted.directory ?? undefined,
        );
      }
      setLastSessionRestorePending(false);
    })();
    return () => {
      cancelled = true;
      window.clearTimeout(overlayTimeoutId);
    };
  }, [connectionEpoch, isConnected, isNativeMobileApp]);

  React.useEffect(() => {
    if (!isConnected) return;
    opencodeClient.setDirectory(currentDirectory);
  }, [currentDirectory, isConnected]);

  // Gated on isConnected (and re-run on reconnect/instance switch): probing the
  // GitHub auth status before the runtime is reachable cached a "not connected"
  // answer that stuck until something else forced a re-check.
  React.useEffect(() => {
    if (!isConnected) return;
    void refreshGitHubAuthStatus(apis.github, { force: true });
  }, [apis.github, isConnected, refreshGitHubAuthStatus]);

  // Discover all worktrees for every known project so the draft session's
  // worktree/branch dropdown can list every available branch — not only the
  // current one. Mirrors ElectronMiniChatApp + desktop SessionSidebar.
  // Gated on isConnected: running before the runtime is reachable made every
  // per-project probe fail silently, leaving the map empty until some later
  // projects-store update happened to re-run this effect (the "switch projects
  // back and forth to see worktrees" bug).
  React.useEffect(() => {
    if (!isConnected || projects.length === 0) return;
    let cancelled = false;

    const run = async () => {
      const worktreesByProject = new Map(useSessionUIStore.getState().availableWorktreesByProject);

      await Promise.all(
        projects.map(async (project) => {
          const projectPath = project.path.replace(/\\/g, '/').replace(/\/+$/, '');
          if (!projectPath) return;
          try {
            const cachedIsGitRepo = useGitStore.getState().directories.get(projectPath)?.isGitRepo;
            const isGitRepo =
              cachedIsGitRepo ?? (await import('@/lib/gitApi').then((m) => m.checkIsGitRepository(projectPath)));
            if (!isGitRepo) return;
            const worktrees = await listProjectWorktrees({ id: project.id, path: projectPath });
            if (cancelled) return;
            worktreesByProject.set(projectPath, worktrees);
          } catch {
            // Worktree discovery is best-effort per project: a failed probe keeps
            // that project's previously known (persisted) worktrees instead of
            // wiping the whole map.
          }
        }),
      );

      if (cancelled) return;

      const partitionedWorktreesByProject = partitionWorktreesByRegisteredProject(projects, worktreesByProject);

      // Skip update if nothing changed — see worktreeMapsEqual JSDoc.
      const currentByProject = useSessionUIStore.getState().availableWorktreesByProject;
      if (!worktreeMapsEqual(partitionedWorktreesByProject, currentByProject)) {
        useSessionUIStore.setState({
          availableWorktrees: [...partitionedWorktreesByProject.values()].flat(),
          availableWorktreesByProject: partitionedWorktreesByProject,
        });
      }
    };

    void run();

    return () => {
      cancelled = true;
    };
  }, [isConnected, projects]);

  React.useEffect(() => {
    let cancelled = false;

    const run = async () => {
      const res = await runtimeFetch('/health', { method: 'GET' }).catch(() => null);
      if (!res || !res.ok || cancelled) return;
      const data = (await res.json().catch(() => null)) as null | { planModeExperimentalEnabled?: unknown };
      if (!data || cancelled) return;
      const raw = data.planModeExperimentalEnabled;
      setPlanModeEnabled(raw === true || raw === 1 || raw === '1' || raw === 'true');
    };

    void run();

    return () => {
      cancelled = true;
    };
  }, [setPlanModeEnabled]);

  React.useEffect(() => {
    if (!error) return;
    const timeout = window.setTimeout(() => clearError(), 5000);
    return () => window.clearTimeout(timeout);
  }, [clearError, error]);

  React.useEffect(() => {
    // Native: only while an instance is selected and reconnecting. Browser: the
    // runtime is same-origin (no explicit base URL), so any not-connected spell
    // counts — the splash holds until this fires, then the error screen shows.
    const waitingOnConnection = !isConnected && (isNativeMobileApp ? Boolean(getRuntimeApiBaseUrl()) : true);
    if (!waitingOnConnection) {
      setShowConnectionRecovery(false);
      return;
    }
    // Native decides faster: the cold-start classification has usually already
    // resolved by then, so this is the "server picked but bootstrap won't
    // finish" fallback (e.g. older servers where auth can't be probed).
    const timeout = window.setTimeout(() => {
      setShowConnectionRecovery(true);
    }, isNativeMobileApp ? 4000 : 8000);
    return () => window.clearTimeout(timeout);
  }, [isConnected, isNativeMobileApp, connectionEpoch, runtimeEndpointEpoch]);

  useAppFontEffects();
  usePushVisibilityBeacon({ enabled: true });
  useUpdatePolling();
  useWindowTitle();
  useRouter();
  // APNs is the only notification channel on the native app (background-capable,
  // focus-suppressed server-side via the visibility beacon). Local notifications are
  // intentionally disabled — they can't tell foreground from background in a WKWebView
  // (document.hasFocus() is unreliable) and leaked while the app was open; the in-app SSE
  // notification dispatch is no-op'd for native in renderMobileApp.
  useNativePushRegistration({ enabled: isNativeMobileApp && isConnected });
  // Single native deep-link entry point: notification taps AND the openchamber:// URL
  // scheme (widgets, Live Activities, external links). Registered unconditionally so a
  // cold-launch tap/open isn't lost on the connect/splash screen; intents stash until
  // the app is ready (connected + initialized) and shell handlers are registered.
  useDeepLinkSource({ ready: isNativeMobileApp && isConnected && isInitialized });
  const fontsReady = useFontsReady();

  // `isConnected` is a LIVE flag that flips false on every transient SSE/WS drop and
  // back true on reconnect. We must NOT blank the whole app to a loader on those —
  // only on the initial connect / instance switch (connectionPhase 'connecting').
  // While 'reconnecting' (we were connected before), keep MobileShell mounted so the
  // UI doesn't reload on every network blip.
  const isReconnecting = !isConnected && connectionPhase === 'reconnecting';

  // Hold a logo splash until the UI web font is loaded, so the first UI the user sees
  // already uses the real font instead of flashing the fallback and reflowing (FOUT).
  if (!fontsReady) {
    return (
      <main className="flex min-h-dvh items-center justify-center bg-background text-foreground">
        <OpenChamberLogo width={120} height={120} isAnimated />
      </main>
    );
  }

  // No runtime endpoint on native = explicitly disconnected (last instance
  // deleted, revoked token, unreachable). The connect screen is the only valid
  // UI then — regardless of what a stale isConnected flag claims (the store can
  // be poisoned by a bootstrap that ran against the webview's own origin).
  const hasRuntimeEndpoint = Boolean(getRuntimeApiBaseUrl());

  if (isNativeMobileApp && (!hasRuntimeEndpoint || (!isConnected && !isReconnecting))) {
    // A runtime endpoint is already selected (first connect or switching instances):
    // show a loader while it re-bootstraps instead of flashing the onboarding screen.
    if (hasRuntimeEndpoint) {
      return (
        <main className="flex min-h-dvh items-center justify-center bg-background px-6 text-center text-foreground">
          <div className="flex max-w-sm flex-col items-center gap-4">
            <OpenChamberLogo width={120} height={120} isAnimated={!showConnectionRecovery} />
            {showConnectionRecovery ? (
              <>
                <div className="space-y-2">
                  <h1 className="typography-h3 text-foreground">{t('sessionAuth.error.networkTitle')}</h1>
                  {/* Native copy — the browser-oriented sessionAuth description
                      (Desktop Network Access etc.) reads as noise here. */}
                  <p className="typography-body text-muted-foreground">{t('mobile.connect.recovery.description')}</p>
                </div>
                <Button
                  type="button"
                  variant="outline"
                  onClick={() => {
                    switchRuntimeEndpoint({ apiBaseUrl: '', clientToken: null, runtimeKey: 'mobile-disconnected' });
                    setConnectionEpoch((value) => value + 1);
                  }}
                >
                  {t('mobile.connect.cancelPassword')}
                </Button>
              </>
            ) : null}
          </div>
        </main>
      );
    }
    // Cold-launch auto-connect is still resolving — hold the splash instead of
    // flashing the connect screen. Only show the connect screen once we've finished
    // (no saved instance, unreachable, or needs re-login).
    if (autoConnectPhase !== 'done') {
      return (
        <main className="relative flex min-h-dvh items-center justify-center bg-background text-foreground">
          <OpenChamberLogo width={120} height={120} isAnimated />
          {/* Absolutely positioned below the (still perfectly centered) logo so
              the text never pushes it up. 50% + half the 120px logo + a gap. */}
          {autoConnectLabel ? (
            <div className="absolute inset-x-0 top-[calc(50%+84px)] flex flex-col items-center gap-0.5 px-6 text-center">
              <p className="typography-small text-muted-foreground">{t('mobile.connect.splash.connectingTo')}</p>
              <p className="typography-small text-foreground">
                {autoConnectLabel}
                <BusyDots />
              </p>
            </div>
          ) : null}
        </main>
      );
    }
    return (
      <>
        <MobileConnectionWelcome
          onConnected={() => setConnectionEpoch((value) => value + 1)}
          notice={autoConnectNotice}
        />
      </>
    );
  }

  if (!isConnected && !isReconnecting) {
    // Browser: the initial connect takes a beat — hold the logo splash instead
    // of flashing the unreachable-server error while it resolves. The error
    // only shows once the recovery delay has expired (genuinely unreachable).
    if (!showConnectionRecovery) {
      return (
        <main className="flex min-h-dvh items-center justify-center bg-background text-foreground">
          <OpenChamberLogo width={120} height={120} isAnimated />
        </main>
      );
    }
    return (
      <main className="flex min-h-dvh items-center justify-center bg-background px-6 text-center text-foreground">
        <div className="max-w-sm space-y-3">
          <h1 className="typography-h3 text-foreground">{t('sessionAuth.error.networkTitle')}</h1>
          <p className="typography-body text-muted-foreground">{t('sessionAuth.error.networkDescription')}</p>
        </div>
      </main>
    );
  }

  return (
    <ErrorBoundary>
      <SyncProvider key={runtimeEndpointEpoch} sdk={opencodeClient.getSdkClient()} directory={currentDirectory || ''}>
        <RuntimeAPIProvider apis={apis}>
          <TooltipProvider delayDuration={300} skipDelayDuration={150}>
            <div className="h-full bg-background text-foreground">
              {/* Cold-launch continuity: keep the boot logo up over the shell
                  until the last-session restore decides between session and
                  draft — otherwise the auto-opened draft flashes first. The
                  shell (and sync) still mounts and warms up underneath. */}
              {isNativeMobileApp && lastSessionRestorePending ? (
                <div className="fixed inset-0 z-50 flex items-center justify-center bg-background">
                  <OpenChamberLogo width={120} height={120} isAnimated />
                </div>
              ) : null}
              <SyncAppEffects embeddedBackgroundWorkEnabled={isInitialized} />
              <OpenCodeUpdateToast />
              <MobileAppUpdateToast />
              <MobileShell onActiveConnectionDeleted={() => {
                switchRuntimeEndpoint({ apiBaseUrl: '', clientToken: null, runtimeKey: 'mobile-disconnected' });
                setConnectionEpoch((value) => value + 1);
              }} />
              <Toaster position="top-center" offset="calc(var(--oc-safe-area-top, 0px) + 16px)" />
              {isInitialized ? <ConfigUpdateOverlay /> : null}
            </div>
          </TooltipProvider>
        </RuntimeAPIProvider>
      </SyncProvider>
    </ErrorBoundary>
  );
}
