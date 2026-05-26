import React, { useRef, useEffect } from 'react';
import { animate, motion, useMotionValue } from 'motion/react';
import { Header } from './Header';
import { BottomTerminalDock } from './BottomTerminalDock';
import { Sidebar, SIDEBAR_CONTENT_WIDTH } from './Sidebar';
import { RightSidebar, RIGHT_SIDEBAR_CONTENT_WIDTH } from './RightSidebar';
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
import { DrawerProvider } from '@/contexts/DrawerContext';

import { useUIStore } from '@/stores/useUIStore';
import { useSessionUIStore } from '@/sync/session-ui-store';
import { useUpdateStore } from '@/stores/useUpdateStore';
import { useDeviceInfo } from '@/lib/device';
import { cn } from '@/lib/utils';
import { lazyWithChunkRecovery } from '@/lib/chunkLoadRecovery';

import { ChatView } from '@/components/views/ChatView';

// Heavy views loaded on-demand to reduce initial bundle parse time.
const PlanView = lazyWithChunkRecovery(() => import('@/components/views/PlanView').then(m => ({ default: m.PlanView })));
const GitView = lazyWithChunkRecovery(() => import('@/components/views/GitView').then(m => ({ default: m.GitView })));
const DiffView = lazyWithChunkRecovery(() => import('@/components/views/DiffView').then(m => ({ default: m.DiffView })));
const TerminalView = lazyWithChunkRecovery(() => import('@/components/views/TerminalView').then(m => ({ default: m.TerminalView })));
const FilesView = lazyWithChunkRecovery(() => import('@/components/views/FilesView').then(m => ({ default: m.FilesView })));
const SettingsView = lazyWithChunkRecovery(() => import('@/components/views/SettingsView').then(m => ({ default: m.SettingsView })));
const SettingsWindow = lazyWithChunkRecovery(() => import('@/components/views/SettingsWindow').then(m => ({ default: m.SettingsWindow })));
const MultiRunWindow = lazyWithChunkRecovery(() => import('@/components/views/MultiRunWindow').then(m => ({ default: m.MultiRunWindow })));

const DESKTOP_SIDEBAR_MIN_WIDTH = 280;
const DESKTOP_SIDEBAR_MAX_WIDTH = 500;
const DESKTOP_RIGHT_SIDEBAR_MIN_WIDTH = 360;
const DESKTOP_RIGHT_SIDEBAR_MAX_WIDTH = 860;

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
    const sidebarWidth = useUIStore((state) => state.sidebarWidth);
    const rightSidebarWidth = useUIStore((state) => state.rightSidebarWidth);
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

    // Trigger initial update check shortly after mount, then repeat using server-suggested cadence.
    const checkForUpdates = useUpdateStore((state) => state.checkForUpdates);
    React.useEffect(() => {
        const initialDelayMs = 3000;
        const defaultIntervalMs = 60 * 60 * 1000;
        const minIntervalMs = 5 * 60 * 1000;
        const maxIntervalMs = 24 * 60 * 60 * 1000;
        let disposed = false;
        let timer: number | null = null;

        const clampIntervalMs = (seconds: number): number => {
            const ms = Math.round(seconds * 1000);
            return Math.max(minIntervalMs, Math.min(maxIntervalMs, ms));
        };

        const scheduleNext = (delayMs: number) => {
            if (disposed) return;
            timer = window.setTimeout(async () => {
                const suggestedSec = await checkForUpdates();
                const nextDelay = typeof suggestedSec === 'number' && Number.isFinite(suggestedSec)
                    ? clampIntervalMs(suggestedSec)
                    : defaultIntervalMs;
                scheduleNext(nextDelay);
            }, delayMs);
        };

        scheduleNext(initialDelayMs);

        return () => {
            disposed = true;
            if (timer !== null) {
                window.clearTimeout(timer);
            }
        };
    }, [checkForUpdates]);

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

        let timeoutId: number | undefined;

        const handleResize = () => {
            if (timeoutId !== undefined) {
                window.clearTimeout(timeoutId);
            }

            timeoutId = window.setTimeout(() => {
                useUIStore.getState().updateProportionalSidebarWidths();
            }, 150);
        };

        window.addEventListener('resize', handleResize);

        return () => {
            window.removeEventListener('resize', handleResize);
            if (timeoutId !== undefined) {
                window.clearTimeout(timeoutId);
            }
        };
    }, []);

    React.useEffect(() => {
        if (typeof window === 'undefined') {
            return;
        }

        let timeoutId: number | undefined;

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
            if (timeoutId !== undefined) {
                window.clearTimeout(timeoutId);
            }

            timeoutId = window.setTimeout(() => {
                handleResponsivePanels();
            }, 100);
        };

        handleResponsivePanels();
        window.addEventListener('resize', handleResize);

        return () => {
            window.removeEventListener('resize', handleResize);
            if (timeoutId !== undefined) {
                window.clearTimeout(timeoutId);
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
                return <React.Suspense fallback={null}><GitView /></React.Suspense>;
            case 'diff':
                return <React.Suspense fallback={null}><DiffView /></React.Suspense>;
            case 'terminal':
                return <React.Suspense fallback={null}><TerminalView /></React.Suspense>;
            case 'files':
                return <React.Suspense fallback={null}><FilesView /></React.Suspense>;
            case 'context':
                return <React.Suspense fallback={null}><ProjectContextPanel /></React.Suspense>;
            default:
                return null;
        }
    }, [activeMainTab]);

    const isChatActive = activeMainTab === 'chat';
    const visibleSidebarWidth = React.useMemo(() => {
        const rawWidth = sidebarWidth || SIDEBAR_CONTENT_WIDTH;
        return Math.min(DESKTOP_SIDEBAR_MAX_WIDTH, Math.max(DESKTOP_SIDEBAR_MIN_WIDTH, rawWidth));
    }, [sidebarWidth]);
    const visibleRightSidebarWidth = React.useMemo(() => {
        const rawWidth = rightSidebarWidth || RIGHT_SIDEBAR_CONTENT_WIDTH;
        return Math.min(DESKTOP_RIGHT_SIDEBAR_MAX_WIDTH, Math.max(DESKTOP_RIGHT_SIDEBAR_MIN_WIDTH, rawWidth));
    }, [rightSidebarWidth]);

    return (
        <DiffWorkerProvider>
            <div
                data-page-scroll-lock="true"
                className={cn(
                    'main-content-safe-area',
                    isMobile ? 'flex h-[100dvh] flex-col' : 'flex h-[100dvh]',
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
                                <ErrorBoundary><ChatView /></ErrorBoundary>
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
                            {mobileLeftDrawerVisible && (
                                <motion.div className="absolute inset-0 z-20 bg-sidebar" data-page-scroll-lock="true" style={{ x: leftDrawerX }} aria-hidden={!mobileLeftDrawerOpen}>
                                    <ErrorBoundary>
                                        <SessionSidebar mobileVariant />
                                    </ErrorBoundary>
                                </motion.div>
                            )}
                            {mobileRightDrawerVisible && (
                                <motion.div className="absolute inset-0 z-20 bg-sidebar" data-page-scroll-lock="true" style={{ x: rightDrawerX }} aria-hidden={!mobileRightSidebarOpen}>
                                    <ErrorBoundary>
                                        <React.Suspense fallback={null}><GitView /></React.Suspense>
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
                    {/* Desktop: full-width Header above [Sidebar | chat-frame | RightSidebar] row */}
                    <div className="flex flex-1 flex-col overflow-hidden">
                        <Header />
                        <div className="relative flex flex-1 min-h-0 overflow-hidden bg-sidebar" data-page-scroll-lock="true">
                            <div
                                aria-hidden
                                className="pointer-events-none absolute top-0 z-0 bg-sidebar transition-[left,opacity] duration-200 ease-[cubic-bezier(0.22,1,0.36,1)] motion-reduce:transition-none"
                                style={{
                                    left: `${isSidebarOpen ? visibleSidebarWidth : 0}px`,
                                    opacity: isSidebarOpen ? 1 : 0,
                                    width: '10px',
                                    height: '10px',
                                    WebkitMaskImage: 'radial-gradient(circle at 100% 100%, transparent calc(10px - 1px), black 10px)',
                                    maskImage: 'radial-gradient(circle at 100% 100%, transparent calc(10px - 1px), black 10px)',
                                }}
                            />
                            <div
                                aria-hidden
                                className="pointer-events-none absolute bottom-0 z-0 bg-sidebar transition-[left,opacity] duration-200 ease-[cubic-bezier(0.22,1,0.36,1)] motion-reduce:transition-none"
                                style={{
                                    left: `${isSidebarOpen ? visibleSidebarWidth : 0}px`,
                                    opacity: isSidebarOpen ? 1 : 0,
                                    width: '10px',
                                    height: '10px',
                                    WebkitMaskImage: 'radial-gradient(circle at 100% 0%, transparent calc(10px - 1px), black 10px)',
                                    maskImage: 'radial-gradient(circle at 100% 0%, transparent calc(10px - 1px), black 10px)',
                                }}
                            />
                            <div
                                aria-hidden
                                className="pointer-events-none absolute top-0 z-0 bg-sidebar transition-[right,opacity] duration-200 ease-[cubic-bezier(0.22,1,0.36,1)] motion-reduce:transition-none"
                                style={{
                                    right: `${isRightSidebarOpen ? visibleRightSidebarWidth : 0}px`,
                                    opacity: isRightSidebarOpen ? 1 : 0,
                                    width: '10px',
                                    height: '10px',
                                    WebkitMaskImage: 'radial-gradient(circle at 0 100%, transparent calc(10px - 1px), black 10px)',
                                    maskImage: 'radial-gradient(circle at 0 100%, transparent calc(10px - 1px), black 10px)',
                                }}
                            />
                            <div
                                aria-hidden
                                className="pointer-events-none absolute bottom-0 z-0 bg-sidebar transition-[right,opacity] duration-200 ease-[cubic-bezier(0.22,1,0.36,1)] motion-reduce:transition-none"
                                style={{
                                    right: `${isRightSidebarOpen ? visibleRightSidebarWidth : 0}px`,
                                    opacity: isRightSidebarOpen ? 1 : 0,
                                    width: '10px',
                                    height: '10px',
                                    WebkitMaskImage: 'radial-gradient(circle at 0 0, transparent calc(10px - 1px), black 10px)',
                                    maskImage: 'radial-gradient(circle at 0 0, transparent calc(10px - 1px), black 10px)',
                                }}
                            />
                            <Sidebar
                                isOpen={isSidebarOpen}
                                isMobile={isMobile}
                                className="border-0"
                            >
                                <SessionSidebar />
                            </Sidebar>
                            <div className={cn(
                                'relative flex flex-1 min-w-0 flex-col overflow-hidden',
                                'bg-background',
                                'border border-border/50 rounded-[10px]',
                                !isSidebarOpen && 'border-l-transparent',
                                !isRightSidebarOpen && 'border-r-transparent'
                            )} data-page-scroll-lock="true">
                                <div className="flex flex-1 min-h-0 overflow-hidden" data-page-scroll-lock="true">
                                    <div className="relative flex flex-1 min-h-0 min-w-0 overflow-hidden" data-page-scroll-lock="true">
                                        <main className="flex-1 overflow-hidden bg-background relative" data-page-scroll-lock="true">
                                            <div className={cn('absolute inset-0', !isChatActive && 'invisible')}>
                                                <ErrorBoundary><ChatView /></ErrorBoundary>
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
                                <BottomTerminalDock isOpen={isBottomTerminalOpen} isMobile={isMobile}>
                                    {isBottomTerminalOpen ? (
                                        <ErrorBoundary>
                                            <React.Suspense fallback={null}>
                                                <TerminalView />
                                            </React.Suspense>
                                        </ErrorBoundary>
                                    ) : null}
                                </BottomTerminalDock>
                            </div>
                            <RightSidebar
                                isOpen={isRightSidebarOpen}
                                className="border-0"
                            >
                                <ErrorBoundary><RightSidebarTabs /></ErrorBoundary>
                            </RightSidebar>
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
