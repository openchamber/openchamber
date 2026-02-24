import React, { useRef, useEffect } from 'react';
import { motion, useMotionValue, animate } from 'motion/react';
import { RiSettings3Line } from '@remixicon/react';
import { Header } from './Header';
import { BottomTerminalDock } from './BottomTerminalDock';
import { Sidebar } from './Sidebar';
import { RightSidebar } from './RightSidebar';
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
import { cn } from '@/lib/utils';

import { ChatView, PlanView, GitView, DiffView, TerminalView, FilesView, SettingsView, SettingsWindow } from '@/components/views';

// Mobile drawer width as screen percentage
const MOBILE_DRAWER_WIDTH_PERCENT = 85;

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
    const RIGHT_SIDEBAR_AUTO_CLOSE_WIDTH = 1140;
    const RIGHT_SIDEBAR_AUTO_OPEN_WIDTH = 1220;
    const BOTTOM_TERMINAL_AUTO_CLOSE_HEIGHT = 640;
    const BOTTOM_TERMINAL_AUTO_OPEN_HEIGHT = 700;
    const {
        isSidebarOpen,
        isRightSidebarOpen,
        isBottomTerminalOpen,
        setRightSidebarOpen,
        setBottomTerminalOpen,
        activeMainTab,
        setIsMobile,
        isSessionSwitcherOpen,
        isSettingsDialogOpen,
        setSettingsDialogOpen,
        isMultiRunLauncherOpen,
        setMultiRunLauncherOpen,
        multiRunLauncherPrefillPrompt,
    } = useUIStore();

    const { isMobile } = useDeviceInfo();
    const effectiveDirectory = useEffectiveDirectory() ?? '';
    const directoryKey = React.useMemo(() => normalizeDirectoryKey(effectiveDirectory), [effectiveDirectory]);
    const isContextPanelOpen = useUIStore((state) => {
        if (!directoryKey) {
            return false;
        }
        const panelState = state.contextPanelByDirectory[directoryKey];
        return Boolean(panelState?.isOpen && panelState?.mode);
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

    // Sync right drawer and git sidebar state
    useEffect(() => {
        if (isMobile) {
            mobileRightDrawerOpenRef.current = isRightSidebarOpen;
        }
    }, [isRightSidebarOpen, isMobile]);

    // Trigger update check 3 seconds after mount (for both mobile and desktop)
    const checkForUpdates = useUpdateStore((state) => state.checkForUpdates);
    React.useEffect(() => {
        const timer = setTimeout(() => {
            checkForUpdates();
        }, 3000);
        return () => clearTimeout(timer);
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
    }, [setBottomTerminalOpen, setRightSidebarOpen]);

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
    }, []);

    React.useEffect(() => {
        if (typeof window === 'undefined' || typeof document === 'undefined') {
            return;
        }

        const root = document.documentElement;

        let stickyKeyboardInset = 0;
        let ignoreOpenUntilZero = false;
        let previousHeight = 0;
        let keyboardAvoidTarget: HTMLElement | null = null;

        const setKeyboardOpen = useUIStore.getState().setKeyboardOpen;

        const clearKeyboardAvoidTarget = () => {
            if (!keyboardAvoidTarget) {
                return;
            }
            keyboardAvoidTarget.style.setProperty('--oc-keyboard-avoid-offset', '0px');
            keyboardAvoidTarget.removeAttribute('data-keyboard-avoid-active');
            keyboardAvoidTarget = null;
        };

        const resolveKeyboardAvoidTarget = (active: HTMLElement | null) => {
            if (!active) {
                return null;
            }
            const explicitTargetId = active.getAttribute('data-keyboard-avoid-target-id');
            if (explicitTargetId) {
                const explicitTarget = document.getElementById(explicitTargetId);
                if (explicitTarget instanceof HTMLElement) {
                    return explicitTarget;
                }
            }
            const markedTarget = active.closest('[data-keyboard-avoid]') as HTMLElement | null;
            if (markedTarget) {
                // data-keyboard-avoid="none" opts out of translateY avoidance entirely.
                // Used by components with their own scroll (e.g. CodeMirror).
                if (markedTarget.getAttribute('data-keyboard-avoid') === 'none') {
                    return null;
                }
                return markedTarget;
            }
            if (active.classList.contains('overlay-scrollbar-container')) {
                const parent = active.parentElement;
                if (parent instanceof HTMLElement) {
                    return parent;
                }
            }
            return active;
        };

        const forceKeyboardClosed = () => {
            stickyKeyboardInset = 0;
            ignoreOpenUntilZero = true;
            root.style.setProperty('--oc-keyboard-inset', '0px');
            setKeyboardOpen(false);
        };

        const updateVisualViewport = () => {
            const viewport = window.visualViewport;

            const height = viewport ? Math.round(viewport.height) : window.innerHeight;
            const offsetTop = viewport ? Math.max(0, Math.round(viewport.offsetTop)) : 0;

            root.style.setProperty('--oc-visual-viewport-offset-top', `${offsetTop}px`);

            const active = document.activeElement as HTMLElement | null;
            const tagName = active?.tagName;
            const isInput = tagName === 'INPUT' || tagName === 'TEXTAREA' || tagName === 'SELECT';
            const isTextTarget = isInput || Boolean(active?.isContentEditable);

            const layoutHeight = Math.round(root.clientHeight || window.innerHeight);
            const viewportSum = height + offsetTop;
            const rawInset = Math.max(0, layoutHeight - viewportSum);

            // Keyboard heuristic:
            // - when an input is focused, smaller deltas can still be keyboard
            // - when not focused, treat only big deltas as keyboard (ignore toolbars)
            const openThreshold = isTextTarget ? 120 : 180;
            const measuredInset = rawInset >= openThreshold ? rawInset : 0;

            // Make the UI stable: treat keyboard inset as a step function.
            // - When opening: take the first big inset and hold it.
            // - When closing starts: immediately drop to 0 (even if keyboard animation continues).
            // Closing start signals:
            // - focus lost (handled via focusout)
            // - visual viewport height starts increasing while inset is non-zero
            if (ignoreOpenUntilZero) {
                if (measuredInset === 0) {
                    ignoreOpenUntilZero = false;
                }
                stickyKeyboardInset = 0;
            } else if (stickyKeyboardInset === 0) {
                if (measuredInset > 0 && isTextTarget) {
                    stickyKeyboardInset = measuredInset;
                }
            } else {
                // Only detect closing-by-height when focus is NOT on text input
                // (prevents false positives during Android keyboard animation)
                const closingByHeight = !isTextTarget && height > previousHeight + 6;

                if (measuredInset === 0) {
                    stickyKeyboardInset = 0;
                    setKeyboardOpen(false);
                } else if (closingByHeight) {
                    forceKeyboardClosed();
                } else if (measuredInset > 0 && isTextTarget) {
                    // When focus is on text input, track actual inset (allows settling
                    // to correct value after Android animation fluctuations)
                    stickyKeyboardInset = measuredInset;
                    setKeyboardOpen(true);
                } else if (measuredInset > stickyKeyboardInset) {
                    stickyKeyboardInset = measuredInset;
                    setKeyboardOpen(true);
                }
            }

            root.style.setProperty('--oc-keyboard-inset', `${stickyKeyboardInset}px`);
            previousHeight = height;

            const isIOS = /iPad|iPhone|iPod/.test(navigator.userAgent);
            const keyboardHomeIndicator = isIOS && stickyKeyboardInset > 0 ? 34 : 0;
            root.style.setProperty('--oc-keyboard-home-indicator', `${keyboardHomeIndicator}px`);

            const avoidTarget = isTextTarget ? resolveKeyboardAvoidTarget(active) : null;

            if (!isMobile || !avoidTarget || !active) {
                clearKeyboardAvoidTarget();
            } else {
                if (avoidTarget !== keyboardAvoidTarget) {
                    clearKeyboardAvoidTarget();
                    keyboardAvoidTarget = avoidTarget;
                }
                const viewportBottom = offsetTop + height;
                const rect = active.getBoundingClientRect();
                const overlap = rect.bottom - viewportBottom;
                const clearance = 8;
                const keyboardInset = Math.max(stickyKeyboardInset, measuredInset);
                const avoidOffset = overlap > clearance && keyboardInset > 0
                    ? Math.min(overlap, keyboardInset)
                    : 0;
                const target = keyboardAvoidTarget;
                if (target) {
                    target.style.setProperty('--oc-keyboard-avoid-offset', `${avoidOffset}px`);
                    target.setAttribute('data-keyboard-avoid-active', 'true');
                }
            }

            // Only force-scroll lock while an input is focused.
            if (isMobile && isTextTarget) {
                const scroller = document.scrollingElement;
                if (scroller && scroller.scrollTop !== 0) {
                    scroller.scrollTop = 0;
                }
                if (window.scrollY !== 0) {
                    window.scrollTo(0, 0);
                }
            }
        };

        updateVisualViewport();

        const viewport = window.visualViewport;
        viewport?.addEventListener('resize', updateVisualViewport);
        viewport?.addEventListener('scroll', updateVisualViewport);
        window.addEventListener('resize', updateVisualViewport);
        window.addEventListener('orientationchange', updateVisualViewport);
        const isTextInputTarget = (element: HTMLElement | null) => {
            if (!element) {
                return false;
            }
            const tagName = element.tagName;
            const isInput = tagName === 'INPUT' || tagName === 'TEXTAREA' || tagName === 'SELECT';
            return isInput || element.isContentEditable;
        };

        // Reset ignoreOpenUntilZero when focus moves to a text input.
        // This allows keyboard detection to work when user taps input quickly
        // while keyboard is still closing (common on Android).
        const handleFocusIn = (event: FocusEvent) => {
            const target = event.target as HTMLElement | null;
            if (isTextInputTarget(target)) {
                ignoreOpenUntilZero = false;
            }
            updateVisualViewport();
        };
        document.addEventListener('focusin', handleFocusIn, true);

        const handleFocusOut = (event: FocusEvent) => {
            const target = event.target as HTMLElement | null;
            if (!isTextInputTarget(target)) {
                return;
            }

            // Check if focus is moving to another input - if so, don't close keyboard
            const related = event.relatedTarget as HTMLElement | null;
            if (isTextInputTarget(related)) {
                return;
            }

            // On mobile contenteditable editors (CodeMirror), focus can momentarily
            // leave and return during drag-selection handles. Defer closing until the
            // next frame and only close when no text target is focused and the
            // visual viewport inset is actually zero.
            window.requestAnimationFrame(() => {
                if (isTextInputTarget(document.activeElement as HTMLElement | null)) {
                    return;
                }

                const currentViewport = window.visualViewport;
                const height = currentViewport ? Math.round(currentViewport.height) : window.innerHeight;
                const offsetTop = currentViewport ? Math.max(0, Math.round(currentViewport.offsetTop)) : 0;
                const layoutHeight = Math.round(root.clientHeight || window.innerHeight);
                const viewportSum = height + offsetTop;
                const rawInset = Math.max(0, layoutHeight - viewportSum);

                if (rawInset > 0) {
                    updateVisualViewport();
                    return;
                }

                forceKeyboardClosed();
                updateVisualViewport();
            });
        };

        document.addEventListener('focusout', handleFocusOut, true);

        return () => {
            viewport?.removeEventListener('resize', updateVisualViewport);
            viewport?.removeEventListener('scroll', updateVisualViewport);
            window.removeEventListener('resize', updateVisualViewport);
            window.removeEventListener('orientationchange', updateVisualViewport);
            document.removeEventListener('focusin', handleFocusIn, true);
            document.removeEventListener('focusout', handleFocusOut, true);
            clearKeyboardAvoidTarget();
        };
    }, [isMobile]);

    const secondaryView = React.useMemo(() => {
        switch (activeMainTab) {
            case 'plan':
                return <PlanView />;
            case 'git':
                return <GitView />;
            case 'diff':
                return <DiffView />;
            case 'terminal':
                return <TerminalView />;
            case 'files':
                return <FilesView />;
            default:
                return null;
        }
    }, [activeMainTab]);

    const isChatActive = activeMainTab === 'chat';

    return (
        <DiffWorkerProvider>
            <div
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
                    {!(isSettingsDialogOpen || isMultiRunLauncherOpen) && <Header 
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
                        className="fixed inset-0 z-40 bg-black/50 cursor-default"
                        onClick={() => {
                            setMobileLeftDrawerOpen(false);
                            setRightSidebarOpen(false);
                        }}
                        aria-label="Close drawer"
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
                            'fixed left-0 top-0 z-50 h-full bg-transparent',
                            'cursor-grab active:cursor-grabbing'
                        )}
                        aria-hidden={!mobileLeftDrawerOpen}
                    >
                        <div className="h-full overflow-hidden flex flex-col bg-sidebar shadow-xl drawer-safe-area">
                            <div className="flex-1 overflow-hidden">
                                <ErrorBoundary>
                                    <SessionSidebar mobileVariant />
                                </ErrorBoundary>
                            </div>
                            <div className="border-t border-border p-3">
                                <button
                                    type="button"
                                    onClick={() => {
                                        setMobileLeftDrawerOpen(false);
                                        setSettingsDialogOpen(true);
                                    }}
                                    className="flex w-full items-center gap-3 rounded-md px-3 py-2 text-muted-foreground hover:bg-interactive-hover hover:text-foreground transition-colors"
                                >
                                    <RiSettings3Line className="h-5 w-5" />
                                    <span className="typography-ui-label">Settings</span>
                                </button>
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
                            'fixed right-0 top-0 z-50 h-full bg-transparent',
                            'cursor-grab active:cursor-grabbing'
                        )}
                        aria-hidden={!isRightSidebarOpen}
                    >
                        <div className="h-full overflow-hidden flex flex-col bg-background shadow-xl drawer-safe-area">
                            <ErrorBoundary>
                                <GitView mode="sidebar" />
                            </ErrorBoundary>
                        </div>
                    </motion.aside>
                    
                    {/* Main content area (fixed) */}
                    <div
                        className={cn(
                            'flex flex-1 overflow-hidden relative',
                            (isSettingsDialogOpen || isMultiRunLauncherOpen) && 'hidden'
                        )}
                        style={{ paddingTop: 'var(--oc-header-height, 56px)' }}
                    >
                        <main className="w-full h-full overflow-hidden bg-background relative">
                            <div className={cn('absolute inset-0', !isChatActive && 'invisible')}>
                                <ErrorBoundary><ChatView /></ErrorBoundary>
                            </div>
                            {secondaryView && (
                                <div className="absolute inset-0">
                                    <ErrorBoundary>{secondaryView}</ErrorBoundary>
                                </div>
                            )}
                        </main>
                    </div>

                    {/* Mobile multi-run launcher: full screen */}
                    {isMultiRunLauncherOpen && (
                        <div className="absolute inset-0 z-10 bg-background header-safe-area">
                            <ErrorBoundary>
                                <MultiRunLauncher
                                    initialPrompt={multiRunLauncherPrefillPrompt}
                                    onCreated={() => setMultiRunLauncherOpen(false)}
                                    onCancel={() => setMultiRunLauncherOpen(false)}
                                />
                            </ErrorBoundary>
                        </div>
                    )}

                    {/* Mobile settings: full screen */}
                    {isSettingsDialogOpen && (
                        <div className="absolute inset-0 z-10 bg-background header-safe-area">
                            <ErrorBoundary><SettingsView onClose={() => setSettingsDialogOpen(false)} /></ErrorBoundary>
                        </div>
                    )}
                </DrawerProvider>
            ) : (
                <>
                    {/* Desktop: Header always on top, then Sidebar + Content below */}
                    <div className="flex flex-1 flex-col overflow-hidden relative">
                        {/* Normal view: Header above Sidebar + content (like SettingsView) */}
                        <div className={cn('absolute inset-0 flex flex-col', isMultiRunLauncherOpen && 'invisible')}>
                            <Header />
                            <div className="flex flex-1 overflow-hidden">
                                <Sidebar isOpen={isSidebarOpen} isMobile={isMobile}>
                                    <SessionSidebar hideProjectSelector />
                                </Sidebar>
                                <div className="flex flex-1 min-w-0 flex-col overflow-hidden">
                                    <div className="flex flex-1 min-h-0 overflow-hidden">
                                        <div className="relative flex flex-1 min-h-0 min-w-0 overflow-hidden">
                                            <main className="flex-1 overflow-hidden bg-background relative">
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
                                        <RightSidebar isOpen={isRightSidebarOpen}>
                                            <ErrorBoundary><RightSidebarTabs /></ErrorBoundary>
                                        </RightSidebar>
                                    </div>
                                    <BottomTerminalDock isOpen={isBottomTerminalOpen} isMobile={isMobile}>
                                        <ErrorBoundary><TerminalView /></ErrorBoundary>
                                    </BottomTerminalDock>
                                </div>
                            </div>
                        </div>

                        {/* Multi-Run Launcher: replaces tabs content only */}
                        {isMultiRunLauncherOpen && (
                            <div className={cn('absolute inset-0 z-10 bg-background')}>
                                <ErrorBoundary>
                                    <MultiRunLauncher
                                        initialPrompt={multiRunLauncherPrefillPrompt}
                                        onCreated={() => setMultiRunLauncherOpen(false)}
                                        onCancel={() => setMultiRunLauncherOpen(false)}
                                    />
                                </ErrorBoundary>
                            </div>
                        )}
                    </div>

                    {/* Desktop settings: windowed dialog with blur */}
                    <SettingsWindow
                        open={isSettingsDialogOpen}
                        onOpenChange={setSettingsDialogOpen}
                    />
                </>
            )}

        </div>
    </DiffWorkerProvider>
    );
};
