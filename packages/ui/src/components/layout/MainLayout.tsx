import React from 'react';
import { Header } from './Header';
import { Sidebar } from './Sidebar';
import { SidebarTopBar } from './SidebarTopBar';
import { useSidebarPeek } from './useSidebarPeek';
import { useLayoutAnimationMs } from '@/hooks/useLayoutAnimationMs';
import { TitlebarLeftControls } from './TitlebarLeftControls';
import { ContextPanel } from './ContextPanel';
import { ContextSurfacePanes } from './ContextSurfacePanes';
import { ZoneDropOverlay } from './ZoneDropOverlay';
import { ZoneFitArbiter } from './ZoneFitArbiter';
import { followZonePlacementOfOtherWindows } from './zoneSync';
import { useContextWindowOwner } from '@/hooks/useContextWindowOwner';
import { useContextWindowStore } from '@/lib/contextWindow/store';
import { ContextPanelRail } from './ContextPanelRail';
import { DetachedPanelRail } from './DetachedPanelRail';
import { GuestHosts } from './GuestHosts';
import { PluginPane } from './PluginPane';
import { useGuestPages } from '@/hooks/useGuestSurfaces';
import { subscribeRuntimeEndpointChanged } from '@/lib/runtime-switch';
import { ErrorBoundary } from '../ui/ErrorBoundary';
import { SessionSidebar } from '@/components/session/SessionSidebar';
import { SessionDialogs } from '@/components/session/SessionDialogs';
import { SpaceActionsSheet, SpaceDeleteDialog } from '@/components/session/spaces/SpaceActions';
import { DiffWorkerProvider } from '@/contexts/DiffWorkerProvider';
import { ProjectActionsProvider } from './ProjectActionsProvider';
import { RunAutoFusion } from '@/lib/multirun/autoFusion';

import { useUIStore } from '@/stores/useUIStore';
import { useSessionUIStore } from '@/sync/session-ui-store';
import { useSpacesStore } from '@/lib/spaces/spaces-store';
import { useUpdatePolling } from '@/hooks/useUpdatePolling';
import { useGuestUpdateNotice } from '@/hooks/useGuestUpdateNotice';
import { useTerminalSessionKeepalive } from '@/hooks/useTerminalSessionKeepalive';
import { useDeviceInfo } from '@/lib/device';
import { cn } from '@/lib/utils';
import { useOnDemandComponent } from '@/hooks/useOnDemandComponent';
import { usePaletteShortcuts } from '@/hooks/usePaletteShortcuts';
import { useSessionListSync } from '@/components/session/sidebar/list/useSessionListSync';
import { setChatCovered } from './rightSlot';

import { ChatView } from '@/components/views/ChatView';
import { DiagnosticDialogAvailableContext } from '@/lib/diagnostics/dialog-availability';
import { registerCloseTabTarget } from '@/lib/closeTabTarget';

const loadSettingsWindow = () => import('@/components/views/SettingsWindow').then(m => m.SettingsWindow);

const MotionTuningPanel = import.meta.env.DEV ? React.lazy(() => import('@/components/dev/MotionTuningPanel')) : null;

const loadCommandPalette = () => import('../ui/CommandPalette').then((m) => m.CommandPalette);
const loadHelpDialog = () => import('../ui/HelpDialog').then((m) => m.HelpDialog);
const loadProjectActionsDialog = () => import('./ProjectActionsDialog').then((m) => m.ProjectActionsDialog);
const loadOpenCodeStatusDialog = () => import('../ui/OpenCodeStatusDialog').then((m) => m.OpenCodeStatusDialog);
const loadRunOverview = () => import('@/components/multirun/RunOverview').then((m) => m.RunOverview);
const loadScheduledTasksDialog = () => import('@/components/session/ScheduledTasksDialog').then((m) => m.ScheduledTasksDialog);
const loadArchiveView = () => import('@/components/views/ArchiveView').then((m) => m.ArchiveView);
const loadIntegrationsCatalogView = () => import('@/components/views/IntegrationsCatalogView').then((m) => m.IntegrationsCatalogView);
const loadUsageStatsView = () => import('@/components/views/usage/UsageStatsView').then((m) => m.UsageStatsView);
const loadSourceBoardView = () => import('@/components/sourceBoard/SourceBoardView').then((m) => m.SourceBoardView);
const loadOverviewView = () => import('@/components/overview/OverviewView').then((m) => m.OverviewView);
const loadWorktreesView = () => import('@/components/views/WorktreesView').then((m) => m.WorktreesView);
const loadSpacesView = () => import('@/components/views/SpacesView').then((m) => m.SpacesView);
const loadSpaceAccessDialog = () => import('@/components/session/spaces/SpaceAccessDialog').then((m) => m.SpaceAccessDialog);
const loadSpaceApplyDialog = () => import('@/components/session/spaces/SpaceApplyDialog').then((m) => m.SpaceApplyDialog);
const loadSpaceSetupOutputDialog = () => import('@/components/session/spaces/SpaceSetupOutput').then((m) => m.SpaceSetupOutputDialog);

const closeMainSurfaces = () => useUIStore.getState().closeMainSurfaces();

const OnDemand: React.FC<{
    needed: boolean;
    load: () => Promise<React.ComponentType>;
    onFailure: () => void;
}> = ({ needed, load, onFailure }) => {
    const Component = useOnDemandComponent(needed, load, onFailure);
    return Component ? <Component /> : null;
};

const LeftSidebar = React.memo<{ isMobile: boolean }>(({ isMobile }) => {
    const isSidebarOpen = useUIStore((state) => state.isSidebarOpen);
    const peek = useSidebarPeek({ enabled: !isSidebarOpen && !isMobile, layoutAnimationMs: useLayoutAnimationMs() });
    const [listControlsSlot, setListControlsSlot] = React.useState<HTMLDivElement | null>(null);
    return (
        <Sidebar
            isOpen={isSidebarOpen}
            isMobile={isMobile}
            className="border-border"
            topBar={<SidebarTopBar actionsSlotRef={setListControlsSlot} />}
            peek={peek}
        >
            <SessionSidebar isVisible={isSidebarOpen || peek.state !== false} listControlsSlot={listControlsSlot} />
        </Sidebar>
    );
});
LeftSidebar.displayName = 'LeftSidebar';

export const MainLayout: React.FC = () => {
    useSessionListSync({ isVSCode: false });
    usePaletteShortcuts();
    useTerminalSessionKeepalive();
    const isolatedSpacesEnabled = useUIStore((state) => state.isolatedSpacesEnabled);
    const setIsMobile = useUIStore((state) => state.setIsMobile);
    const isSettingsDialogOpen = useUIStore((state) => state.isSettingsDialogOpen);
    const setSettingsDialogOpen = useUIStore((state) => state.setSettingsDialogOpen);
    const SettingsWindow = useOnDemandComponent(isSettingsDialogOpen, loadSettingsWindow, () => setSettingsDialogOpen(false));
    const isRunOverviewOpen = useUIStore((state) => state.runOverviewKey !== null);
    const isScheduledTasksPageOpen = useUIStore((state) => state.isScheduledTasksDialogOpen);
    const isArchivePageOpen = useUIStore((state) => state.isArchivePageOpen);
    const isIntegrationsCatalogOpen = useUIStore((state) => state.isIntegrationsCatalogOpen);
    const isUsageStatsPageOpen = useUIStore((state) => state.isUsageStatsPageOpen);
    const isSourceBoardOpen = useUIStore((state) => state.isSourceBoardOpen);
    const isOverviewOpen = useUIStore((state) => state.isOverviewOpen);
    const worktreesPageProjectId = useUIStore((state) => state.worktreesPageProjectId);
    const isSpacesPageOpen = useUIStore((state) => state.isolatedSpacesEnabled && state.spacesPageProjectId !== null);
    const isCommandPaletteOpen = useUIStore((state) => state.isCommandPaletteOpen);
    const isHelpDialogOpen = useUIStore((state) => state.isHelpDialogOpen);
    const isProjectActionsDialogOpen = useUIStore((state) => state.isProjectActionsDialogOpen);
    const isOpenCodeStatusDialogOpen = useUIStore((state) => state.isOpenCodeStatusDialogOpen);
    const isSpaceAccessDialogOpen = useSpacesStore((state) => state.accessDialog !== null);
    const isSpaceApplyDialogOpen = useSpacesStore((state) => state.applyDialog !== null);
    const isSpaceSetupOutputDialogOpen = useSpacesStore((state) => state.setupOutputDialog !== null);
    const openGuestPageId = useUIStore((state) => state.openGuestPageId);
    const guestPages = useGuestPages();
    const guestPage = guestPages.find((guest) => guest.id === openGuestPageId);
    React.useEffect(() => {
        if (openGuestPageId && !guestPage) useUIStore.getState().setOpenGuestPage(null);
    }, [openGuestPageId, guestPage]);
    React.useEffect(() => subscribeRuntimeEndpointChanged(() => useUIStore.getState().setOpenGuestPage(null)), []);
    React.useEffect(() => followZonePlacementOfOtherWindows(), []);
    useContextWindowOwner();
    const contextPanelDetached = useContextWindowStore((state) => state.detached);
    const isSurfacePageOpen = isScheduledTasksPageOpen || isArchivePageOpen || isIntegrationsCatalogOpen || isUsageStatsPageOpen || isSourceBoardOpen || isOverviewOpen || Boolean(worktreesPageProjectId) || isSpacesPageOpen || isRunOverviewOpen || Boolean(guestPage);
    const mainRef = React.useRef<HTMLElement | null>(null);
    React.useEffect(() => {
        if (!isSurfacePageOpen) return;
        return registerCloseTabTarget(() => useUIStore.getState().closeMainSurfaces(), mainRef, 1);
    }, [isSurfacePageOpen]);
    React.useLayoutEffect(() => {
        setChatCovered(isSurfacePageOpen);
    }, [isSurfacePageOpen]);
    React.useEffect(() => () => setChatCovered(false), []);

    React.useEffect(() => {
        const closeSurfacePages = () => useUIStore.getState().closeMainSurfaces();
        const unsubscribeSession = useSessionUIStore.subscribe((state, prev) => {
            const sessionSelected = Boolean(state.currentSessionId) && state.currentSessionId !== prev.currentSessionId;
            const draftOpened = Boolean(state.newSessionDraft?.open) && state.newSessionDraft !== prev.newSessionDraft;
            if (sessionSelected || draftOpened) closeSurfacePages();
        });
        return () => {
            unsubscribeSession();
        };
    }, []);
    const { isMobile } = useDeviceInfo();

    useUpdatePolling();
    useGuestUpdateNotice();


    React.useEffect(() => {
        const previous = useUIStore.getState().isMobile;
        if (previous !== isMobile) {
            setIsMobile(isMobile);
        }
    }, [isMobile, setIsMobile]);

    return (
        <DiagnosticDialogAvailableContext.Provider value><DiffWorkerProvider>
            <ProjectActionsProvider>
            <div
                data-page-scroll-lock="true"
                className="main-content-safe-area relative flex h-[100dvh] bg-background"
            >
                <OnDemand needed={isCommandPaletteOpen} load={loadCommandPalette} onFailure={() => useUIStore.getState().setCommandPaletteOpen(false)} />
                <OnDemand needed={isHelpDialogOpen} load={loadHelpDialog} onFailure={() => useUIStore.getState().setHelpDialogOpen(false)} />
                <OnDemand needed={isProjectActionsDialogOpen} load={loadProjectActionsDialog} onFailure={() => useUIStore.getState().setProjectActionsDialogOpen(false)} />
                <OnDemand needed={isOpenCodeStatusDialogOpen} load={loadOpenCodeStatusDialog} onFailure={() => useUIStore.getState().setOpenCodeStatusDialogOpen(false)} />
                <RunAutoFusion />
                <SessionDialogs />
                {isolatedSpacesEnabled ? (
                    <>
                        <OnDemand needed={isSpaceAccessDialogOpen} load={loadSpaceAccessDialog} onFailure={() => useSpacesStore.getState().closeAccessDialog()} />
                        <SpaceActionsSheet />
                        <OnDemand needed={isSpaceApplyDialogOpen} load={loadSpaceApplyDialog} onFailure={() => useSpacesStore.getState().closeApplyDialog()} />
                        <SpaceDeleteDialog />
                        <OnDemand needed={isSpaceSetupOutputDialogOpen} load={loadSpaceSetupOutputDialog} onFailure={() => useSpacesStore.getState().closeSetupOutputDialog()} />
                    </>
                ) : null}

                <TitlebarLeftControls />
                <div className="flex flex-1 overflow-hidden" data-page-scroll-lock="true">
                    <LeftSidebar isMobile={isMobile} />
                    <div className="relative flex flex-1 min-w-0 flex-col overflow-hidden bg-background" data-page-scroll-lock="true">
                        <Header />
                        <div className="relative flex flex-1 min-h-0 overflow-hidden bg-background" data-page-scroll-lock="true">
                            <div className="relative flex flex-1 min-w-0 flex-col overflow-hidden bg-background" data-page-scroll-lock="true">
                                <div className="relative flex flex-1 min-h-0 overflow-hidden" data-page-scroll-lock="true" data-workspace-row="true">
                                    {contextPanelDetached ? null : <ContextPanel zone="left" />}
                                    <div className="relative flex flex-1 min-h-0 min-w-0 overflow-hidden" data-page-scroll-lock="true" data-chat-area="true">
                                        <div className="relative flex min-h-0 min-w-0 flex-1 flex-col overflow-hidden" data-workspace-chat="true">
                                        <main ref={mainRef} className="min-h-0 flex-1 overflow-hidden bg-background relative" data-page-scroll-lock="true">
                                            <div className={cn('absolute inset-0', isSurfacePageOpen && 'invisible')}>
                                                <ErrorBoundary><ChatView active={!isSettingsDialogOpen && !isSurfacePageOpen} /></ErrorBoundary>
                                            </div>
                                            <ErrorBoundary><OnDemand needed={isRunOverviewOpen} load={loadRunOverview} onFailure={closeMainSurfaces} /></ErrorBoundary>
                                            <ErrorBoundary><OnDemand needed={isScheduledTasksPageOpen} load={loadScheduledTasksDialog} onFailure={closeMainSurfaces} /></ErrorBoundary>
                                            <ErrorBoundary><OnDemand needed={isArchivePageOpen} load={loadArchiveView} onFailure={closeMainSurfaces} /></ErrorBoundary>
                                            <ErrorBoundary><OnDemand needed={isIntegrationsCatalogOpen} load={loadIntegrationsCatalogView} onFailure={closeMainSurfaces} /></ErrorBoundary>
                                            {isUsageStatsPageOpen && (
                                                <div className="absolute inset-0 z-10 bg-background">
                                                    <ErrorBoundary><OnDemand needed load={loadUsageStatsView} onFailure={closeMainSurfaces} /></ErrorBoundary>
                                                </div>
                                            )}
                                            <OnDemand needed={isSourceBoardOpen} load={loadSourceBoardView} onFailure={closeMainSurfaces} />
                                            <ErrorBoundary><OnDemand needed={isOverviewOpen} load={loadOverviewView} onFailure={closeMainSurfaces} /></ErrorBoundary>
                                            <ErrorBoundary><OnDemand needed={Boolean(worktreesPageProjectId)} load={loadWorktreesView} onFailure={closeMainSurfaces} /></ErrorBoundary>
                                            {isSpacesPageOpen ? <ErrorBoundary><OnDemand needed load={loadSpacesView} onFailure={closeMainSurfaces} /></ErrorBoundary> : null}
                                            {guestPage && <div className="absolute inset-0 z-10 bg-background">
                                                <ErrorBoundary><PluginPane mode={`plugin:${guestPage.id}`} surface="page" item={null}
                                                    onDismiss={() => useUIStore.getState().setOpenGuestPage(null)} /></ErrorBoundary>
                                            </div>}
                                        </main>
                                        {contextPanelDetached ? null : <ContextPanel zone="bottom" />}
                                        </div>
                                        <ContextPanel zone="right" />
                                        {contextPanelDetached ? null : (
                                            <>
                                                <ContextSurfacePanes />
                                                <ZoneDropOverlay />
                                                <ZoneFitArbiter />
                                            </>
                                        )}
                                    </div>
                                </div>
                            </div>
                            <div data-page-scroll-lock="true">
                                <ErrorBoundary>{contextPanelDetached ? <DetachedPanelRail /> : <ContextPanelRail />}</ErrorBoundary>
                            </div>
                            <ErrorBoundary><GuestHosts /></ErrorBoundary>
                        </div>
                    </div>
                </div>

                {SettingsWindow ? (
                    <SettingsWindow
                        open={isSettingsDialogOpen}
                        onOpenChange={setSettingsDialogOpen}
                    />
                ) : null}
                {MotionTuningPanel ? (
                    <React.Suspense fallback={null}><MotionTuningPanel /></React.Suspense>
                ) : null}
            </div>
            </ProjectActionsProvider>
        </DiffWorkerProvider></DiagnosticDialogAvailableContext.Provider>
    );
};
