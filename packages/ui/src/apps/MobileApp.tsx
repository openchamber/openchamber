import { flushSync } from 'react-dom';
import { OpenCodeCompatibilityGate } from '@/components/update/OpenCodeCompatibilityGate';
import React from 'react';

import { AboutSettings } from '@/components/sections/openchamber/AboutSettings';
import { OpenCodeUpdateToast } from '@/components/update/OpenCodeUpdateToast';
import { MobileAppUpdateToast } from '@/components/update/MobileAppUpdateToast';
import { ConfigUpdateOverlay } from '@/components/ui/ConfigUpdateOverlay';
import { Button } from '@/components/ui/button';
import { OpenChamberLogo } from '@/components/ui/OpenChamberLogo';
import { AppStartupOverlay } from '@/components/ui/AppStartupOverlay';
import { ChatView } from '@/components/views/ChatView';
import { PlanView } from '@/components/views/PlanView';
import { SettingsView } from '@/components/views/SettingsView';
import { AppLinkConfirmDialog } from '@/components/chat/AppLinkConfirmDialog';
import { SnippetQuickCreateDialog } from '@/components/snippets/SnippetQuickCreateDialog';
import { GlobalQuestionDialogs } from '@/components/layout/GlobalQuestionDialogs';
import { OpenCodeTrustDialog } from '@/components/projects/OpenCodeTrustDialog';
import { SpaceAccessDialog } from '@/components/session/spaces/SpaceAccessDialog';
import { SpaceActionsSheet, SpaceDeleteDialog } from '@/components/session/spaces/SpaceActions';
import { SpaceApplyDialog } from '@/components/session/spaces/SpaceApplyDialog';
import { SpaceSetupOutputDialog } from '@/components/session/spaces/SpaceSetupOutput';
import { ErrorBoundary } from '@/components/ui/ErrorBoundary';
import { RunOverview } from '@/components/multirun/RunOverview';
import { RuntimeAPIProvider } from '@/contexts/RuntimeAPIProvider';
import { useAuthSessionStore } from '@/lib/runtime-auth-expiry';
import { registerRuntimeAPIs } from '@/contexts/runtimeAPIRegistry';
import { TooltipProvider } from '@/components/ui/tooltip';
import { MobileToaster } from './MobileToaster';
import { usePushVisibilityBeacon } from '@/hooks/usePushVisibilityBeacon';
import { useKeepScreenAwake } from '@/hooks/useKeepScreenAwake';
import { useRouter } from '@/hooks/useRouter';
import { useTerminalSessionKeepalive } from '@/hooks/useTerminalSessionKeepalive';
import { useUpdatePolling } from '@/hooks/useUpdatePolling';
import { useWindowTitle } from '@/hooks/useWindowTitle';
import { useEnterprisePolicySync } from '@/hooks/useEnterprisePolicySync';
import { useRoutingSync } from '@/hooks/useRoutingSync';
import { useSourceControlProviderSync } from '@/hooks/useSourceControlProviderSync';
import { useTrackerProviderSync } from '@/hooks/useTrackerProviderSync';
import { useQuotaProviderSync } from '@/hooks/useQuotaProviderSync';
import { useAgentMemorySync } from '@/hooks/useAgentMemorySync';
import { useBrowserProviderSync } from '@/hooks/useBrowserProviderSync';
import { useGuestCatalogSync } from '@/hooks/useGuestCatalogSync';
import { useGuestMarksSync } from '@/hooks/useGuestMarksSync';
import { resolvePlanRequestOwner } from '@/hooks/useProjectContextOwner';
import { opencodeClient } from '@/lib/opencode/client';
import type { RuntimeAPIs } from '@/lib/api/types';
import type { ProjectRef } from '@/lib/projectContextApi';
import { readTabletLayout, useOrientation, useTabletLayout } from '@/lib/device';
import { useHardwareKeyboard } from '@/lib/hardwareKeyboard';
import { useI18n } from '@/lib/i18n';
import { subscribeOpenchamberEvents } from '@/lib/openchamberEvents';
import { getRuntimeApiBaseUrl, subscribeRuntimeEndpointChanged, switchRuntimeEndpoint, MOBILE_DISCONNECTED_RUNTIME_KEY } from '@/lib/runtime-switch';
import { subscribeActiveRelayTunnelStatus } from '@/lib/relay/runtime-tunnel';
import { isRelayLimitReached } from '@/lib/relay/tunnel-client';
import { useGlobalSessionsStore } from '@/stores/useGlobalSessionsStore';
import { useAuthoritativeSessionCleanup } from '@/components/session/sidebar/list/useAuthoritativeSessionCleanup';
import { beginLastSessionRestore } from '@/sync/last-session-restore';
import { cn } from '@/lib/utils';
import { useConfigStore } from '@/stores/useConfigStore';
import { useDirectoryStore } from '@/stores/useDirectoryStore';
import { useSourceControlAuthStore } from '@/stores/useSourceControlAuthStore';
import { useSourceControlProviderRegistry } from '@/lib/source-control/providers/registry';
import { refreshTrackers } from '@/stores/useTrackerAuthStore';
import { useUIStore } from '@/stores/useUIStore';
import { useChatWidthAttribute } from '@/hooks/useChatWidthAttribute';
import { closeTopmostBackLayer } from '@/lib/mobileBackLayers';
import { useUpdateStore } from '@/stores/useUpdateStore';
import { useSessionUIStore } from '@/sync/session-ui-store';
import { openSessionFromToast } from '@/sync/session-navigation';
import { SyncProvider } from '@/sync/sync-context';
import { toast } from '@/components/ui';

import { SyncAppEffects } from './AppEffects';
import { BusyDots } from '@/components/ui/busy-dots';
import { MobileConnectionWelcome, type MobileConnectionNotice } from './MobileConnectionWelcome';
import { MobileHeader } from './MobileHeader';
import { MobileInstancesSurface } from './MobileInstancesSurface';
import { MobileSessionsSheet } from './MobileSessionsSheet';
import { MobileFullscreenSurface } from './MobileFullscreenSurface';
import { fileNameOf, sessionLineage } from './mobileFileRequest';
import { connectMobileSettingsNavigation } from './mobileSettingsNavigation';
import { UsageStatsView } from '@/components/views/usage/UsageStatsView';
import { ArchiveSessionsView } from '@/components/views/ArchiveView';
import { MobileSourceBoard } from '@/components/sourceBoard/SourceBoardView';
import { OverviewPage } from '@/components/overview/OverviewView';
import { ScheduledTasksView, type ScheduledTasksLeaveReason } from '@/components/session/ScheduledTasksDialog';
import { MobileWorkspaceDrawer } from './MobileWorkspaceDrawer';
import type { MobileChangesCommitRequest } from './mobileChangesCommitRequest';
import type { MobileChangesInitialDiff } from '@/hooks/useMobileChangesNavigation';
import { connectMobileWorkspaceOpener, shownMobileWorkspaceTabs, type MobileWorkspaceTab } from '@/lib/mobileWorkspaceTabs';
import { GuestHosts } from '@/components/layout/GuestHosts';
import { useGuestPages, usePhoneGuestPanelModes } from '@/hooks/useGuestSurfaces';
import { phoneGuestPanelModes } from '@/lib/guests/phone';
import { useGuestsStore } from '@/lib/guests/store';
import { isPluginContextPanelMode, pluginModeFromId } from '@/lib/surfaces/modes';
import { DedicatedMobileAppProvider, type MobileAppActions } from './mobileAppContext';
import { autoConnectLastInstance, getAutoConnectTargetLabel, logMobileConnectEvent, reprobeActiveConnection, suppressAutoConnectUntilManualConnect, switchToSavedInstance, type AutoConnectOutcome } from './mobileConnections';
import { isCapacitorMobileApp, useAndroidParentSessionBack, useMobileBackHandlers, useMobileWebBackButton, useNativeMobileChrome, useNativeMobileLifecycle } from './mobileNativeChrome';
import { reconnectAppForTransportSwitch, resetAppForRuntimeEndpointChange } from './runtimeEndpointReset';
import { useAppFontEffects } from './useAppFontEffects';
import { useFontsReady } from './useFontsReady';
import { useDeepLinkSource } from './deepLinkNavigation';
import { useMobileDeepLinkHandlers } from './useMobileDeepLinkHandlers';
import { useEdgeSwipe } from './useEdgeSwipe';
import { useMobileChatInsets } from '@/lib/mobileChatInsets';
import { useNativePushRegistration } from './useNativePushRegistration';
import { useNativeWidgetSync } from './useNativeWidgetSync';
import { IpadSidebarResizeHandle } from './IpadSidebarResizeHandle';
import { ScrollableOverlay } from '@/components/ui/ScrollableOverlay';
import {
  IPAD_LEFT_SIDEBAR_WIDTH,
  IPAD_RIGHT_SIDEBAR_WIDTH,
  IPAD_WORKSPACE_SIDEBAR_MAX_WIDTH,
  useIpadPanelSlide,
  useIpadSidebarResize,
} from './ipadSidebarResize';
import { ReceivedPagePanel } from '@/components/chat/sharePages/received/ReceivedPagePanel';
import { focusChatInput } from '@/components/chat/composer/editor/dom';
import { hasReceivedPages, useReceivedPagesStore } from '@/components/chat/sharePages/received/receivedPagesStore';

const MOBILE_SETTINGS_PAGES = [
  'general',
  'isolated-spaces',
  'appearance',
  'chat',
  'notifications',
  'sessions',
  'routing',
  'projects',
  'git',
  'magic-prompts',
  'snippets',
  'behavior',
  'agents',
  'commands',
  'mcp',
  'plugins',
  'skills.installed',
  'skills.catalog',
  'providers',
  'web-search',
  'usage',
  'voice',
  'integrations',
  'extensions',
  'about',
] as const;

type MobileAppProps = {
  apis: RuntimeAPIs;
};

const NATIVE_RESUME_SYNC_EVENT_THROTTLE_MS = 1_000;

const PluginPane = React.lazy(() => import('@/components/layout/PluginPane').then((module) => ({ default: module.PluginPane })));

type MobileSurface = 'archive' | 'board' | 'overview' | 'instances' | 'scheduled' | 'settings' | 'update' | 'usage';

const MobileShell: React.FC<{ onActiveConnectionDeleted: () => void }> = ({ onActiveConnectionDeleted }) => {
  const { t, direction } = useI18n();
  useTerminalSessionKeepalive();
  const [sessionsSheetOpen, setSessionsSheetOpen] = React.useState(false);
  React.useEffect(() => useSessionUIStore.subscribe((state, prev) => {
    if (state.currentSessionId && state.currentSessionId !== prev.currentSessionId) {
      useUIStore.getState().setRunOverviewKey(null);
    }
  }), []);
  const runOverviewOpen = useUIStore((state) => state.runOverviewKey !== null);
  React.useEffect(() => {
    if (runOverviewOpen) setSessionsSheetOpen(false);
  }, [runOverviewOpen]);
  const [activeSurface, setActiveSurface] = React.useState<MobileSurface | null>(null);
  const [workspaceOpen, setWorkspaceOpen] = React.useState(false);
  const [workspaceTab, setWorkspaceTab] = React.useState<MobileWorkspaceTab>(() => {
    const { mobileWorkspaceTabOrder, mobileWorkspaceHiddenTabs } = useUIStore.getState();
    return shownMobileWorkspaceTabs(mobileWorkspaceTabOrder, mobileWorkspaceHiddenTabs)[0];
  });
  const openWorkspace = React.useCallback(() => {
    const { mobileWorkspaceTabOrder, mobileWorkspaceHiddenTabs } = useUIStore.getState();
    const extensions = phoneGuestPanelModes(useGuestsStore.getState().guests);
    const shown = shownMobileWorkspaceTabs(mobileWorkspaceTabOrder, mobileWorkspaceHiddenTabs, extensions);
    const pagesShown = hasReceivedPages(useReceivedPagesStore.getState());
    setWorkspaceTab((current) => (shown.some((id) => id === current) || (current === 'pages' && pagesShown) ? current : shown[0]));
    setWorkspaceOpen(true);
  }, []);
  const [openPlan, setOpenPlan] = React.useState<{ id: string; title: string; projectRef: ProjectRef } | null>(null);
  const [openReceivedPage, setOpenReceivedPage] = React.useState<{ receivedId: string; title: string } | null>(null);

  const [settingsInitialMobileStage, setSettingsInitialMobileStage] = React.useState<'nav' | 'page-content'>('nav');
  const [changesRequest, setChangesRequest] = React.useState<{ diff: MobileChangesInitialDiff } | { commit: MobileChangesCommitRequest } | null>(null);
  const pendingChangesDiff = changesRequest && 'diff' in changesRequest ? changesRequest.diff : null;
  const pendingChangesCommit = changesRequest && 'commit' in changesRequest ? changesRequest.commit : null;
  const extensionTabs = usePhoneGuestPanelModes();
  React.useEffect(() => {
    if (!isPluginContextPanelMode(workspaceTab) || extensionTabs.includes(workspaceTab)) return;
    const { mobileWorkspaceTabOrder, mobileWorkspaceHiddenTabs } = useUIStore.getState();
    setWorkspaceTab(shownMobileWorkspaceTabs(mobileWorkspaceTabOrder, mobileWorkspaceHiddenTabs, extensionTabs)[0]);
  }, [extensionTabs, workspaceTab]);
  const openGuestPageId = useUIStore((state) => state.openGuestPageId);
  const guestPages = useGuestPages();
  const guestPage = guestPages.find((guest) => guest.id === openGuestPageId) ?? null;
  React.useEffect(() => {
    if (openGuestPageId && !guestPage) useUIStore.getState().setOpenGuestPage(null);
  }, [guestPage, openGuestPageId]);
  const closeGuestPage = React.useCallback(() => useUIStore.getState().setOpenGuestPage(null), []);
  const updateAvailable = useUpdateStore((state) => state.available);
  const updateRuntimeType = useUpdateStore((state) => state.runtimeType);
  const showCapacitorOnlyFeatures = React.useMemo(() => isCapacitorMobileApp(), []);

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

  React.useEffect(
    () => connectMobileSettingsNavigation(MOBILE_SETTINGS_PAGES, openSettingsSurface),
    [openSettingsSurface],
  );

  const { enabled: isTabletLayout, roomyForPanels, roomyForOnePanel } = useTabletLayout();
  const persistentSidebar = roomyForPanels || roomyForOnePanel;
  const orientation = useOrientation();
  const isPortrait = orientation === 'portrait';
  const hasHardwareKeyboard = useHardwareKeyboard();
  const [sidebarOpen, setSidebarOpen] = React.useState(() => {
    const layout = readTabletLayout();
    return layout.roomyForPanels || layout.roomyForOnePanel;
  });

  const toggleSidebar = React.useCallback(() => {
    setSidebarOpen((current: boolean) => !current);
  }, []);

  const wasTabletLayoutRef = React.useRef(isTabletLayout);
  React.useEffect(() => {
    if (!isTabletLayout) setSidebarOpen(false);
    else if (!wasTabletLayoutRef.current && !workspaceOpen) setSidebarOpen(true);
    wasTabletLayoutRef.current = isTabletLayout;
  }, [isTabletLayout, workspaceOpen]);

  const openFilesSurface = React.useCallback(() => {
    setChangesRequest(null);
    setWorkspaceTab('files');
    setWorkspaceOpen(true);
  }, []);

  React.useEffect(() => subscribeOpenchamberEvents((event) => {
    if (event.type !== 'file-open-request') return;
    const directory = event.directory ?? useDirectoryStore.getState().currentDirectory;
    if (!directory) return;
    const showFile = () => {
      useUIStore.getState().openContextFile(directory, event.path);
      openFilesSurface();
    };
    const { sessionId } = event;
    if (!sessionId) {
      showFile();
      return;
    }
    const readSession = async (id: string) => useGlobalSessionsStore.getState().entityById.get(id)
      ?? await opencodeClient.getSession(id).catch(() => null);
    void sessionLineage(sessionId, readSession).then((lineage) => {
      const isViewed = () => {
        const { currentSessionId } = useSessionUIStore.getState();
        return currentSessionId === sessionId || lineage.some((session) => session.id === currentSessionId);
      };
      if (isViewed()) {
        showFile();
        return;
      }
      const title = lineage[0]?.title;
      toast.info(fileNameOf(event.path), {
        id: `file-open-${sessionId}:${event.path}`,
        description: title
          ? t('chat.fileOpenRequest.toast.description', { session: title })
          : t('chat.fileOpenRequest.toast.descriptionUntitled'),
        action: {
          label: t('chat.fileOpenRequest.toast.openSession'),
          onClick: () => {
            openSessionFromToast(sessionId, directory);
            closeSurface();
            setSessionsSheetOpen(false);
            if (isViewed()) showFile();
          },
        },
      });
    });
  }), [closeSurface, openFilesSurface, t]);

  React.useEffect(() => subscribeOpenchamberEvents((event) => {
    if (event.type !== 'plan-open-request') return;
    const projectRef = resolvePlanRequestOwner(event.directory ?? useDirectoryStore.getState().currentDirectory, event.projectId);
    if (!projectRef) return;
    setOpenPlan({ id: event.planId, title: event.title, projectRef });
  }), []);

  const openChangesSurface = React.useCallback((diff: MobileChangesInitialDiff | null = null) => {
    setChangesRequest(diff ? { diff } : null);
    setWorkspaceTab('changes');
    setWorkspaceOpen(true);
  }, []);

  React.useEffect(() => connectMobileWorkspaceOpener((request) => {
    useUIStore.getState().setOpenGuestPage(null);
    if (request.tab === 'changes' && request.commit) {
      setChangesRequest({ commit: { scope: 'commit', directory: request.commit.directory } });
    }
    setWorkspaceTab(request.tab);
    setWorkspaceOpen(true);
  }), []);

  const leftResize = useIpadSidebarResize('left', 'openchamber.ipad.leftSidebarWidth', IPAD_LEFT_SIDEBAR_WIDTH);
  const rightResize = useIpadSidebarResize(
    'right',
    'openchamber.ipad.rightSidebarWidth',
    IPAD_RIGHT_SIDEBAR_WIDTH,
    IPAD_WORKSPACE_SIDEBAR_MAX_WIDTH,
  );
  const workspaceAsPanel = roomyForPanels || roomyForOnePanel;

  const displacedPanelRef = React.useRef<'sidebar' | 'workspace' | null>(null);
  const previousPanelsRef = React.useRef({ sidebarOpen, workspaceOpen });
  React.useLayoutEffect(() => {
    const previous = previousPanelsRef.current;
    previousPanelsRef.current = { sidebarOpen, workspaceOpen };
    if (!roomyForOnePanel) {
      const displaced = displacedPanelRef.current;
      displacedPanelRef.current = null;
      if (roomyForPanels && displaced === 'sidebar') setSidebarOpen(true);
      else if (roomyForPanels && displaced === 'workspace') setWorkspaceOpen(true);
      return;
    }
    const sidebarOpened = sidebarOpen && !previous.sidebarOpen;
    const workspaceOpened = workspaceOpen && !previous.workspaceOpen;
    if (sidebarOpen && workspaceOpen) {
      if (sidebarOpened && !workspaceOpened) {
        displacedPanelRef.current = 'workspace';
        setWorkspaceOpen(false);
      } else {
        displacedPanelRef.current = 'sidebar';
        setSidebarOpen(false);
      }
      return;
    }
    if (!workspaceOpen && previous.workspaceOpen && displacedPanelRef.current === 'sidebar') {
      displacedPanelRef.current = null;
      setSidebarOpen(true);
    } else if (!sidebarOpen && previous.sidebarOpen && displacedPanelRef.current === 'workspace') {
      displacedPanelRef.current = null;
      setWorkspaceOpen(true);
    }
  }, [roomyForOnePanel, roomyForPanels, sidebarOpen, workspaceOpen]);
  const leftSlide = useIpadPanelSlide(isTabletLayout && sidebarOpen);
  const workspaceSlide = useIpadPanelSlide(workspaceAsPanel && workspaceOpen);
  const workspaceDisplaced = roomyForOnePanel && sidebarOpen;
  const sidebarDisplaced = roomyForOnePanel && workspaceOpen;
  const workspacePanelWidth = workspaceAsPanel && workspaceSlide.placed && !workspaceDisplaced ? rightResize.width : 0;
  const sidebarWidth = isTabletLayout && leftSlide.placed && !sidebarDisplaced ? leftResize.width : 0;
  const offStart = direction === 'rtl' ? '100%' : '-100%';
  const offEnd = direction === 'rtl' ? '-100%' : '100%';

  React.useEffect(() => {
    useMobileChatInsets.setState({ left: sidebarWidth, right: workspacePanelWidth });
    return () => useMobileChatInsets.setState({ left: 0, right: 0 });
  }, [sidebarWidth, workspacePanelWidth]);

  useChatWidthAttribute();

  React.useEffect(() => {
    if (typeof document === 'undefined') return;
    const keep = isTabletLayout && (isPortrait || hasHardwareKeyboard);
    const root = document.documentElement;
    root.classList.toggle('oc-keep-draft-starters', keep);
    return () => root.classList.remove('oc-keep-draft-starters');
  }, [hasHardwareKeyboard, isTabletLayout, isPortrait]);

  const mobileActions = React.useMemo<MobileAppActions>(
    () => ({
      openChanges: ({ diffPath, staged, scope, turnId, sessionId, directory } = {}) => {
        openChangesSurface(diffPath ? { path: diffPath, staged: staged === true, scope, turnId, sessionId, directory } : null);
      },
      openFiles: () => openFilesSurface(),
      openSourceBoard: () => openSurface('board'),
      openPlan: setOpenPlan,
      openReceivedPage: setOpenReceivedPage,
    }),
    [openChangesSurface, openFilesSurface, openSurface],
  );

  useMobileDeepLinkHandlers({
    isTabletLayout, setSidebarOpen, setSessionsSheetOpen, setWorkspaceTab, setWorkspaceOpen, setOpenReceivedPage,
    openSurface, openFilesSurface, openChangesSurface, openSettingsSurface, closeSurface, closeGuestPage, closeWorkspace,
  });

  const chatMainRef = React.useRef<HTMLElement>(null);
  const openSessionsFromEdge = () => {
    if (isTabletLayout) setSidebarOpen(true);
    else setSessionsSheetOpen(true);
  };
  const openWorkspaceFromEdge = () => openWorkspace();
  useEdgeSwipe(chatMainRef, {
    onLeftEdgeSwipe: direction === 'rtl' ? openWorkspaceFromEdge : openSessionsFromEdge,
    onRightEdgeSwipe: direction === 'rtl' ? openSessionsFromEdge : openWorkspaceFromEdge,
  });

  const { settingsBackRef, previewBackRef, parentSessionBackRef, registerSettingsBackHandler, registerPreviewBackHandler, registerParentSessionBack } = useMobileBackHandlers();

  const handleNativeBack = React.useCallback(() => {
    if (closeTopmostBackLayer()) {
      return true;
    }
    if (openReceivedPage) {
      setOpenReceivedPage(null);
      return true;
    }
    if (openPlan) {
      setOpenPlan(null);
      return true;
    }
    if (guestPage) {
      closeGuestPage();
      return true;
    }
    if (activeSurface === 'settings' && settingsBackRef.current?.()) {
      return true;
    }
    if (activeSurface) {
      closeSurface();
      return true;
    }
    if (workspaceOpen) {
      if (workspaceTab === 'preview' && previewBackRef.current?.()) return true;
      closeWorkspace();
      return true;
    }
    if (sessionsSheetOpen) {
      setSessionsSheetOpen(false);
      return true;
    }
    return false;
  }, [activeSurface, closeGuestPage, closeSurface, closeWorkspace, guestPage, openPlan, openReceivedPage, previewBackRef, sessionsSheetOpen, settingsBackRef, workspaceOpen, workspaceTab]);

  useAndroidParentSessionBack(handleNativeBack, parentSessionBackRef);

  useMobileWebBackButton(handleNativeBack, Boolean(openPlan || openReceivedPage || guestPage || activeSurface || workspaceOpen || sessionsSheetOpen));

  const showUpdateItem = !showCapacitorOnlyFeatures
    && updateAvailable
    && (updateRuntimeType === 'desktop' || updateRuntimeType === 'web');

  const surfaceVariant = isTabletLayout ? 'dialog' as const : 'fullscreen' as const;

  const overviewAvailable = useUIStore((state) => state.overviewFeatureAvailable);
  const sessionsFooter = React.useMemo(
    () => ({
      instanceLabel: showCapacitorOnlyFeatures ? getAutoConnectTargetLabel() : null,
      onOpenInstances: showCapacitorOnlyFeatures ? () => openSurface('instances') : undefined,
      onOpenSettings: () => openSettingsSurface('nav'),
      onOpenUsage: () => openSurface('usage'),
      onOpenScheduled: () => openSurface('scheduled'),
      onOpenArchive: () => openSurface('archive'),
      onOpenOverview: overviewAvailable ? () => openSurface('overview') : undefined,
      onOpenSourceBoard: () => openSurface('board'),
      onOpenUpdate: showUpdateItem ? () => openSurface('update') : undefined,
    }),
    [openSettingsSurface, openSurface, overviewAvailable, showCapacitorOnlyFeatures, showUpdateItem],
  );

  const leaveScheduledTasks = React.useCallback((reason: ScheduledTasksLeaveReason) => {
    closeSurface();
    setSessionsSheetOpen(false);
    if (reason === 'file') openFilesSurface();
  }, [closeSurface, openFilesSurface]);

  const leaveSourceBoard = React.useCallback(() => {
    closeSurface();
    setSessionsSheetOpen(false);
  }, [closeSurface]);

  const leaveOverview = React.useCallback(() => {
    closeSurface();
    setSessionsSheetOpen(false);
    if (isTabletLayout && !persistentSidebar) setSidebarOpen(false);
  }, [closeSurface, isTabletLayout, persistentSidebar]);

  const leaveArchive = React.useCallback(() => {
    closeSurface();
    setSessionsSheetOpen(false);
    if (isTabletLayout && !persistentSidebar) setSidebarOpen(false);
  }, [closeSurface, isTabletLayout, persistentSidebar]);


  return (
    <DedicatedMobileAppProvider actions={mobileActions}>
      <div
        className="oc-mobile-app-shell main-content-safe-area oc-side-safe-area flex h-[100dvh] flex-row bg-background text-foreground"
        data-page-scroll-lock="true"
      >
        {isTabletLayout ? (
          <aside
            ref={leftResize.asideRef}
            className={cn(
              'oc-ipad-sidebar relative flex h-full shrink-0 flex-col overflow-hidden',
            )}
            style={{
              width: sidebarWidth,
              minWidth: sidebarWidth,
              maxWidth: sidebarWidth,
              ['--oc-ipad-sidebar-width' as string]: `${leftResize.width}px`,
              overflowX: 'clip',
            }}
            aria-hidden={!sidebarOpen}
            data-page-scroll-lock="true"
          >
            <div
              className={cn(
                'flex h-full shrink-0 flex-col border-e border-edge bg-background transition-[translate] duration-200 ease-[cubic-bezier(0.22,1,0.36,1)] motion-reduce:transition-none',
                leftResize.isResizing && 'pointer-events-none',
                !sidebarOpen && 'pointer-events-none select-none',
              )}
              style={{ width: 'var(--oc-ipad-sidebar-width)', overflowX: 'hidden', paddingTop: 'var(--oc-safe-area-top, 0px)', translate: leftSlide.inPlace ? undefined : offStart }}
            >
              <ErrorBoundary>
                <MobileSessionsSheet
                  open={leftSlide.placed}
                  variant="sidebar"
                  onOpenChange={(value) => {
                    if (!value && !persistentSidebar) setSidebarOpen(false);
                  }}
                  footer={sessionsFooter}
                />
              </ErrorBoundary>
            </div>
            {sidebarOpen ? (
              <IpadSidebarResizeHandle
                side="left"
                isResizing={leftResize.isResizing}
                ariaLabel={t('sidebar.resize.leftPanelAria')}
                handleProps={leftResize.handleProps}
              />
            ) : null}
          </aside>
        ) : null}

        <div className="flex h-full min-w-0 flex-1 flex-col" data-page-scroll-lock="true">
          <MobileHeader
            onOpenSessions={() => (isTabletLayout ? toggleSidebar() : setSessionsSheetOpen(true))}
            onOpenWorkspace={openWorkspace}
            compactTitle={isTabletLayout}
          />
          <main ref={chatMainRef} className="relative min-h-0 flex-1 overflow-hidden" data-page-scroll-lock="true">
            <div className="h-full w-full">
              <ErrorBoundary>
                <ChatView registerParentSessionBack={registerParentSessionBack} />
              </ErrorBoundary>
            </div>
            <ErrorBoundary><RunOverview /></ErrorBoundary>
          </main>
        </div>

        {!isTabletLayout ? (
          <MobileSessionsSheet
            open={sessionsSheetOpen}
            onOpenChange={setSessionsSheetOpen}
            footer={sessionsFooter}
          />
        ) : null}

        <aside
          ref={rightResize.asideRef}
          className={cn(
            'relative flex h-full shrink-0 flex-col overflow-hidden',
          )}
          style={{
            width: workspacePanelWidth,
            minWidth: workspacePanelWidth,
            maxWidth: workspacePanelWidth,
            ['--oc-ipad-sidebar-width' as string]: `${rightResize.width}px`,
            overflowX: 'clip',
          }}
          aria-hidden={!workspacePanelWidth}
          data-page-scroll-lock="true"
        >
          <div
            className={cn(
              'flex h-full min-h-0 shrink-0 flex-col transition-[translate] duration-200 ease-[cubic-bezier(0.22,1,0.36,1)] motion-reduce:transition-none',
              workspaceAsPanel && 'border-s border-edge bg-background',
              rightResize.isResizing && 'pointer-events-none',
              !workspaceSlide.inPlace && 'pointer-events-none select-none',
            )}
            style={{ width: 'var(--oc-ipad-sidebar-width)', overflowX: 'hidden', paddingTop: 'var(--oc-safe-area-top, 0px)', translate: workspaceSlide.inPlace ? undefined : offEnd }}
          >
            <ErrorBoundary>
              <MobileWorkspaceDrawer
                open={workspaceAsPanel ? workspaceSlide.placed : workspaceOpen} closing={!workspaceOpen}
                onClose={closeWorkspace}
                tab={workspaceTab}
                onTabChange={setWorkspaceTab}
                registerPreviewBackHandler={registerPreviewBackHandler}
                pendingChangesDiff={pendingChangesDiff}
                pendingChangesCommit={pendingChangesCommit}
                onOpenPlan={setOpenPlan}
                onOpenReceivedPage={setOpenReceivedPage}
                variant={workspaceAsPanel ? 'panel' : 'drawer'}
              />
            </ErrorBoundary>
          </div>
          {workspaceAsPanel && workspaceOpen ? (
            <IpadSidebarResizeHandle
              side="right"
              isResizing={rightResize.isResizing}
              ariaLabel={t('sidebar.resize.rightPanelAria')}
              handleProps={rightResize.handleProps}
            />
          ) : null}
        </aside>

        {openPlan ? (
          <MobileFullscreenSurface
            open
            variant={surfaceVariant}
            onClose={() => setOpenPlan(null)}
            ariaLabel={openPlan.title}
            title={openPlan.title}
          >
            <ErrorBoundary>
              <PlanView
                savedProjectPlan={{ projectRef: openPlan.projectRef, planId: openPlan.id }}
                onClose={() => setOpenPlan(null)}
                onNavigatedToChat={() => {
                  closeSurface();
                  closeWorkspace();
                }}
              />
            </ErrorBoundary>
          </MobileFullscreenSurface>
        ) : null}

        {openReceivedPage ? (
          <MobileFullscreenSurface
            open
            variant={surfaceVariant}
            onClose={() => setOpenReceivedPage(null)}
            ariaLabel={openReceivedPage.title}
            title={openReceivedPage.title}
          >
            <ErrorBoundary>
              <ReceivedPagePanel
                receivedId={openReceivedPage.receivedId}
                onAddedToChat={() => {
                  flushSync(() => {
                    setOpenReceivedPage(null);
                    closeWorkspace();
                  });
                  const pill = document.querySelector<HTMLElement>('[data-composer-morph-prompt="true"]');
                  if (pill) pill.click();
                  else focusChatInput();
                }}
              />
            </ErrorBoundary>
          </MobileFullscreenSurface>
        ) : null}

        {guestPage ? (
          <MobileFullscreenSurface
            open
            variant={surfaceVariant}
            dialogAlign="app"
            onClose={closeGuestPage}
            ariaLabel={guestPage.pageTitle ?? guestPage.name}
            title={guestPage.pageTitle ?? guestPage.name}
            disableEscapeDismiss
          >
            <ErrorBoundary>
              <React.Suspense fallback={null}>
                <PluginPane key={guestPage.id} mode={pluginModeFromId(guestPage.id)} surface="page" />
              </React.Suspense>
            </ErrorBoundary>
          </MobileFullscreenSurface>
        ) : null}

        <ErrorBoundary><GuestHosts /></ErrorBoundary>

        {activeSurface === 'instances' && showCapacitorOnlyFeatures ? (
          <MobileFullscreenSurface
            open
            variant={surfaceVariant}
            dialogAlign="app"
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
            variant={surfaceVariant}
            dialogAlign="app"
            onClose={closeSurface}
            ariaLabel={t('mobile.menu.settings')}
            headerless
          >
            <ErrorBoundary>
              <SettingsView
                forceMobile
                isWindowed
                initialMobileStage={settingsInitialMobileStage}
                registerBackHandler={registerSettingsBackHandler}
                visiblePageSlugs={[...MOBILE_SETTINGS_PAGES]}
                onClose={closeSurface}
              />
            </ErrorBoundary>
          </MobileFullscreenSurface>
        ) : null}

        {activeSurface === 'usage' ? (
          <MobileFullscreenSurface
            open
            variant={surfaceVariant}
            dialogAlign="app"
            onClose={closeSurface}
            ariaLabel={t('usageStats.title')}
            title={t('usageStats.title')}
          >
            <ErrorBoundary>
              <UsageStatsView />
            </ErrorBoundary>
          </MobileFullscreenSurface>
        ) : null}

        {activeSurface === 'scheduled' ? (
          <MobileFullscreenSurface
            open
            variant={surfaceVariant}
            dialogAlign="app"
            onClose={closeSurface}
            ariaLabel={t('sessions.scheduledTasks.dialog.title')}
            title={t('sessions.scheduledTasks.dialog.title')}
          >
            <ErrorBoundary>
              <ScheduledTasksView layout="mobile" onLeave={leaveScheduledTasks} />
            </ErrorBoundary>
          </MobileFullscreenSurface>
        ) : null}

        {activeSurface === 'board' ? (
          <MobileFullscreenSurface
            open
            variant={surfaceVariant}
            dialogAlign="app"
            onClose={closeSurface}
            ariaLabel={t('sourceBoard.title')}
            headerless
          >
            <ErrorBoundary>
              <MobileSourceBoard onLeave={leaveSourceBoard} onClose={closeSurface} />
            </ErrorBoundary>
          </MobileFullscreenSurface>
        ) : null}

        {activeSurface === 'overview' && overviewAvailable ? (
          <MobileFullscreenSurface
            open
            variant={surfaceVariant}
            dialogAlign="app"
            onClose={closeSurface}
            ariaLabel={t('overview.title')}
            title={t('overview.title')}
          >
            <ErrorBoundary>
              <OverviewPage layout="mobile" onLeave={leaveOverview} />
            </ErrorBoundary>
          </MobileFullscreenSurface>
        ) : null}

        {activeSurface === 'archive' ? (
          <MobileFullscreenSurface
            open
            variant={surfaceVariant}
            dialogAlign="app"
            onClose={closeSurface}
            ariaLabel={t('sessions.archivePage.title')}
            title={t('sessions.archivePage.title')}
          >
            <ErrorBoundary>
              <ArchiveSessionsView layout="mobile" onLeave={leaveArchive} />
            </ErrorBoundary>
          </MobileFullscreenSurface>
        ) : null}

        {activeSurface === 'update' ? (
          <MobileFullscreenSurface
            open
            variant={surfaceVariant}
            dialogAlign="app"
            onClose={closeSurface}
            ariaLabel={t('mobile.menu.update')}
            title={t('mobile.menu.update')}
          >
            <ErrorBoundary>
              <ScrollableOverlay outerClassName="h-full" className="px-5 py-4" disableHorizontal>
                <AboutSettings initialUpdateDialogOpen />
              </ScrollableOverlay>
            </ErrorBoundary>
          </MobileFullscreenSurface>
        ) : null}
      </div>
    </DedicatedMobileAppProvider>
  );
};

function MobileAppContent({ apis }: MobileAppProps) {
  const isolatedSpacesEnabled = useUIStore((state) => state.isolatedSpacesEnabled);
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
  const refreshSourceControlAuth = useSourceControlAuthStore((state) => state.refreshAll);
  const refreshSourceControlProviders = useSourceControlProviderRegistry((state) => state.refresh);
  const authoritativeSessions = useGlobalSessionsStore((state) => state.authoritativeSessions);
  const cleanupSessions = React.useMemo(() => authoritativeSessions ?? [], [authoritativeSessions]);
  useAuthoritativeSessionCleanup({
    hasAuthoritativeGlobalSessions: authoritativeSessions != null,
    sessions: cleanupSessions,
  });
  const [connectionEpoch, setConnectionEpoch] = React.useState(0);
  const [runtimeEndpointEpoch, setRuntimeEndpointEpoch] = React.useState(0);
  const [showConnectionRecovery, setShowConnectionRecovery] = React.useState(false);
  const [autoConnectPhase, setAutoConnectPhase] = React.useState<'pending' | 'attempting' | 'done'>('pending');
  const [autoConnectNotice, setAutoConnectNotice] = React.useState<MobileConnectionNotice | null>(null);
  const autoConnectLabel = React.useMemo(() => getAutoConnectTargetLabel(), []);
  const [, bumpTransportSwitch] = React.useReducer((count: number) => count + 1, 0);
  const isNativeMobileApp = React.useMemo(() => isCapacitorMobileApp(), []);
  const lastNativeResumeSyncEventAtRef = React.useRef(0);
  const nativeResumeValidationSeqRef = React.useRef(0);

  const handleNativeResume = React.useCallback(() => {
    const apiBaseUrl = getRuntimeApiBaseUrl();
    const validationSeq = nativeResumeValidationSeqRef.current + 1;
    nativeResumeValidationSeqRef.current = validationSeq;

    if (!apiBaseUrl) {
      logMobileConnectEvent('resume:auto-connect', {});
      void autoConnectLastInstance();
      return;
    }
    logMobileConnectEvent('resume:reprobe', {});

    const refreshInPlace = () => {
      void initializeApp();
      void refreshSourceControlProviders(apis.sourceControl);
      void refreshSourceControlAuth(apis.sourceControl, { force: true });
      void refreshTrackers(apis.trackers);
      if (providersCount === 0) void loadProviders({ source: 'mobileApp:nativeResume' });
      if (agentsCount === 0) void loadAgents({ source: 'mobileApp:nativeResume' });
    };
    const disconnect = (reason: string) => {
      logMobileConnectEvent('resume:disconnect', { reason });
      switchRuntimeEndpoint({ apiBaseUrl: '', clientToken: null, runtimeKey: MOBILE_DISCONNECTED_RUNTIME_KEY });
      setConnectionEpoch((value) => value + 1);
    };

    void reprobeActiveConnection().then((outcome) => {
      if (nativeResumeValidationSeqRef.current !== validationSeq) return;
      if (outcome === 'no-connection') {
        disconnect('no-connection');
        return;
      }
      if (outcome === 'needs-login') {
        setAutoConnectNotice({ kind: 'auth-expired', label: getAutoConnectTargetLabel() ?? '' });
        disconnect('needs-login');
        return;
      }
      if (outcome === 'relay-limit') {
        setAutoConnectNotice({ kind: 'relay-limit', label: getAutoConnectTargetLabel() ?? '' });
        disconnect('relay-limit');
        return;
      }
      if (outcome === 'unreachable') {
        const retryDelaysMs = [4000, 10000];
        const retryAt = (attempt: number) => {
          window.setTimeout(() => {
            if (nativeResumeValidationSeqRef.current !== validationSeq) return;
            const lastAttempt = attempt === retryDelaysMs.length - 1;
            void reprobeActiveConnection({ fast: !lastAttempt }).then((retry) => {
              if (nativeResumeValidationSeqRef.current !== validationSeq) return;
              if (retry === 'switched') return;
              if (retry === 'unchanged') {
                refreshInPlace();
                return;
              }
              if (retry === 'needs-login') {
                setAutoConnectNotice({ kind: 'auth-expired', label: getAutoConnectTargetLabel() ?? '' });
                disconnect('retry-needs-login');
                return;
              }
              if (retry === 'relay-limit') {
                setAutoConnectNotice({ kind: 'relay-limit', label: getAutoConnectTargetLabel() ?? '' });
                disconnect('retry-relay-limit');
                return;
              }
              if (!lastAttempt) {
                retryAt(attempt + 1);
                return;
              }
              disconnect(`retry-${retry}`);
            });
          }, retryDelaysMs[attempt]);
        };
        retryAt(0);
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
  }, [agentsCount, apis.sourceControl, apis.trackers, initializeApp, loadAgents, loadProviders, providersCount, refreshSourceControlAuth, refreshSourceControlProviders]);

  useNativeMobileChrome();
  useNativeMobileLifecycle(handleNativeResume);

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
    if (!isNativeMobileApp) return;
    return useAuthSessionStore.subscribe((store, previous) => {
      if (store.state === 'expired' && previous.state !== 'expired') {
        handleNativeResume();
        useAuthSessionStore.getState().markAuthenticated();
      }
    });
  }, [isNativeMobileApp, handleNativeResume]);

  React.useEffect(() => {
    if (!isNativeMobileApp) return;
    return subscribeActiveRelayTunnelStatus((status) => {
      if (isRelayLimitReached(status)) handleNativeResume();
    });
  }, [isNativeMobileApp, handleNativeResume]);

  React.useEffect(() => {
    registerRuntimeAPIs(apis);
    return () => registerRuntimeAPIs(null);
  }, [apis]);

  React.useEffect(() => {
    return subscribeRuntimeEndpointChanged((detail) => {
      logMobileConnectEvent('endpoint:changed', {
        runtimeKey: detail.runtimeKey || 'none',
        previousRuntimeKey: detail.previousRuntimeKey || 'none',
        connected: Boolean(detail.apiBaseUrl),
      });
      const sameDevice = Boolean(detail.runtimeKey) && detail.runtimeKey === detail.previousRuntimeKey;
      if (sameDevice) {
        reconnectAppForTransportSwitch();
        bumpTransportSwitch();
        return;
      }
      resetAppForRuntimeEndpointChange(detail);
      setRuntimeEndpointEpoch((epoch) => epoch + 1);
      setConnectionEpoch((epoch) => epoch + 1);
    });
  }, []);

  React.useEffect(() => {
    if (!isNativeMobileApp || isConnected || getRuntimeApiBaseUrl()) {
      setAutoConnectPhase('done');
      return;
    }
    let cancelled = false;
    setAutoConnectPhase('attempting');
    void (async () => {
      const outcome = await autoConnectLastInstance()
        .catch((): AutoConnectOutcome => ({ status: 'no-candidate' }));
      if (cancelled) return;
      if (outcome.status === 'unreachable' || outcome.status === 'relay-limit') {
        setAutoConnectNotice({ kind: outcome.status, label: outcome.label });
      } else if (outcome.status === 'needs-login') {
        setAutoConnectNotice({ kind: 'auth-expired', label: outcome.label });
      }
      setAutoConnectPhase('done');
      if (outcome.status === 'unreachable') {
        void autoConnectLastInstance({ fast: false, skipIfConnected: true }).catch(() => null);
      }
    })();
    return () => {
      cancelled = true;
    };
    // oxlint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  React.useEffect(() => {
    if (!isNativeMobileApp || !getRuntimeApiBaseUrl()) return;
    let cancelled = false;
    const dropToConnectScreen = (notice: MobileConnectionNotice | null) => {
      logMobileConnectEvent('cold-launch:drop', { kind: notice?.kind ?? 'unknown' });
      if (notice) setAutoConnectNotice(notice);
      switchRuntimeEndpoint({ apiBaseUrl: '', clientToken: null, runtimeKey: MOBILE_DISCONNECTED_RUNTIME_KEY });
      setConnectionEpoch((value) => value + 1);
    };
    void reprobeActiveConnection().then(async (outcome) => {
      if (cancelled) return;
      if (outcome === 'switched' || outcome === 'unchanged') return;
      const label = getAutoConnectTargetLabel();
      if (outcome === 'needs-login') {
        dropToConnectScreen({ kind: 'auth-expired', label: label ?? '' });
        return;
      }
      if (outcome === 'unreachable') {
        dropToConnectScreen(label ? { kind: 'unreachable', label } : null);
        void autoConnectLastInstance({ fast: false, skipIfConnected: true }).catch(() => null);
        return;
      }
      if (outcome === 'relay-limit') {
        dropToConnectScreen({ kind: 'relay-limit', label: label ?? '' });
        return;
      }
      const fallback = await autoConnectLastInstance().catch((): AutoConnectOutcome => ({ status: 'no-candidate' }));
      if (cancelled || fallback.status === 'connected') return;
      if (fallback.status === 'needs-login') {
        dropToConnectScreen({ kind: 'auth-expired', label: fallback.label });
      } else if (fallback.status === 'unreachable' || fallback.status === 'relay-limit') {
        dropToConnectScreen({ kind: fallback.status, label: fallback.label });
      } else {
        dropToConnectScreen(null);
      }
    });
    return () => {
      cancelled = true;
    };
    // oxlint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  React.useEffect(() => {
    setIsMobile(true);
  }, [setIsMobile]);

  React.useEffect(() => {
    if (isNativeMobileApp && !getRuntimeApiBaseUrl()) return;
    void initializeApp();
  }, [connectionEpoch, initializeApp, isNativeMobileApp]);

  React.useEffect(() => {
    if (!isConnected) return;
    if (providersCount === 0) void loadProviders({ source: 'mobileApp:recovery' });
    if (agentsCount === 0) void loadAgents({ source: 'mobileApp:recovery' });
  }, [agentsCount, isConnected, loadAgents, loadProviders, providersCount]);

  const lastSessionRestoreDoneRef = React.useRef(false);
  const [lastSessionRestorePending, setLastSessionRestorePending] = React.useState(isNativeMobileApp);
  React.useEffect(() => {
    if (!isNativeMobileApp || !isConnected || lastSessionRestoreDoneRef.current) return;
    let cancelled = false;
    const overlayTimeoutId = window.setTimeout(() => setLastSessionRestorePending(false), 6000);
    const attempt = beginLastSessionRestore({ selectNow: true, refresh: true });
    const showSelectedSession = () => {
      if (useSessionUIStore.getState().currentSessionId) setLastSessionRestorePending(false);
    };
    const stopWatchingSelection = useSessionUIStore.subscribe(showSelectedSession);
    showSelectedSession();
    void (async () => {
      const result = await attempt();
      if (cancelled) return;
      if (result !== 'failed') lastSessionRestoreDoneRef.current = true;
      setLastSessionRestorePending(false);
    })();
    return () => {
      cancelled = true;
      stopWatchingSelection();
      window.clearTimeout(overlayTimeoutId);
    };
  }, [connectionEpoch, isConnected, isNativeMobileApp]);

  React.useEffect(() => {
    if (!isConnected) return;
    opencodeClient.setDirectory(currentDirectory);
  }, [currentDirectory, isConnected]);

  React.useEffect(() => {
    if (!isConnected) return;
    void refreshSourceControlProviders(apis.sourceControl);
    void refreshSourceControlAuth(apis.sourceControl, { force: true });
    void refreshTrackers(apis.trackers);
  }, [apis.sourceControl, apis.trackers, isConnected, refreshSourceControlAuth, refreshSourceControlProviders]);


  React.useEffect(() => {
    if (!error) return;
    const timeout = window.setTimeout(() => clearError(), 5000);
    return () => window.clearTimeout(timeout);
  }, [clearError, error]);

  React.useEffect(() => {
    const waitingOnConnection = !isConnected && (isNativeMobileApp ? Boolean(getRuntimeApiBaseUrl()) : true);
    if (!waitingOnConnection) {
      setShowConnectionRecovery(false);
      return;
    }
    const timeout = window.setTimeout(() => {
      setShowConnectionRecovery(true);
    }, isNativeMobileApp ? 4000 : 8000);
    return () => window.clearTimeout(timeout);
  }, [isConnected, isNativeMobileApp, connectionEpoch, runtimeEndpointEpoch]);

  useAppFontEffects();
  usePushVisibilityBeacon({ enabled: true });
  useUpdatePolling();
  useWindowTitle();
  useRoutingSync();
  useEnterprisePolicySync();
  useSourceControlProviderSync(apis.sourceControl);
  useTrackerProviderSync(apis.trackers);
  useQuotaProviderSync();
  useGuestCatalogSync();
  useGuestMarksSync();
  useBrowserProviderSync();
  useAgentMemorySync(currentDirectory || null);
  useRouter();
  useNativePushRegistration({ enabled: isNativeMobileApp && isConnected });
  useKeepScreenAwake(isConnected);
  useNativeWidgetSync({ enabled: isNativeMobileApp && isConnected && isInitialized });
  useDeepLinkSource({ ready: isNativeMobileApp && isConnected && isInitialized, switchToServer: switchToSavedInstance });
  const fontsReady = useFontsReady();

  const isReconnecting = !isConnected && connectionPhase === 'reconnecting';

  if (!fontsReady) {
    return (
      <main className="flex min-h-dvh items-center justify-center bg-[var(--splash-background,var(--surface-background))] text-foreground">
        <OpenChamberLogo width={120} height={120} isAnimated variant="splash" />
      </main>
    );
  }

  const hasRuntimeEndpoint = Boolean(getRuntimeApiBaseUrl());

  if (isNativeMobileApp && (!hasRuntimeEndpoint || (!isConnected && !isReconnecting))) {
    if (hasRuntimeEndpoint) {
      return (
        <main className="flex min-h-dvh items-center justify-center bg-[var(--splash-background,var(--surface-background))] px-6 text-center text-foreground">
          <div className="flex max-w-sm flex-col items-center gap-4">
            <OpenChamberLogo width={120} height={120} isAnimated={!showConnectionRecovery} variant="splash" />
            {showConnectionRecovery ? (
              <>
                <div className="space-y-2">
                  <h1 className="typography-h3 text-foreground">{t('sessionAuth.error.networkTitle')}</h1>
                  <p className="typography-markdown text-muted-foreground">{t('mobile.connect.recovery.description')}</p>
                </div>
                <Button
                  type="button"
                  variant="outline"
                  onClick={() => {
                    switchRuntimeEndpoint({ apiBaseUrl: '', clientToken: null, runtimeKey: MOBILE_DISCONNECTED_RUNTIME_KEY });
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
    if (autoConnectPhase !== 'done') {
      return (
        <main className="relative flex min-h-dvh items-center justify-center bg-[var(--splash-background,var(--surface-background))] text-foreground">
          <OpenChamberLogo width={120} height={120} isAnimated variant="splash" />
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
    if (!showConnectionRecovery) {
      return (
        <main className="flex min-h-dvh items-center justify-center bg-[var(--splash-background,var(--surface-background))] text-foreground">
          <OpenChamberLogo width={120} height={120} isAnimated variant="splash" />
        </main>
      );
    }
    return (
      <main className="flex min-h-dvh items-center justify-center bg-background px-6 text-center text-foreground">
        <div className="max-w-sm space-y-3">
          <h1 className="typography-h3 text-foreground">{t('sessionAuth.error.networkTitle')}</h1>
          <p className="typography-markdown text-muted-foreground">{t('sessionAuth.error.networkDescription')}</p>
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
              <AppStartupOverlay ready={!isNativeMobileApp || !lastSessionRestorePending} animated />
              <SyncAppEffects backgroundWorkEnabled={isInitialized} />
              <OpenCodeUpdateToast />
              <MobileAppUpdateToast />
              <MobileShell onActiveConnectionDeleted={() => {
                suppressAutoConnectUntilManualConnect();
                switchRuntimeEndpoint({ apiBaseUrl: '', clientToken: null, runtimeKey: MOBILE_DISCONNECTED_RUNTIME_KEY });
                setConnectionEpoch((value) => value + 1);
              }} />
              <AppLinkConfirmDialog />
              <SnippetQuickCreateDialog />
              <GlobalQuestionDialogs />
              <OpenCodeTrustDialog />
              {isolatedSpacesEnabled ? <><SpaceAccessDialog /><SpaceActionsSheet /><SpaceApplyDialog /><SpaceDeleteDialog /><SpaceSetupOutputDialog /></> : null}
              <MobileToaster />
              {isInitialized ? <ConfigUpdateOverlay /> : null}
            </div>
          </TooltipProvider>
        </RuntimeAPIProvider>
      </SyncProvider>
    </ErrorBoundary>
  );
}

export function MobileApp(props: MobileAppProps) {
  const endpoint = React.useSyncExternalStore(
    (notify) => subscribeRuntimeEndpointChanged(() => notify()),
    getRuntimeApiBaseUrl,
    getRuntimeApiBaseUrl,
  );
  return (
    <OpenCodeCompatibilityGate enabled={!isCapacitorMobileApp() || Boolean(endpoint)}>
      <MobileAppContent {...props} />
    </OpenCodeCompatibilityGate>
  );
}
