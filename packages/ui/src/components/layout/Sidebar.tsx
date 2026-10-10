import React from 'react';
import { cn } from '@/lib/utils';
import { ErrorBoundary } from '../ui/ErrorBoundary';
import { useI18n } from '@/lib/i18n';
import { useUIStore } from '@/stores/useUIStore';
import { ScrollableOverlay } from '@/components/ui/ScrollableOverlay';
import { beginLayoutAnimation, LAYOUT_ANIMATION_EASING, runWhenLayoutSettled } from '@/lib/layoutAnimation';
import { useLayoutAnimationMs } from '@/hooks/useLayoutAnimationMs';

const SIDEBAR_CONTENT_WIDTH = 280;
// Wide enough for the toolbar's eight icons and a labelled titlebar button.
const SIDEBAR_MIN_WIDTH = 264;
const SIDEBAR_MAX_WIDTH = 500;

interface SidebarProps {
    isOpen: boolean;
    isMobile: boolean;
    children: React.ReactNode;
    className?: string;
    /** Fixed strip rendered above the scrollable content (e.g. toggle + project actions). */
    topBar?: React.ReactNode;
}

export const Sidebar: React.FC<SidebarProps> = ({ isOpen, isMobile, children, className, topBar }) => {
    const { t } = useI18n();
    const sidebarWidth = useUIStore((state) => state.sidebarWidth);
    const setSidebarWidth = useUIStore((state) => state.setSidebarWidth);
    const [isResizing, setIsResizing] = React.useState(false);
    const startXRef = React.useRef(0);
    const startWidthRef = React.useRef(sidebarWidth || SIDEBAR_CONTENT_WIDTH);
    const resizingWidthRef = React.useRef<number | null>(null);
    const activeResizePointerIDRef = React.useRef<number | null>(null);
    const sidebarRef = React.useRef<HTMLDivElement | null>(null);

    const clampSidebarWidth = React.useCallback((value: number) => {
        return Math.min(SIDEBAR_MAX_WIDTH, Math.max(SIDEBAR_MIN_WIDTH, value));
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
        // A drag writes the DOM directly and does not re-render, so the root
        // copy has to be written here too or the titlebar overlay keeps
        // capping itself to the width the drag started from.
        document.documentElement.style.setProperty('--oc-left-sidebar-width', `${nextWidth}px`);
    }, []);

    React.useEffect(() => {
        if (isMobile && isResizing) {
            setIsResizing(false);
        }
    }, [isMobile, isResizing]);

    React.useEffect(() => {
        if (!isResizing) {
            resizingWidthRef.current = null;
            activeResizePointerIDRef.current = null;
        }
    }, [isResizing]);

    const openWidth = Math.min(
        SIDEBAR_MAX_WIDTH,
        Math.max(SIDEBAR_MIN_WIDTH, sidebarWidth || SIDEBAR_CONTENT_WIDTH)
    );
    const appliedWidth = isOpen ? openWidth : 0;
    const currentWidth = isResizing ? (resizingWidthRef.current ?? appliedWidth) : appliedWidth;
    const publishedWidth = isResizing ? currentWidth : openWidth;

    // The titlebar overlay that floats above the sidebar is a sibling of it, not
    // a child, so it cannot read the width published on <aside>. Publish it on
    // the root as well, the way --oc-header-height and --oc-titlebar-left-inset
    // already are, so the overlay can cap itself to the sidebar. It is the open
    // width, which a toggle leaves alone: a new value on the root restyles the
    // whole document.
    React.useEffect(() => {
        document.documentElement.style.setProperty('--oc-left-sidebar-width', `${publishedWidth}px`);
    }, [publishedWidth]);

    // The session list stays mounted while the sidebar is closed, so opening it
    // does not build the list again. Once the close animation has finished its
    // content is skipped by rendering (`content-visibility: hidden`); it is
    // shown again in the frame the sidebar starts to open.
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
        event.preventDefault();
    };

    const handlePointerMove = (event: React.PointerEvent) => {
        if (isMobile || !isResizing || activeResizePointerIDRef.current !== event.pointerId) {
            return;
        }

        const delta = event.clientX - startXRef.current;
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
    };

    // The column never changes its own accessibility state: a toggle hides or
    // shows only its content, which is the landmark (`aside`), and only through
    // `inert`. Chrome re-serializes the accessibility tree around a node whose
    // own hidden state flips, and this column sits beside the transcript, so
    // `aria-hidden` here cost a 40 to 55 ms frame at the start of every
    // toggle whenever an accessibility client was on. `inert` already removes
    // the content from the accessibility tree and from focus.
    return (
        <div
            ref={sidebarRef}
            data-left-sidebar=""
            className={cn(
                'relative flex h-full overflow-hidden border-r border-border',
                // In the class, not the inline style: an inline transition
                // outranked `motion-reduce:transition-none`, so the sidebar
                // still animated for readers who asked for reduced motion.
                isResizing ? 'transition-none' : 'transition-[width,min-width,max-width] motion-reduce:transition-none',
                'bg-sidebar',
                !isOpen && 'border-r-0',
                className,
            )}
            style={{
                width: `${currentWidth}px`,
                minWidth: `${currentWidth}px`,
                maxWidth: `${currentWidth}px`,
                ['--oc-left-sidebar-width' as string]: `${publishedWidth}px`,
                overflowX: 'clip',
                transitionDuration: `${layoutAnimationMs}ms`,
                transitionTimingFunction: LAYOUT_ANIMATION_EASING,
            }}
        >
            {isOpen && (
                <div
                    className="pointer-events-none absolute inset-0 z-30 shadow-[inset_-2px_0_10px_-2px_rgb(0_0_0_/_0.06)]"
                    aria-hidden="true"
                />
            )}
            {isOpen && (
                <div
                    className={cn(
                        'absolute right-0 top-0 z-20 h-full w-[3px] cursor-col-resize hover:bg-[var(--interactive-border)]/80 transition-colors',
                        isResizing && 'bg-[var(--interactive-border)]'
                    )}
                    onPointerDown={handlePointerDown}
                    onPointerMove={handlePointerMove}
                    onPointerUp={handlePointerEnd}
                    onPointerCancel={handlePointerEnd}
                    role="separator"
                    aria-orientation="vertical"
                    aria-label={t('sidebar.resize.leftPanelAria')}
                />
            )}
            <aside
                className={cn(
                    'relative z-10 flex h-full shrink-0 flex-col transition-opacity duration-[120ms] ease-out motion-reduce:transition-none',
                    isResizing && 'pointer-events-none',
                    !isOpen && 'pointer-events-none select-none opacity-0'
                )}
                style={{
                    width: 'var(--oc-left-sidebar-width)',
                    overflowX: 'hidden',
                    contentVisibility: contentSkipped ? 'hidden' : undefined,
                }}
                inert={!isOpen || undefined}
            >
                {topBar}
                <ScrollableOverlay outerClassName="flex-1 min-h-0" disableHorizontal>
                    <ErrorBoundary>{children}</ErrorBoundary>
                </ScrollableOverlay>
            </aside>
        </div>
    );
};
