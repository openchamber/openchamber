import React from 'react';
import { Header } from './Header';
import { Sidebar } from './Sidebar';
import { SidebarTopBar } from './SidebarTopBar';
import { TitlebarLeftControls } from './TitlebarLeftControls';
import { ContextPanel } from './ContextPanel';
import { ContextPanelRail } from './ContextPanelRail';
import { ErrorBoundary } from '../ui/ErrorBoundary';
import { CommandPalette } from '../ui/CommandPalette';
import { HelpDialog } from '../ui/HelpDialog';
import { OpenCodeStatusDialog } from '../ui/OpenCodeStatusDialog';
import { SessionSidebar } from '@/components/session/SessionSidebar';
import { SessionDialogs } from '@/components/session/SessionDialogs';
import { SessionWorktreeMoveConfirmDialog } from '@/components/session/sidebar/SessionWorktreeMoveConfirmDialog';
import { ScheduledTasksDialog } from '@/components/session/ScheduledTasksDialog';
import { ArchiveView } from '@/components/views/ArchiveView';
import { WorktreesView } from '@/components/views/WorktreesView';
import { DiffWorkerProvider } from '@/contexts/DiffWorkerProvider';
import { MultiRunLauncher } from '@/components/multirun';

import { useUIStore } from '@/stores/useUIStore';
import { useSessionUIStore } from '@/sync/session-ui-store';
import {
  cancelSessionTreeMove,
  confirmSessionTreeMove,
  useSessionTreeMoveConfirmation,
} from '@/lib/worktrees/sessionWorktreeMove';
import { useUpdatePolling } from '@/hooks/useUpdatePolling';
import { useDeviceInfo } from '@/lib/device';
import { cn } from '@/lib/utils';
import { lazyWithChunkRecovery } from '@/lib/chunkLoadRecovery';
import { useSessionListSync } from '@/components/session/sidebar/list/useSessionListSync';

import { ChatView } from '@/components/views/ChatView';

const SettingsWindow = lazyWithChunkRecovery(() => import('@/components/views/SettingsWindow').then(m => ({ default: m.SettingsWindow })));

/**
 * Desktop-surface layout: the chat owns the main area, and every other
 * surface (git, diff, files, terminal, ...) opens in the ContextPanel via the
 * rail. Phone-sized viewports run the separate MobileApp shell — a viewport
 * crossing the threshold reloads into it (see watchHostedSurfaceViewport).
 */
export const MainLayout: React.FC = () => {
    useSessionListSync({ isVSCode: false });
    const isSidebarOpen = useUIStore((state) => state.isSidebarOpen);
    const setIsMobile = useUIStore((state) => state.setIsMobile);
    const isSettingsDialogOpen = useUIStore((state) => state.isSettingsDialogOpen);
    const setSettingsDialogOpen = useUIStore((state) => state.setSettingsDialogOpen);
    // Mount the windowed settings dialog only after its first open: rendering
    // the lazy component (even closed) makes React fetch the SettingsView
    // chunk graph (CodeMirror editor, vim mode, theme tooling) on startup.
    // Once opened it stays mounted so the close animation and state behave as
    // before.
    const [settingsWindowMounted, setSettingsWindowMounted] = React.useState(false);
    React.useEffect(() => {
        if (isSettingsDialogOpen) {
            setSettingsWindowMounted(true);
        }
    }, [isSettingsDialogOpen]);
    const isMultiRunLauncherOpen = useUIStore((state) => state.isMultiRunLauncherOpen);
    const setMultiRunLauncherOpen = useUIStore((state) => state.setMultiRunLauncherOpen);
    const multiRunLauncherPrefillPrompt = useUIStore((state) => state.multiRunLauncherPrefillPrompt);
    const isScheduledTasksPageOpen = useUIStore((state) => state.isScheduledTasksDialogOpen);
    const isArchivePageOpen = useUIStore((state) => state.isArchivePageOpen);
    const worktreesPageProjectId = useUIStore((state) => state.worktreesPageProjectId);
    // Any full-page surface replacing the chat area. While open, the chat is
    // fully hidden (not just covered) so none of its floating chrome bleeds
    // through, and selecting a session or draft anywhere closes the surface.
    const isSurfacePageOpen = isScheduledTasksPageOpen || isArchivePageOpen || Boolean(worktreesPageProjectId) || isMultiRunLauncherOpen;

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

    const sessionTreeMoveConfirmation = useSessionTreeMoveConfirmation();

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
                <SessionDialogs />
                <SessionWorktreeMoveConfirmDialog
                    value={sessionTreeMoveConfirmation}
                    onMoveSessionOnly={() => confirmSessionTreeMove(false)}
                    onMoveAllChanges={() => confirmSessionTreeMove(true)}
                    onCancel={cancelSessionTreeMove}
                />

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
                                            {isMultiRunLauncherOpen && (
                                                <div className="absolute inset-0 z-10 bg-background">
                                                    <ErrorBoundary>
                                                        {/* isWindowed: the app Header already shows the surface
                                                            title, so skip the launcher's own title bar. */}
                                                        <MultiRunLauncher
                                                            isWindowed
                                                            initialPrompt={multiRunLauncherPrefillPrompt}
                                                            onCreated={() => setMultiRunLauncherOpen(false)}
                                                            onCancel={() => setMultiRunLauncherOpen(false)}
                                                        />
                                                    </ErrorBoundary>
                                                </div>
                                            )}
                                            <ErrorBoundary><ScheduledTasksDialog /></ErrorBoundary>
                                            <ErrorBoundary><ArchiveView /></ErrorBoundary>
                                            <ErrorBoundary><WorktreesView /></ErrorBoundary>
                                        </main>
                                        <ContextPanel />
                                    </div>
                                </div>
                            </div>
                            <div className="border-t border-border" data-page-scroll-lock="true">
                                <ErrorBoundary><ContextPanelRail /></ErrorBoundary>
                            </div>
                        </div>
                    </div>
                </div>

                {/* Settings: windowed dialog with blur */}
                {settingsWindowMounted ? (
                    <React.Suspense fallback={null}>
                        <SettingsWindow
                            open={isSettingsDialogOpen}
                            onOpenChange={setSettingsDialogOpen}
                        />
                    </React.Suspense>
                ) : null}
            </div>
        </DiffWorkerProvider>
    );
};
