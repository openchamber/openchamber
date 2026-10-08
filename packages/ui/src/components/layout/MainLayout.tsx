import React from 'react';
import { Header } from './Header';
import { Sidebar } from './Sidebar';
import { SidebarTopBar } from './SidebarTopBar';
import { TitlebarLeftControls } from './TitlebarLeftControls';
import { ContextPanel } from './ContextPanel';
import { ContextPanelRail } from './ContextPanelRail';
import { GuestHosts } from './GuestHosts';
import { PluginPane } from './PluginPane';
import { useGuestPages } from '@/hooks/useGuestSurfaces';
import { subscribeRuntimeEndpointChanged } from '@/lib/runtime-switch';
import { ErrorBoundary } from '../ui/ErrorBoundary';
import { CommandPalette } from '../ui/CommandPalette';
import { HelpDialog } from '../ui/HelpDialog';
import { OpenCodeStatusDialog } from '../ui/OpenCodeStatusDialog';
import { SessionSidebar } from '@/components/session/SessionSidebar';
import { SessionDialogs } from '@/components/session/SessionDialogs';
import { ScheduledTasksDialog } from '@/components/session/ScheduledTasksDialog';
import { SourceBoardView } from '@/components/sourceBoard/SourceBoardView';
import { SpaceAccessDialog } from '@/components/session/spaces/SpaceAccessDialog';
import { SpaceActionsSheet, SpaceDeleteDialog } from '@/components/session/spaces/SpaceActions';
import { SpaceApplyDialog } from '@/components/session/spaces/SpaceApplyDialog';
import { SpaceSetupOutputDialog } from '@/components/session/spaces/SpaceSetupOutput';
import { ArchiveView } from '@/components/views/ArchiveView';
import { WorktreesView } from '@/components/views/WorktreesView';
import { SpacesView } from '@/components/views/SpacesView';
import { UsageStatsView } from '@/components/views/usage/UsageStatsView';
import { DiffWorkerProvider } from '@/contexts/DiffWorkerProvider';
import { RunOverview } from '@/components/multirun/RunOverview';
import { RunAutoFusion } from '@/lib/multirun/autoFusion';

import { useUIStore } from '@/stores/useUIStore';
import { useSessionUIStore } from '@/sync/session-ui-store';
import { useUpdatePolling } from '@/hooks/useUpdatePolling';
import { useTerminalSessionKeepalive } from '@/hooks/useTerminalSessionKeepalive';
import { useDeviceInfo } from '@/lib/device';
import { cn } from '@/lib/utils';
import { useOnDemandComponent } from '@/hooks/useOnDemandComponent';
import { useSessionListSync } from '@/components/session/sidebar/list/useSessionListSync';

import { ChatView } from '@/components/views/ChatView';

const loadSettingsWindow = () => import('@/components/views/SettingsWindow').then(m => m.SettingsWindow);

/**
 * Desktop-surface layout: the chat owns the main area, and every other
 * surface (git, diff, files, terminal, ...) opens in the ContextPanel via the
 * rail. Phone-sized viewports run the separate MobileApp shell — a viewport
 * crossing the threshold reloads into it (see watchHostedSurfaceViewport).
 */
export const MainLayout: React.FC = () => {
    useSessionListSync({ isVSCode: false });
    useTerminalSessionKeepalive();
    const isSidebarOpen = useUIStore((state) => state.isSidebarOpen);
    // The grant dialog of isolated spaces; the main layout is never VS Code's (decision 16).
    const isolatedSpacesEnabled = useUIStore((state) => state.isolatedSpacesEnabled);
    const setIsMobile = useUIStore((state) => state.setIsMobile);
    const isSettingsDialogOpen = useUIStore((state) => state.isSettingsDialogOpen);
    const setSettingsDialogOpen = useUIStore((state) => state.setSettingsDialogOpen);
    // Load the windowed settings dialog on its first open: its chunk graph
    // (CodeMirror editor, vim mode, theme tooling) stays off startup. Once
    // loaded it stays mounted so the close animation and state behave as
    // before. A failed load closes the dialog so the next click tries again.
    const SettingsWindow = useOnDemandComponent(isSettingsDialogOpen, loadSettingsWindow, () => setSettingsDialogOpen(false));
    const isRunOverviewOpen = useUIStore((state) => state.runOverviewKey !== null);
    const isScheduledTasksPageOpen = useUIStore((state) => state.isScheduledTasksDialogOpen);
    const isArchivePageOpen = useUIStore((state) => state.isArchivePageOpen);
    const isUsageStatsPageOpen = useUIStore((state) => state.isUsageStatsPageOpen);
    const isSourceBoardOpen = useUIStore((state) => state.isSourceBoardOpen);
    const worktreesPageProjectId = useUIStore((state) => state.worktreesPageProjectId);
    // The spaces page exists only while the feature's switch is on.
    const isSpacesPageOpen = useUIStore((state) => state.isolatedSpacesEnabled && state.spacesPageProjectId !== null);
    const openGuestPageId = useUIStore((state) => state.openGuestPageId);
    const guestPages = useGuestPages();
    const guestPage = guestPages.find((guest) => guest.id === openGuestPageId);
    React.useEffect(() => {
        if (openGuestPageId && !guestPage) useUIStore.getState().setOpenGuestPage(null);
    }, [openGuestPageId, guestPage]);
    React.useEffect(() => subscribeRuntimeEndpointChanged(() => useUIStore.getState().setOpenGuestPage(null)), []);
    // Any full-page surface replacing the chat area. While open, the chat is
    // fully hidden (not just covered) so none of its floating chrome bleeds
    // through, and selecting a session or draft anywhere closes the surface.
    const isSurfacePageOpen = isScheduledTasksPageOpen || isArchivePageOpen || isUsageStatsPageOpen || isSourceBoardOpen || Boolean(worktreesPageProjectId) || isSpacesPageOpen || isRunOverviewOpen || Boolean(guestPage);

    React.useEffect(() => {
        const closeSurfacePages = () => useUIStore.getState().closeMainSurfaces();
        const unsubscribeSession = useSessionUIStore.subscribe((state, prev) => {
            const sessionSelected = Boolean(state.currentSessionId) && state.currentSessionId !== prev.currentSessionId;
            // Draft identity change covers re-opening a draft while one is
            // already open (the boolean alone never transitions then).
            const draftOpened = Boolean(state.newSessionDraft?.open) && state.newSessionDraft !== prev.newSessionDraft;
            if (sessionSelected || draftOpened) closeSurfacePages();
        });
        return () => {
            unsubscribeSession();
        };
    }, []);
    const { isMobile } = useDeviceInfo();

    useUpdatePolling();


    React.useEffect(() => {
        const previous = useUIStore.getState().isMobile;
        if (previous !== isMobile) {
            setIsMobile(isMobile);
        }
    }, [isMobile, setIsMobile]);

    return (
        <DiffWorkerProvider>
            <div
                data-page-scroll-lock="true"
                className="main-content-safe-area relative flex h-[100dvh] bg-background"
            >
                <CommandPalette />
                <HelpDialog />
                <OpenCodeStatusDialog />
                <RunAutoFusion />
                <SessionDialogs />
                {isolatedSpacesEnabled ? <><SpaceAccessDialog /><SpaceActionsSheet /><SpaceApplyDialog /><SpaceDeleteDialog /><SpaceSetupOutputDialog /></> : null}

                {/* Persistent top-left controls (toggle + project actions) that
                    stay put while the sidebar/header animate beneath them. */}
                <TitlebarLeftControls />
                {/* Full-height Sidebar beside [Header above (chat | RightSidebar)] */}
                <div className="flex flex-1 overflow-hidden" data-page-scroll-lock="true">
                    <Sidebar
                        isOpen={isSidebarOpen}
                        isMobile={isMobile}
                        className="border-border"
                        topBar={<SidebarTopBar />}
                    >
                        <SessionSidebar isVisible={isSidebarOpen} />
                    </Sidebar>
                    <div className="relative flex flex-1 min-w-0 flex-col overflow-hidden bg-background" data-page-scroll-lock="true">
                        <Header />
                        <div className="relative flex flex-1 min-h-0 overflow-hidden bg-background" data-page-scroll-lock="true">
                            <div className="relative flex flex-1 min-w-0 flex-col overflow-hidden border-t border-border bg-background" data-page-scroll-lock="true">
                                <div className="flex flex-1 min-h-0 overflow-hidden" data-page-scroll-lock="true">
                                    {/* Holds the chat and the context panel together, so its
                                        width does not move when the context panel opens. The
                                        work-status panel measures this rather than the chat,
                                        which the context panel animates. */}
                                    <div className="relative flex flex-1 min-h-0 min-w-0 overflow-hidden" data-page-scroll-lock="true" data-chat-area="true">
                                        <main className="flex-1 overflow-hidden bg-background relative" data-page-scroll-lock="true">
                                            <div className={cn('absolute inset-0', isSurfacePageOpen && 'invisible')}>
                                                <ErrorBoundary><ChatView active={!isSettingsDialogOpen && !isSurfacePageOpen} /></ErrorBoundary>
                                            </div>
                                            <ErrorBoundary><RunOverview /></ErrorBoundary>
                                            <ErrorBoundary><ScheduledTasksDialog /></ErrorBoundary>
                                            <ErrorBoundary><ArchiveView /></ErrorBoundary>
                                            {isUsageStatsPageOpen && (
                                                <div className="absolute inset-0 z-10 bg-background">
                                                    <ErrorBoundary><UsageStatsView /></ErrorBoundary>
                                                </div>
                                            )}
                                            <SourceBoardView />
                                            <ErrorBoundary><WorktreesView /></ErrorBoundary>
                                            {isSpacesPageOpen ? <ErrorBoundary><SpacesView /></ErrorBoundary> : null}
                                            {guestPage && <div className="absolute inset-0 z-10 bg-background">
                                                <ErrorBoundary><PluginPane mode={`plugin:${guestPage.id}`} surface="page" item={null}
                                                    onDismiss={() => useUIStore.getState().setOpenGuestPage(null)} /></ErrorBoundary>
                                            </div>}
                                        </main>
                                        <ContextPanel />
                                    </div>
                                </div>
                            </div>
                            <div className="border-t border-border" data-page-scroll-lock="true">
                                <ErrorBoundary><ContextPanelRail /></ErrorBoundary>
                            </div>
                            <ErrorBoundary><GuestHosts /></ErrorBoundary>
                        </div>
                    </div>
                </div>

                {/* Settings: windowed dialog with blur */}
                {SettingsWindow ? (
                    <SettingsWindow
                        open={isSettingsDialogOpen}
                        onOpenChange={setSettingsDialogOpen}
                    />
                ) : null}
            </div>
        </DiffWorkerProvider>
    );
};
