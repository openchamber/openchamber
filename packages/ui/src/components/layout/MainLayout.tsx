import React, { useRef, useEffect } from 'react';
import { motion, useMotionValue, animate } from 'motion/react';
import { Header } from './Header';
import { BottomTerminalDock } from './BottomTerminalDock';
import { Sidebar, SIDEBAR_CONTENT_WIDTH } from './Sidebar';
import { RightSidebar, RIGHT_SIDEBAR_CONTENT_WIDTH } from './RightSidebar';
import { RightSidebarTabs } from './RightSidebarTabs';
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
import { useUpdateStore } from '@/stores/useUpdateStore';
import { useDeviceInfo } from '@/lib/device';
import { useEffectiveDirectory } from '@/hooks/useEffectiveDirectory';
import { useI18n } from '@/lib/i18n';
import { cn } from '@/lib/utils';
import { isDesktopShell } from '@/lib/desktop';
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

// Mobile drawer width as screen percentage
const MOBILE_DRAWER_WIDTH_PERCENT = 85;
const DESKTOP_SIDEBAR_MIN_WIDTH = 250;
const DESKTOP_SIDEBAR_MAX_WIDTH = 500;
const DESKTOP_RIGHT_SIDEBAR_MIN_WIDTH = 400;
const DESKTOP_RIGHT_SIDEBAR_MAX_WIDTH = 860;

const normalizeDirectoryKey = (value: string): string => {
    if (!value) return '';

    const raw = value.replace(/\\/g, '/');
    const hadUncPrefix = raw.startsWith('//');
    let normalized = raw.replace(/\/+$/g, '');
    normalized = normalized.replace(/\/+/g, '/');

    if (hadUncPrefix && !normalized.startsWith('//')) {
        normalized = `/${normalized}`;
    }

    if (normalized === '') {
        return raw.startsWith('/') ? '/' : '';
    }

    return normalized;
};

export const MainLayout: React.FC = () => {
    const { t } = useI18n();
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
    const isDesktopShellRuntime = React.useMemo(() => isDesktopShell(), []);
    const sidebarWidth = useUIStore((state) => state.sidebarWidth);
    const rightSidebarWidth = useUIStore((state) => state.rightSidebarWidth);
    const [desktopRightSidebarActionsHost, setDesktopRightSidebarActionsHost] = React.useState<HTMLDivElement | null>(null);
    const effectiveDirectory = useEffectiveDirectory() ?? '';
    const directoryKey = React.useMemo(() => normalizeDirectoryKey(effectiveDirectory), [effectiveDirectory]);
    const isContextPanelOpen = useUIStore((state) => {
        if (!directoryKey) {
            return false;
        }
        const panelState = state.contextPanelByDirectory[directoryKey];
        const tabs = panelState?.tabs ?? [];
        const activeTab = tabs.find((tab) => tab.id === panelState?.activeTabId) ?? tabs[tabs.length - 1];
        return Boolean(panelState?.isOpen && activeTab);
    });
    const setSidebarOpen = useUIStore((state) => state.setSidebarOpen);
    const rightSidebarAutoClosedRef = React.useRef(false);
    const bottomTerminalAutoClosedRef = React.useRef(false);
    const leftSidebarAutoClosedByContextRef = React.useRef(false);

    // Mobile drawer state
    const [mobileLeftDrawerOpen, setMobileLeftDrawerOpen] = React.useState(false);
    const mobileRightDrawerOpenRef = React.useRef(false);

    // Left drawer motion value
    const leftDrawerX = useMotionValue(0);
    const leftDrawerWidth = useRef(0);

    // Right drawer motion value
    const rightDrawerX = useMotionValue(0);
    const rightDrawerWidth = useRef(0);

    // Compute drawer width
    useEffect(() => {
        if (isMobile) {
            leftDrawerWidth.current = window.innerWidth * (MOBILE_DRAWER_WIDTH_PERCENT / 100);
            rightDrawerWidth.current = window.innerWidth * (MOBILE_DRAWER_WIDTH_PERCENT / 100);
        }
    }, [isMobile]);

    // Sync left drawer state and motion value
    useEffect(() => {
        if (!isMobile) return;
        const targetX = mobileLeftDrawerOpen ? 0 : -leftDrawerWidth.current;
        animate(leftDrawerX, targetX, {
            type: "spring",
            stiffness: 400,
            damping: 35,
            mass: 0.8
        });
    }, [mobileLeftDrawerOpen, isMobile, leftDrawerX]);

    // Sync right drawer state and motion value
    useEffect(() => {
        if (!isMobile) return;
        mobileRightDrawerOpenRef.current = isRightSidebarOpen;
        const targetX = isRightSidebarOpen ? 0 : rightDrawerWidth.current;
        animate(rightDrawerX, targetX, {
            type: "spring",
            stiffness: 400,
            damping: 35,
            mass: 0.8
        });
    }, [isMobile, isRightSidebarOpen, rightDrawerX]);

    // Sync session switcher state to left drawer (one-way)
    useEffect(() => {
        if (isMobile) {
            setMobileLeftDrawerOpen(isSessionSwitcherOpen);
        }
    }, [isSessionSwitcherOpen, isMobile]);

    // Ensure mobile drawers are closed when opening full-screen settings
    useEffect(() => {
        if (!isMobile || !isSettingsDialogOpen) {
            return;
        }

        setMobileLeftDrawerOpen(false);
        if (isSessionSwitcherOpen) {
            useUIStore.getState().setSessionSwitcherOpen(false);
        }
        if (isRightSidebarOpen) {
            setRightSidebarOpen(false);
        }
    }, [isMobile, isSettingsDialogOpen, isSessionSwitcherOpen, isRightSidebarOpen, setRightSidebarOpen]);

    // Sync right drawer and git sidebar state
    useEffect(() => {
        if (isMobile) {
            mobileRightDrawerOpenRef.current = isRightSidebarOpen;
        }
    }, [isRightSidebarOpen, isMobile]);

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
        if (isContextPanelOpen) {
            const currentlyOpen = useUIStore.getState().isSidebarOpen;
            if (currentlyOpen) {
                setSidebarOpen(false);
                leftSidebarAutoClosedByContextRef.current = true;
            }
            return;
        }

        if (leftSidebarAutoClosedByContextRef.current) {
            setSidebarOpen(true);
            leftSidebarAutoClosedByContextRef.current = false;
        }
    }, [isContextPanelOpen, setSidebarOpen]);

    React.useEffect(() => {
        if (typeof window === 'undefined') {
            return;
        }

        let timeoutId: number | undefined;

        const handleResponsivePanels = () => {
            const state = useUIStore.getState();
            const width = window.innerWidth;
            const height = window.innerHeight;

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

            // Touch devices frequently resize when the on-screen keyboard opens.
            // Treat bottom-terminal auto-collapse/restore as desktop-only so
            // keyboard viewport changes do not churn terminal layout state.
            if (!isMobile && !isTablet) {
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
                    'main-content-safe-area h-[100dvh]',
                    isMobile ? 'flex flex-col' : 'flex',
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
                    rightDrawerOpen: isRightSidebarOpen,
                    toggleLeftDrawer: () => {
                        if (isRightSidebarOpen) {
                            setRightSidebarOpen(false);
                        }
                        setMobileLeftDrawerOpen(!mobileLeftDrawerOpen);
                    },
                    toggleRightDrawer: () => {
                        if (mobileLeftDrawerOpen) {
                            setMobileLeftDrawerOpen(false);
                        }
                        setRightSidebarOpen(!isRightSidebarOpen);
                    },
                    leftDrawerX,
                    rightDrawerX,
                    leftDrawerWidth,
                    rightDrawerWidth,
                    setMobileLeftDrawerOpen,
                    setRightSidebarOpen,
                }}>
                    {/* Mobile: header + drawer mode */}
                    {!isSettingsDialogOpen && <Header 
                        onToggleLeftDrawer={() => {
                            if (isRightSidebarOpen) {
                                setRightSidebarOpen(false);
                            }
                            setMobileLeftDrawerOpen(!mobileLeftDrawerOpen);
                        }}
                        onToggleRightDrawer={() => {
                            if (mobileLeftDrawerOpen) {
                                setMobileLeftDrawerOpen(false);
                            }
                            setRightSidebarOpen(!isRightSidebarOpen);
                        }}
                        leftDrawerOpen={mobileLeftDrawerOpen}
                        rightDrawerOpen={isRightSidebarOpen}
                    />}
                    
                    {/* Backdrop */}
                    <motion.button
                        type="button"
                        initial={false}
                        animate={{
                            opacity: mobileLeftDrawerOpen || isRightSidebarOpen ? 1 : 0,
                            pointerEvents: mobileLeftDrawerOpen || isRightSidebarOpen ? 'auto' : 'none',
                        }}
                        className="fixed left-0 right-0 bottom-0 top-[var(--oc-header-height,56px)] z-40 bg-black/50 cursor-default"
                        onClick={() => {
                            setMobileLeftDrawerOpen(false);
                            setRightSidebarOpen(false);
                        }}
                        aria-label={t('mainLayout.mobile.closeDrawerAria')}
                    />
                    
                    {/* Left drawer (Session) */}
                    <motion.aside
                        drag="x"
                        dragElastic={0.08}
                        dragMomentum={false}
                        dragConstraints={{ left: -(leftDrawerWidth.current || window.innerWidth * 0.85), right: 0 }}
                        style={{
                            width: `${MOBILE_DRAWER_WIDTH_PERCENT}%`,
                            x: leftDrawerX,
                        }}
                        onDragEnd={(_, info) => {
                            const drawerWidthPx = leftDrawerWidth.current || window.innerWidth * 0.85;
                            const threshold = drawerWidthPx * 0.3;
                            const velocityThreshold = 500;
                            const currentX = leftDrawerX.get();
                            
                            const shouldClose = info.offset.x < -threshold || info.velocity.x < -velocityThreshold;
                            const shouldOpen = info.offset.x > threshold || info.velocity.x > velocityThreshold;
                            
                            if (shouldClose) {
                                leftDrawerX.set(-drawerWidthPx);
                                setMobileLeftDrawerOpen(false);
                            } else if (shouldOpen) {
                                leftDrawerX.set(0);
                                setMobileLeftDrawerOpen(true);
                            } else {
                                if (currentX > -drawerWidthPx / 2) {
                                    leftDrawerX.set(0);
                                } else {
                                    leftDrawerX.set(-drawerWidthPx);
                                }
                            }
                        }}
                        className={cn(
                            'fixed left-0 top-[var(--oc-header-height,56px)] z-50 h-[calc(100%-var(--oc-header-height,56px))] bg-background',
                            'cursor-grab active:cursor-grabbing'
                        )}
                        aria-hidden={!mobileLeftDrawerOpen}
                    >
                        <div
                            data-page-scroll-lock="true"
                            className="h-full overflow-hidden flex bg-[var(--surface-background)] shadow-none drawer-safe-area"
                            style={{ backgroundImage: 'linear-gradient(var(--surface-muted), var(--surface-muted))' }}
                        >
                            <div className="flex-1 min-w-0 overflow-hidden flex flex-col" data-page-scroll-lock="true">
                                <ErrorBoundary>
                                    <SessionSidebar mobileVariant />
                                </ErrorBoundary>
                            </div>
                        </div>
                    </motion.aside>
                    
                    {/* Right drawer (Git) */}
                    <motion.aside
                        drag="x"
                        dragElastic={0.08}
                        dragMomentum={false}
                        dragConstraints={{ left: 0, right: rightDrawerWidth.current || window.innerWidth * 0.85 }}
                        style={{
                            width: `${MOBILE_DRAWER_WIDTH_PERCENT}%`,
                            x: rightDrawerX,
                        }}
                        onDragEnd={(_, info) => {
                            const drawerWidthPx = rightDrawerWidth.current || window.innerWidth * 0.85;
                            const threshold = drawerWidthPx * 0.3;
                            const velocityThreshold = 500;
                            const currentX = rightDrawerX.get();
                            
                            const shouldClose = info.offset.x > threshold || info.velocity.x > velocityThreshold;
                            const shouldOpen = info.offset.x < -threshold || info.velocity.x < -velocityThreshold;
                            
                            if (shouldClose) {
                                rightDrawerX.set(drawerWidthPx);
                                setRightSidebarOpen(false);
                            } else if (shouldOpen) {
                                rightDrawerX.set(0);
                                setRightSidebarOpen(true);
                            } else {
                                if (currentX < drawerWidthPx / 2) {
                                    rightDrawerX.set(0);
                                } else {
                                    rightDrawerX.set(drawerWidthPx);
                                }
                            }
                        }}
                        className={cn(
                            'fixed right-0 top-[var(--oc-header-height,56px)] z-50 h-[calc(100%-var(--oc-header-height,56px))] bg-background',
                            'cursor-grab active:cursor-grabbing'
                        )}
                        aria-hidden={!isRightSidebarOpen}
                    >
                        <div className="h-full overflow-hidden flex flex-col bg-background shadow-none drawer-safe-area" data-page-scroll-lock="true">
                            <ErrorBoundary>
                                <React.Suspense fallback={null}><GitView /></React.Suspense>
                            </ErrorBoundary>
                        </div>
                    </motion.aside>
                    
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
                    {/* Desktop: Sidebar is a left column; header belongs to content column */}
                    <div className="flex flex-1 overflow-hidden relative">
                        <div className={cn(
                            'absolute inset-0 flex overflow-hidden',
                            isDesktopShellRuntime ? 'bg-sidebar' : 'bg-sidebar'
                        )} data-page-scroll-lock="true">
                            {isSidebarOpen ? (
                                <>
                                    <div
                                        aria-hidden
                                        className={cn(
                                            'pointer-events-none absolute top-0 z-0',
                                            isDesktopShellRuntime ? 'bg-sidebar' : 'bg-sidebar'
                                        )}
                                        style={{
                                            left: `${visibleSidebarWidth}px`,
                                            width: '10px',
                                            height: '10px',
                                            WebkitMaskImage: 'radial-gradient(circle at 100% 100%, transparent calc(10px - 1px), black 10px)',
                                            maskImage: 'radial-gradient(circle at 100% 100%, transparent calc(10px - 1px), black 10px)',
                                        }}
                                    />
                                    <div
                                        aria-hidden
                                        className={cn(
                                            'pointer-events-none absolute bottom-0 z-0',
                                            isDesktopShellRuntime ? 'bg-sidebar' : 'bg-sidebar'
                                        )}
                                        style={{
                                            left: `${visibleSidebarWidth}px`,
                                            width: '10px',
                                            height: '10px',
                                            WebkitMaskImage: 'radial-gradient(circle at 100% 0%, transparent calc(10px - 1px), black 10px)',
                                            maskImage: 'radial-gradient(circle at 100% 0%, transparent calc(10px - 1px), black 10px)',
                                        }}
                                    />
                                </>
                            ) : null}
                            {isRightSidebarOpen ? (
                                <>
                                    <div
                                        aria-hidden
                                        className={cn(
                                            'pointer-events-none absolute top-0 z-0',
                                            isDesktopShellRuntime ? 'bg-sidebar' : 'bg-sidebar'
                                        )}
                                        style={{
                                            right: `${visibleRightSidebarWidth}px`,
                                            width: '10px',
                                            height: '10px',
                                            WebkitMaskImage: 'radial-gradient(circle at 0 100%, transparent calc(10px - 1px), black 10px)',
                                            maskImage: 'radial-gradient(circle at 0 100%, transparent calc(10px - 1px), black 10px)',
                                        }}
                                    />
                                    <div
                                        aria-hidden
                                        className={cn(
                                            'pointer-events-none absolute bottom-0 z-0',
                                            isDesktopShellRuntime ? 'bg-sidebar' : 'bg-sidebar'
                                        )}
                                        style={{
                                            right: `${visibleRightSidebarWidth}px`,
                                            width: '10px',
                                            height: '10px',
                                            WebkitMaskImage: 'radial-gradient(circle at 0 0, transparent calc(10px - 1px), black 10px)',
                                            maskImage: 'radial-gradient(circle at 0 0, transparent calc(10px - 1px), black 10px)',
                                        }}
                                    />
                                </>
                            ) : null}
                            <Sidebar
                                isOpen={isSidebarOpen}
                                isMobile={isMobile}
                                className="border-0"
                            >
                                <SessionSidebar />
                            </Sidebar>
                            <div className={cn(
                                'relative flex flex-1 min-w-0 flex-col overflow-hidden',
                                'bg-sidebar',
                                isSidebarOpen && 'border-l border-border/50 rounded-tl-[10px] rounded-bl-[10px]',
                                isRightSidebarOpen && 'border-r border-border/50 rounded-tr-[10px] rounded-br-[10px]'
                            )} data-page-scroll-lock="true">
                                <Header desktopRightSidebarActionsHost={desktopRightSidebarActionsHost} />
                                <div className={cn(
                                    'flex flex-1 min-h-0 overflow-hidden',
                                    isSidebarOpen || isChatActive ? '' : 'border-l border-border/50',
                                    isRightSidebarOpen ? '' : 'border-r border-border/50'
                                )} data-page-scroll-lock="true">
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
                                onTopActionsHostChange={setDesktopRightSidebarActionsHost}
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
