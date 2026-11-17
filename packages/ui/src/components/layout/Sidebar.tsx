import React from 'react';
import { cn } from '@/lib/utils';
import { ErrorBoundary } from '../ui/ErrorBoundary';
import { useI18n } from '@/lib/i18n';
import { useUIStore } from '@/stores/useUIStore';
import { ScrollableOverlay } from '@/components/ui/ScrollableOverlay';
import { beginLayoutAnimation, holdLayoutAnimation, LAYOUT_ANIMATION_EASING, runWhenLayoutSettled } from '@/lib/layoutAnimation';
import { useLayoutAnimationMs } from '@/hooks/useLayoutAnimationMs';
import type { SidebarPeek } from './useSidebarPeek';

const SIDEBAR_CONTENT_WIDTH = 280;
const SIDEBAR_MIN_WIDTH = 264;
const SIDEBAR_MAX_WIDTH = 500;

interface SidebarProps {
    isOpen: boolean;
    isMobile: boolean;
    children: React.ReactNode;
    className?: string;
    topBar?: React.ReactNode;
    peek?: SidebarPeek;
}

export const Sidebar: React.FC<SidebarProps> = ({ isOpen, isMobile, children, className, topBar, peek }) => {
    const { t, direction } = useI18n();
    const sidebarWidth = useUIStore((state) => state.sidebarWidth);
    const setSidebarWidth = useUIStore((state) => state.setSidebarWidth);
    const [isResizing, setIsResizing] = React.useState(false);
    const startXRef = React.useRef(0);
    const startWidthRef = React.useRef(sidebarWidth || SIDEBAR_CONTENT_WIDTH);
    const resizingWidthRef = React.useRef<number | null>(null);
    const activeResizePointerIDRef = React.useRef<number | null>(null);
    const releaseResizeHoldRef = React.useRef<(() => void) | null>(null);
    const sidebarRef = React.useRef<HTMLDivElement | null>(null);
    const titlebarOverlayRef = React.useRef<HTMLElement | null>(null);

    const clampSidebarWidth = React.useCallback((value: number) => {
        return Math.min(SIDEBAR_MAX_WIDTH, Math.max(SIDEBAR_MIN_WIDTH, value));
    }, []);

    const getTitlebarOverlay = React.useCallback(() => {
        const cached = titlebarOverlayRef.current;
        if (cached?.isConnected) {
            return cached;
        }

        const overlay = document.querySelector<HTMLElement>('[data-titlebar-left-controls]');
        titlebarOverlayRef.current = overlay;
        return overlay;
    }, []);

    const applyLiveWidth = React.useCallback((nextWidth: number) => {
        const sidebar = sidebarRef.current;
        if (!sidebar) {
            return;
        }

        sidebar.style.width = `${nextWidth}px`;
        sidebar.style.minWidth = `${nextWidth}px`;
        sidebar.style.maxWidth = `${nextWidth}px`;
        sidebar.style.setProperty('--oc-left-sidebar-width', `${nextWidth}px`);
        const overlay = getTitlebarOverlay();
        if (overlay) {
            overlay.style.setProperty('--oc-left-sidebar-width', `${nextWidth}px`);
        }
    }, [getTitlebarOverlay]);

    React.useEffect(() => {
        if (isMobile && isResizing) {
            setIsResizing(false);
        }
    }, [isMobile, isResizing]);

    React.useEffect(() => {
        if (!isResizing) {
            resizingWidthRef.current = null;
            activeResizePointerIDRef.current = null;
            releaseResizeHoldRef.current?.();
            releaseResizeHoldRef.current = null;
        }
    }, [isResizing]);

    React.useEffect(() => {
        if (!isOpen && isResizing) setIsResizing(false);
    }, [isOpen, isResizing]);

    React.useEffect(() => () => {
        releaseResizeHoldRef.current?.();
        releaseResizeHoldRef.current = null;
    }, []);

    const openWidth = Math.min(
        SIDEBAR_MAX_WIDTH,
        Math.max(SIDEBAR_MIN_WIDTH, sidebarWidth || SIDEBAR_CONTENT_WIDTH)
    );
    const appliedWidth = isOpen ? openWidth : 0;
    const currentWidth = isResizing ? (resizingWidthRef.current ?? appliedWidth) : appliedWidth;
    const publishedWidth = isResizing ? currentWidth : openWidth;

    React.useEffect(() => {
        document.documentElement.style.setProperty('--oc-left-sidebar-width', `${publishedWidth}px`);
        const overlay = titlebarOverlayRef.current;
        if (!isResizing && overlay) {
            overlay.style.removeProperty('--oc-left-sidebar-width');
        }
    }, [publishedWidth, isResizing]);

    const [contentSkipped, setContentSkipped] = React.useState(!isOpen);
    if (isOpen && contentSkipped) {
        setContentSkipped(false);
    }
    const layoutAnimationMs = useLayoutAnimationMs();
    const isOpenRef = React.useRef(isOpen);
    const previousOpenRef = React.useRef(isOpen);
    React.useLayoutEffect(() => {
        isOpenRef.current = isOpen;
        if (previousOpenRef.current === isOpen) return;
        previousOpenRef.current = isOpen;
        beginLayoutAnimation(layoutAnimationMs);
        if (!isOpen) {
            runWhenLayoutSettled(() => {
                if (!isOpenRef.current) setContentSkipped(true);
            });
        }
    }, [isOpen, layoutAnimationMs]);

    if (isMobile) {
        return null;
    }

    const handlePointerDown = (event: React.PointerEvent) => {
        if (!isOpen) {
            return;
        }

        try {
            event.currentTarget.setPointerCapture(event.pointerId);
        } catch {
            // ignore
        }

        activeResizePointerIDRef.current = event.pointerId;
        setIsResizing(true);
        startXRef.current = event.clientX;
        startWidthRef.current = appliedWidth;
        resizingWidthRef.current = appliedWidth;
        applyLiveWidth(appliedWidth);
        releaseResizeHoldRef.current?.();
        releaseResizeHoldRef.current = holdLayoutAnimation();
        event.preventDefault();
    };

    const handlePointerMove = (event: React.PointerEvent) => {
        if (isMobile || !isResizing || activeResizePointerIDRef.current !== event.pointerId) {
            return;
        }

        const delta = (event.clientX - startXRef.current) * (direction === 'rtl' ? -1 : 1);
        const nextWidth = clampSidebarWidth(startWidthRef.current + delta);
        if (resizingWidthRef.current === nextWidth) {
            return;
        }

        resizingWidthRef.current = nextWidth;
        applyLiveWidth(nextWidth);
    };

    const handlePointerEnd = (event: React.PointerEvent) => {
        if (activeResizePointerIDRef.current !== event.pointerId || isMobile) {
            return;
        }

        try {
            event.currentTarget.releasePointerCapture(event.pointerId);
        } catch {
            // ignore
        }

        const finalWidth = clampSidebarWidth(resizingWidthRef.current ?? appliedWidth);
        activeResizePointerIDRef.current = null;
        resizingWidthRef.current = null;
        setIsResizing(false);
        setSidebarWidth(finalWidth);
        releaseResizeHoldRef.current?.();
        releaseResizeHoldRef.current = null;
    };

    const peekState = !isOpen && peek ? peek.state : false;
    const peeking = peekState !== false;
    const peekAnimation = peeking && peek && peek.animationMs > 0
        ? `${peekState === 'in' ? 'oc-sidebar-peek-in' : 'oc-sidebar-peek-out'} ${peek.animationMs}ms ${LAYOUT_ANIMATION_EASING} forwards`
        : undefined;

    return (
        <div
            ref={sidebarRef}
            data-left-sidebar=""
            className={cn(
                'relative flex h-full',
                !peeking && 'overflow-hidden',
                isResizing ? 'transition-none' : 'transition-[width,min-width,max-width] motion-reduce:transition-none',
                'bg-sidebar',
                className,
            )}
            style={{
                width: `${currentWidth}px`,
                minWidth: `${currentWidth}px`,
                maxWidth: `${currentWidth}px`,
                ['--oc-left-sidebar-width' as string]: `${publishedWidth}px`,
                overflowX: peeking ? undefined : 'clip',
                transitionDuration: `${layoutAnimationMs}ms`,
                transitionTimingFunction: LAYOUT_ANIMATION_EASING,
            }}
        >
            {isOpen && (
                <div
                    className="pointer-events-none absolute inset-0 z-30 shadow-[inset_-0.5px_0_0_0_var(--oc-edge-strong)] rtl:shadow-[inset_0.5px_0_0_0_var(--oc-edge-strong)]"
                    aria-hidden="true"
                />
            )}
            {isOpen && (
                <div
                    className={cn(
                        'absolute inset-e-0 top-0 z-20 h-full w-[3px] cursor-col-resize hover:bg-[var(--interactive-border)]/80 transition-colors',
                        isResizing && 'bg-[var(--interactive-border)]'
                    )}
                    onPointerDown={handlePointerDown}
                    onPointerMove={handlePointerMove}
                    onPointerUp={handlePointerEnd}
                    onPointerCancel={handlePointerEnd}
                    onLostPointerCapture={handlePointerEnd}
                    role="separator"
                    aria-orientation="vertical"
                    aria-label={t('sidebar.resize.leftPanelAria')}
                />
            )}
            <aside
                ref={peek?.overlayRef}
                data-sidebar-peek={peeking ? peekState : undefined}
                className={cn(
                    'flex h-full shrink-0 flex-col',
                    peeking
                        ? 'absolute inset-s-0 top-0 z-[25] bg-sidebar shadow-xl'
                        : 'relative z-10 transition-opacity ease-out motion-reduce:transition-none',
                    isResizing && 'pointer-events-none',
                    !isOpen && !peeking && 'pointer-events-none select-none opacity-0'
                )}
                style={{
                    width: 'var(--oc-left-sidebar-width)',
                    transitionDuration: `${layoutAnimationMs}ms`,
                    overflowX: 'hidden',
                    contentVisibility: contentSkipped && !peeking ? 'hidden' : undefined,
                    animation: peekAnimation,
                    // SAFETY: a CSS custom property, which `CSSProperties` has no key for.
                    ['--oc-peek-offset' as string]: direction === 'rtl' ? '100%' : '-100%',
                }}
                inert={(!isOpen && !peeking) || undefined}
                onPointerEnter={peeking ? peek?.overlayHandlers.onPointerEnter : undefined}
                onPointerLeave={peeking ? peek?.overlayHandlers.onPointerLeave : undefined}
                onAnimationEnd={peeking ? peek?.overlayHandlers.onAnimationEnd : undefined}
            >
                {topBar}
                <ScrollableOverlay outerClassName="overlay-scrollbar-wrapper--no-gutter flex-1 min-h-0" disableHorizontal>
                    <ErrorBoundary>{children}</ErrorBoundary>
                </ScrollableOverlay>
            </aside>
        </div>
    );
};
