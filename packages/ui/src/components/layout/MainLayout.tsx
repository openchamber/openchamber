import React, { useRef, useEffect } from 'react';
import { animate, motion, useMotionValue } from 'motion/react';
import { Header } from './Header';
import { BottomTerminalDock } from './BottomTerminalDock';
import { Sidebar } from './Sidebar';
import { SidebarTopBar } from './SidebarTopBar';
import { TitlebarLeftControls } from './TitlebarLeftControls';
import { RightSidebar } from './RightSidebar';
import { ProjectContextPanel, RightSidebarTabs } from './RightSidebarTabs';
import { ContextPanel } from './ContextPanel';
import { ErrorBoundary } from '../ui/ErrorBoundary';
import { CommandPalette } from '../ui/CommandPalette';
import { HelpDialog } from '../ui/HelpDialog';
import { OpenCodeStatusDialog } from '../ui/OpenCodeStatusDialog';
import { SessionSidebar } from '@/components/session/SessionSidebar';
import { SessionDialogs } from '@/components/session/SessionDialogs';
import { DiffWorkerProvider } from '@/contexts/DiffWorkerProvider';
import { MultiRunLauncher } from '@/components/multirun';
import { TerminalView } from '@/components/views/TerminalView';
import { DrawerProvider } from '@/contexts/DrawerContext';

import { useUIStore } from '@/stores/useUIStore';
import { useSessionUIStore } from '@/sync/session-ui-store';
import { useUpdatePolling } from '@/hooks/useUpdatePolling';
import { useDeviceInfo } from '@/lib/device';
import { cn } from '@/lib/utils';
import { lazyWithChunkRecovery } from '@/lib/chunkLoadRecovery';

import { ChatView } from '@/components/views/ChatView';
import { DiffView } from '@/components/views/DiffView';
import { FilesView } from '@/components/views/FilesView';
import { GitView } from '@/components/views/GitView';
import { PlanView } from '@/components/views/PlanView';

// Keep TerminalView eager: the bottom dock reserves its height immediately, so
// suspending here leaves a large blank panel on slower machines.
// Other heavy views stay on-demand to reduce initial bundle parse time.
const DiagramView = lazyWithChunkRecovery(() => import('@/components/views/DiagramView').then(m => ({ default: m.DiagramView })));
const SettingsView = lazyWithChunkRecovery(() => import('@/components/views/SettingsView').then(m => ({ default: m.SettingsView })));
const SettingsWindow = lazyWithChunkRecovery(() => import('@/components/views/SettingsWindow').then(m => ({ default: m.SettingsWindow })));
const MultiRunWindow = lazyWithChunkRecovery(() => import('@/components/views/MultiRunWindow').then(m => ({ default: m.MultiRunWindow })));

export const MainLayout: React.FC = () => {
    const RIGHT_SIDEBAR_AUTO_CLOSE_WIDTH = 1140;
    const RIGHT_SIDEBAR_AUTO_OPEN_WIDTH = 1220;
    const BOTTOM_TERMINAL_AUTO_CLOSE_HEIGHT = 640;
    const BOTTOM_TERMINAL_AUTO_OPEN_HEIGHT = 700;
    const isSidebarOpen = useUIStore((state) => state.isSidebarOpen);
    const isRightSidebarOpen = useUIStore((state) => state.isRightSidebarOpen);
    const isBottomTerminalOpen = useUIStore((state) => state.isBottomTerminalOpen);
    const setRightSidebarOpen = useUIStore((state) => state.setRightSidebarOpen);
    const setBottomTerminalOpen = useUIStore((state) => state.setBottomTerminalOpen);
    const activeMainTab = useUIStore((state) => state.activeMainTab);
    const setIsMobile = useUIStore((state) => state.setIsMobile);
    const isSessionSwitcherOpen = useUIStore((state) => state.isSessionSwitcherOpen);
    const isSettingsDialogOpen = useUIStore((state) => state.isSettingsDialogOpen);
    const setSettingsDialogOpen = useUIStore((state) => state.setSettingsDialogOpen);
    const isMultiRunLauncherOpen = useUIStore((state) => state.isMultiRunLauncherOpen);
    const setMultiRunLauncherOpen = useUIStore((state) => state.setMultiRunLauncherOpen);
    const multiRunLauncherPrefillPrompt = useUIStore((state) => state.multiRunLauncherPrefillPrompt);
    const { isMobile, isTablet } = useDeviceInfo();
    const rightSidebarAutoClosedRef = React.useRef(false);
    const bottomTerminalAutoClosedRef = React.useRef(false);
    const mobilePanelsResetRef = React.useRef(false);

    // Mobile drawer state
    const [mobileLeftDrawerOpen, setMobileLeftDrawerOpen] = React.useState(false);
    const [mobileRightSidebarOpen, setMobileRightSidebarOpen] = React.useState(false);
    const [mobileLeftDrawerVisible, setMobileLeftDrawerVisible] = React.useState(false);
    const [mobileRightDrawerVisible, setMobileRightDrawerVisible] = React.useState(false);
    const setMobileSessionPanelOpen = React.useCallback((open: boolean) => {
        setMobileLeftDrawerOpen(open);
        useUIStore.getState().setSessionSwitcherOpen(open);
    }, []);
    const mobileRightDrawerOpenRef = React.useRef(false);
    const initialDrawerWidthRef = React.useRef(typeof window === 'undefined' ? 0 : window.innerWidth);

    // Left drawer motion value
    const leftDrawerX = useMotionValue(-initialDrawerWidthRef.current);
    const leftDrawerWidth = useRef(0);

    // Right drawer motion value
    const rightDrawerX = useMotionValue(initialDrawerWidthRef.current);
    const rightDrawerWidth = useRef(0);

    // Compute drawer width
    useEffect(() => {
        if (isMobile) {
            leftDrawerWidth.current = window.innerWidth;
            rightDrawerWidth.current = window.innerWidth;
        }
    }, [isMobile]);

    // Sync left drawer state and motion value
    useEffect(() => {
        if (!isMobile) {
            setMobileLeftDrawerVisible(false);
            return;
        }
        if (mobileLeftDrawerOpen) {
            setMobileLeftDrawerVisible(true);
        }
        animate(leftDrawerX, mobileLeftDrawerOpen ? 0 : -leftDrawerWidth.current, {
            type: 'spring',
            stiffness: 400,
            damping: 35,
            mass: 0.8,
        });
    }, [mobileLeftDrawerOpen, isMobile, leftDrawerX]);

    // Sync right drawer state and motion value
    useEffect(() => {
        if (!isMobile) {
            setMobileRightDrawerVisible(false);
            return;
        }
        mobileRightDrawerOpenRef.current = mobileRightSidebarOpen;
        if (mobileRightSidebarOpen) {
            setMobileRightDrawerVisible(true);
        }
        animate(rightDrawerX, mobileRightSidebarOpen ? 0 : rightDrawerWidth.current, {
            type: 'spring',
            stiffness: 400,
            damping: 35,
            mass: 0.8,
        });
    }, [isMobile, mobileRightSidebarOpen, rightDrawerX]);

    useEffect(() => {
        if (!isMobile) return;
        return leftDrawerX.on('change', (value) => {
            const width = leftDrawerWidth.current || initialDrawerWidthRef.current;
            const visible = mobileLeftDrawerOpen || value > -width + 0.5;
            setMobileLeftDrawerVisible((previous) => previous === visible ? previous : visible);
        });
    }, [isMobile, leftDrawerX, mobileLeftDrawerOpen]);

    useEffect(() => {
        if (!isMobile) return;
        return rightDrawerX.on('change', (value) => {
            const width = rightDrawerWidth.current || initialDrawerWidthRef.current;
            const visible = mobileRightSidebarOpen || value < width - 0.5;
            setMobileRightDrawerVisible((previous) => previous === visible ? previous : visible);
        });
    }, [isMobile, mobileRightSidebarOpen, rightDrawerX]);

    // Sync session switcher close events to left drawer.
    useEffect(() => {
        if (isMobile && !isSessionSwitcherOpen && mobileLeftDrawerOpen) {
            setMobileSessionPanelOpen(false);
        }
    }, [isSessionSwitcherOpen, isMobile, mobileLeftDrawerOpen, setMobileSessionPanelOpen]);

    useEffect(() => {
        if (!isMobile) {
            mobilePanelsResetRef.current = false;
            return;
        }

        if (mobilePanelsResetRef.current) {
            return;
        }

        mobilePanelsResetRef.current = true;
        setMobileSessionPanelOpen(false);
        setMobileRightSidebarOpen(false);
        if (useUIStore.getState().isRightSidebarOpen) {
            setRightSidebarOpen(false);
        }
    }, [isMobile, setMobileSessionPanelOpen, setRightSidebarOpen]);

    useEffect(() => {
        if (!isMobile || activeMainTab !== 'chat' || mobileLeftDrawerOpen || mobileRightSidebarOpen || isSettingsDialogOpen) {
            return;
        }

        let disposed = false;
        let timeoutId: number | undefined;

        const scheduleDraftOpen = (delayMs: number) => {
            timeoutId = window.setTimeout(() => {
                if (disposed) {
                    return;
                }

                const sessionState = useSessionUIStore.getState();
                const uiState = useUIStore.getState();
                if (uiState.activeMainTab !== 'chat' || uiState.isSettingsDialogOpen || sessionState.currentSessionId || sessionState.newSessionDraft?.open) {
                    return;
                }

                if (sessionState.isLoading) {
                    scheduleDraftOpen(250);
                    return;
                }

                sessionState.openNewSessionDraft();
            }, delayMs);
        };

        scheduleDraftOpen(500);

        return () => {
            disposed = true;
            if (timeoutId !== undefined) {
                window.clearTimeout(timeoutId);
            }
        };
    }, [activeMainTab, isMobile, isSettingsDialogOpen, mobileLeftDrawerOpen, mobileRightSidebarOpen]);

    // Ensure mobile drawers are closed when opening full-screen settings
    useEffect(() => {
        if (!isMobile || !isSettingsDialogOpen) {
            return;
        }

        setMobileSessionPanelOpen(false);
        setMobileRightSidebarOpen(false);
        if (isRightSidebarOpen) {
            setRightSidebarOpen(false);
        }
    }, [isMobile, isSettingsDialogOpen, isRightSidebarOpen, setMobileSessionPanelOpen, setRightSidebarOpen]);

    useUpdatePolling();

    React.useEffect(() => {
        const previous = useUIStore.getState().isMobile;
        if (previous !== isMobile) {
            setIsMobile(isMobile);
        }
    }, [isMobile, setIsMobile]);

    React.useEffect(() => {
        if (typeof window === 'undefined') {
            return;
        }

        let frameId: number | undefined;

        const handleResize = () => {
            if (frameId !== undefined) {
                return;
            }
            frameId = window.requestAnimationFrame(() => {
                frameId = undefined;
                useUIStore.getState().updateProportionalSidebarWidths();
            });
        };

        window.addEventListener('resize', handleResize);

        return () => {
            window.removeEventListener('resize', handleResize);
            if (frameId !== undefined) {
                window.cancelAnimationFrame(frameId);
            }
        };
    }, []);

    React.useEffect(() => {
        if (typeof window === 'undefined') {
            return;
        }

        let frameId: number | undefined;

        const handleResponsivePanels = () => {
            const state = useUIStore.getState();
            const width = window.innerWidth;
            const height = window.innerHeight;

            // Touch devices frequently resize when the on-screen keyboard opens.
            // Treat panel auto-collapse/restore as desktop-only so keyboard
            // viewport changes do not churn drawer or terminal layout state.
            if (!isMobile && !isTablet) {
                const shouldCloseRightSidebar = width < RIGHT_SIDEBAR_AUTO_CLOSE_WIDTH;
                const canAutoOpenRightSidebar = width >= RIGHT_SIDEBAR_AUTO_OPEN_WIDTH;

                if (shouldCloseRightSidebar) {
                    if (state.isRightSidebarOpen) {
                        setRightSidebarOpen(false);
                        rightSidebarAutoClosedRef.current = true;
                    }
                } else if (canAutoOpenRightSidebar && rightSidebarAutoClosedRef.current) {
                    setRightSidebarOpen(true);
                    rightSidebarAutoClosedRef.current = false;
                }

                const shouldCloseBottomTerminal =
                    height < BOTTOM_TERMINAL_AUTO_CLOSE_HEIGHT;
                const canAutoOpenBottomTerminal =
                    height >= BOTTOM_TERMINAL_AUTO_OPEN_HEIGHT;

                if (shouldCloseBottomTerminal) {
                    if (state.isBottomTerminalOpen) {
                        setBottomTerminalOpen(false);
                        bottomTerminalAutoClosedRef.current = true;
                    }
                } else if (canAutoOpenBottomTerminal && bottomTerminalAutoClosedRef.current) {
                    setBottomTerminalOpen(true);
                    bottomTerminalAutoClosedRef.current = false;
                }
            }
        };

        const handleResize = () => {
            if (frameId !== undefined) {
                return;
            }
            frameId = window.requestAnimationFrame(() => {
                frameId = undefined;
                handleResponsivePanels();
            });
        };

        handleResponsivePanels();
        window.addEventListener('resize', handleResize);

        return () => {
            window.removeEventListener('resize', handleResize);
            if (frameId !== undefined) {
                window.cancelAnimationFrame(frameId);
            }
        };
    }, [isMobile, isTablet, setBottomTerminalOpen, setRightSidebarOpen]);

    React.useEffect(() => {
        if (typeof window === 'undefined') {
            return;
        }

        const unsubscribe = useUIStore.subscribe((state, prevState) => {
            const width = window.innerWidth;
            const height = window.innerHeight;

            const rightCanAutoOpen = width >= RIGHT_SIDEBAR_AUTO_OPEN_WIDTH;
            const bottomCanAutoOpen =
                height >= BOTTOM_TERMINAL_AUTO_OPEN_HEIGHT;

            if (state.isRightSidebarOpen !== prevState.isRightSidebarOpen && rightCanAutoOpen) {
                rightSidebarAutoClosedRef.current = false;
            }

            if (state.isBottomTerminalOpen !== prevState.isBottomTerminalOpen && bottomCanAutoOpen) {
                bottomTerminalAutoClosedRef.current = false;
            }
        });

        return () => {
            unsubscribe();
        };
    }, [isMobile, isTablet, setBottomTerminalOpen, setRightSidebarOpen]);

    const handleToggleMobileRightDrawer = React.useCallback(() => {
        if (mobileLeftDrawerOpen) {
            setMobileSessionPanelOpen(false);
        }
        setMobileRightSidebarOpen(!mobileRightSidebarOpen);
    }, [mobileLeftDrawerOpen, mobileRightSidebarOpen, setMobileSessionPanelOpen]);

    const secondaryView = React.useMemo(() => {
        switch (activeMainTab) {
            case 'plan':
                return <React.Suspense fallback={null}><PlanView /></React.Suspense>;
            case 'git':
                return <React.Suspense fallback={null}><GitView isActive={!mobileRightSidebarOpen} /></React.Suspense>;
            case 'diff':
                return <React.Suspense fallback={null}><DiffView /></React.Suspense>;
            case 'terminal':
                return <TerminalView />;
            case 'files':
                return <React.Suspense fallback={null}><FilesView /></React.Suspense>;
            case 'context':
                return <React.Suspense fallback={null}><ProjectContextPanel /></React.Suspense>;
            case 'diagram':
                return <React.Suspense fallback={null}><DiagramView /></React.Suspense>;
            default:
                return null;
        }
    }, [activeMainTab, mobileRightSidebarOpen]);

    const isChatActive = activeMainTab === 'chat';

    return (
        <DiffWorkerProvider>
            <div
                data-page-scroll-lock="true"
                className={cn(
                    'main-content-safe-area',
                    isMobile ? 'flex h-[100dvh] flex-col' : 'relative flex h-[100dvh]',
                    'bg-background'
                )}
            >
                <CommandPalette />
                <HelpDialog />
                <OpenCodeStatusDialog />
                <SessionDialogs />

                {isMobile ? (
                <DrawerProvider value={{
                    leftDrawerOpen: mobileLeftDrawerOpen,
                    rightDrawerOpen: mobileRightSidebarOpen,
                    toggleLeftDrawer: () => {
                        const nextOpen = !mobileLeftDrawerOpen;
                        if (mobileRightSidebarOpen) {
                            setMobileRightSidebarOpen(false);
                        }
                        setMobileSessionPanelOpen(nextOpen);
                    },
                    toggleRightDrawer: handleToggleMobileRightDrawer,
                    leftDrawerX,
                    rightDrawerX,
                    leftDrawerWidth,
                    rightDrawerWidth,
                    setMobileLeftDrawerOpen: setMobileSessionPanelOpen,
                    setRightSidebarOpen: setMobileRightSidebarOpen,
                }}>
                    {/* Mobile: header + drawer mode */}
                    {!isSettingsDialogOpen && <Header 
                        onToggleLeftDrawer={() => {
                            const nextOpen = !mobileLeftDrawerOpen;
                            if (mobileRightSidebarOpen) {
                                setMobileRightSidebarOpen(false);
                            }
                            setMobileSessionPanelOpen(nextOpen);
                        }}
                        onToggleRightDrawer={() => {
                            handleToggleMobileRightDrawer();
                        }}
                        leftDrawerOpen={mobileLeftDrawerOpen}
                        rightDrawerOpen={mobileRightSidebarOpen}
                    />}
                    
                    {/* Main content area (fixed) */}
                    <div
                        data-page-scroll-lock="true"
                        className={cn(
                            'flex flex-1 overflow-hidden relative',
                            isSettingsDialogOpen && 'hidden'
                        )}
                    >
                        <main className="w-full h-full overflow-hidden bg-background relative" data-page-scroll-lock="true">
                            <div className={cn('absolute inset-0', !isChatActive && 'invisible')}>
                                <ErrorBoundary><ChatView active={isChatActive && !isSettingsDialogOpen} /></ErrorBoundary>
                            </div>
                            {secondaryView && (
                                <div className="absolute inset-0">
                                    <ErrorBoundary>{secondaryView}</ErrorBoundary>
                                </div>
                            )}
                            {isMultiRunLauncherOpen && (
                                <div className="absolute inset-0 z-10 bg-background">
                                    <ErrorBoundary>
                                        <MultiRunLauncher
                                            initialPrompt={multiRunLauncherPrefillPrompt}
                                            onCreated={() => setMultiRunLauncherOpen(false)}
                                            onCancel={() => setMultiRunLauncherOpen(false)}
                                        />
                                    </ErrorBoundary>
                                </div>
                            )}
                            {/* Always mount SessionSidebar on mobile to match desktop behavior.
                                Conditional mount (mobileLeftDrawerVisible && ...) caused a
                                data-loading cascade on every drawer open: paginated sessions
                                fetch, worktree discovery, repo status, PR status, and 10+ memo
                                recomputations. On Android PWA this manifested as a >10s delay
                                before the drawer became interactive (issue #1695). Visibility is
                                controlled by the leftDrawerX transform (off-screen when closed).
                                The invisible class matters when fully hidden: leftDrawerWidth is
                                not recomputed on resize/rotation, so a closed drawer translated by
                                the old width could otherwise peek into the viewport; it also keeps
                                the off-screen sidebar out of the tab order and skips painting it. */}
                            <motion.div
                                className={cn(
                                    'absolute inset-0 z-20 bg-sidebar',
                                    !mobileLeftDrawerVisible && 'pointer-events-none invisible',
                                )}
                                data-page-scroll-lock="true"
                                style={{ x: leftDrawerX }}
                                aria-hidden={!mobileLeftDrawerOpen}
                            >
                                <ErrorBoundary>
                                    <SessionSidebar mobileVariant />
                                </ErrorBoundary>
                            </motion.div>
                            {mobileRightDrawerVisible && (
                                <motion.div className="absolute inset-0 z-20 bg-sidebar" data-page-scroll-lock="true" style={{ x: rightDrawerX }} aria-hidden={!mobileRightSidebarOpen}>
                                    <ErrorBoundary>
                                        <React.Suspense fallback={null}><GitView isActive={mobileRightSidebarOpen} /></React.Suspense>
                                    </ErrorBoundary>
                                </motion.div>
                            )}
                        </main>
                    </div>

                    {/* Mobile settings: full screen */}
                    {isSettingsDialogOpen && (
                        <div
                            className="absolute inset-0 z-10 bg-background"
                            style={{ paddingTop: 'var(--oc-safe-area-top, 0px)' }}
                        >
                            <ErrorBoundary>
                                <React.Suspense fallback={null}>
                                    <SettingsView onClose={() => setSettingsDialogOpen(false)} />
                                </React.Suspense>
                            </ErrorBoundary>
                        </div>
                    )}
                </DrawerProvider>
            ) : (
                <>
                    {/* Persistent top-left controls (toggle + project actions) that
                        stay put while the sidebar/header animate beneath them. */}
                    <TitlebarLeftControls />
                    {/* Desktop: full-height Sidebar beside [Header above (chat | RightSidebar)] */}
                    <div className="flex flex-1 overflow-hidden" data-page-scroll-lock="true">
                        <Sidebar
                            isOpen={isSidebarOpen}
                            isMobile={isMobile}
                            className="border-border/50"
                            topBar={<SidebarTopBar />}
                        >
                            <SessionSidebar />
                        </Sidebar>
                        <div className="relative flex flex-1 min-w-0 flex-col overflow-hidden bg-background" data-page-scroll-lock="true">
                            <Header />
                            <div className="relative flex flex-1 min-h-0 overflow-hidden bg-background" data-page-scroll-lock="true">
                                <div className="relative flex flex-1 min-w-0 flex-col overflow-hidden border-t border-border/50 bg-background" data-page-scroll-lock="true">
                                    <div className="flex flex-1 min-h-0 overflow-hidden" data-page-scroll-lock="true">
                                        <div className="relative flex flex-1 min-h-0 min-w-0 overflow-hidden" data-page-scroll-lock="true">
                                            <main className="flex-1 overflow-hidden bg-background relative" data-page-scroll-lock="true">
                                                <div className={cn('absolute inset-0', !isChatActive && 'invisible')}>
                                                    <ErrorBoundary><ChatView active={isChatActive && !isSettingsDialogOpen} /></ErrorBoundary>
                                                </div>
                                                {secondaryView && (
                                                    <div className="absolute inset-0">
                                                        <ErrorBoundary>{secondaryView}</ErrorBoundary>
                                                    </div>
                                                )}
                                            </main>
                                            <ContextPanel />
                                        </div>
                                    </div>
                                    <BottomTerminalDock isOpen={isBottomTerminalOpen && activeMainTab !== 'terminal'} isMobile={isMobile}>
                                        {isBottomTerminalOpen && activeMainTab !== 'terminal' ? (
                                            <ErrorBoundary>
                                                <TerminalView />
                                            </ErrorBoundary>
                                        ) : null}
                                    </BottomTerminalDock>
                                </div>
                                <RightSidebar
                                    isOpen={isRightSidebarOpen}
                                    className="bg-background border-t border-border/50"
                                >
                                    <ErrorBoundary><RightSidebarTabs /></ErrorBoundary>
                                </RightSidebar>
                            </div>
                        </div>
                    </div>

                    {/* Desktop settings: windowed dialog with blur */}
                    <React.Suspense fallback={null}>
                        <SettingsWindow
                            open={isSettingsDialogOpen}
                            onOpenChange={setSettingsDialogOpen}
                        />
                    </React.Suspense>
                    <React.Suspense fallback={null}>
                        <MultiRunWindow
                            open={isMultiRunLauncherOpen}
                            onOpenChange={setMultiRunLauncherOpen}
                            initialPrompt={multiRunLauncherPrefillPrompt}
                        />
                    </React.Suspense>
                </>
            )}

        </div>
    </DiffWorkerProvider>
    );
};
