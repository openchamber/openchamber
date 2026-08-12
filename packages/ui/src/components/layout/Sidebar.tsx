import React from 'react';
import { cn } from '@/lib/utils';
import { ErrorBoundary } from '../ui/ErrorBoundary';
import { useI18n } from '@/lib/i18n';
import { useUIStore } from '@/stores/useUIStore';
import { usePanelResize } from './usePanelResize';

const SIDEBAR_CONTENT_WIDTH = 280;
const SIDEBAR_MIN_WIDTH = 280;
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

    const openWidth = Math.min(
        SIDEBAR_MAX_WIDTH,
        Math.max(SIDEBAR_MIN_WIDTH, sidebarWidth || SIDEBAR_CONTENT_WIDTH)
    );

    const { isResizing, containerRef, handlePointerDown, handlePointerUp, handlePointerAbort } = usePanelResize({
        minWidth: SIDEBAR_MIN_WIDTH,
        maxWidth: SIDEBAR_MAX_WIDTH,
        // Persist the manual width on pointerup ONLY — programmatic open/close
        // never touches the saved width or the manual-resize flag.
        onUserCommitWidth: setSidebarWidth,
        transactionSource: 'left-sidebar',
        widthCssVariable: '--oc-left-sidebar-width',
        // canResize also returns false on mobile: the hook cancels an in-flight
        // drag when the guard flips (the component stays mounted, returning
        // null below, so an unmount-only cleanup would never run).
        canResize: () => isOpen && !isMobile,
        getCurrentWidth: () => openWidth,
        traceSpanName: 'ui.sidebar.resize',
        // Quick open/close toggles go through the SAME per-frame width writer
        // as a pointer drag (200ms programmatic animation) so the chat anchor
        // controller keeps the seam stable. The hook is the ONLY writer of
        // --oc-left-sidebar-width; React re-renders never touch it.
        programmaticTarget: {
            key: isOpen ? 'open' : 'close',
            width: isOpen ? openWidth : 0,
            cause: 'visibility',
        },
    });

    if (isMobile) {
        return null;
    }

    return (
        <aside
            ref={containerRef}
            className={cn(
                'relative flex h-full overflow-hidden border-r border-border will-change-[width]',
                'bg-sidebar',
                !isOpen && 'border-r-0',
                className,
            )}
            style={{
                // Live flex resize: the sidebar stays in the flex row while
                // dragging, so the chat surface reflows in real time. Layout
                // containment keeps the sidebar's subtree from widening the
                // layout dirt during the drag; final width is committed once
                // on pointerup. The width is driven by the resize hook's
                // programmatic animation on open/close — no CSS width
                // transition (the JS animation is the single interpolator).
                // flex:none + the CSS variable keep React re-renders from ever
                // overriding the hook's width writes.
                contain: isResizing ? 'layout style paint' : undefined,
                flex: 'none',
                width: 'var(--oc-left-sidebar-width, 0px)',
                minWidth: 'var(--oc-left-sidebar-width, 0px)',
                maxWidth: 'var(--oc-left-sidebar-width, 0px)',
                overflowX: 'clip',
            }}
            aria-hidden={!isOpen}
        >
            {isOpen && (
                <div className="pointer-events-none absolute inset-0 z-30 shadow-[inset_-2px_0_10px_-2px_rgb(0_0_0_/_0.06)]" aria-hidden="true" />
            )}
            {isOpen && (
                <div
                    className={cn(
                        'absolute right-0 top-0 z-20 h-full w-[3px] cursor-col-resize hover:bg-[var(--interactive-border)]/80 transition-colors',
                        isResizing && 'bg-[var(--interactive-border)]'
                    )}
                    onPointerDown={handlePointerDown}
                    onPointerUp={handlePointerUp}
                    onPointerCancel={handlePointerAbort}
                    onLostPointerCapture={handlePointerAbort}
                    role="separator"
                    aria-orientation="vertical"
                    aria-label={t('sidebar.resize.leftPanelAria')}
                />
            )}
            <div
                className={cn(
                    'relative z-10 flex h-full shrink-0 flex-col transition-opacity duration-200 ease-[cubic-bezier(0.22,1,0.36,1)] motion-reduce:transition-none',
                    isResizing && 'pointer-events-none',
                    !isOpen && 'pointer-events-none select-none opacity-0'
                )}
                style={{ width: 'var(--oc-left-sidebar-width)', overflowX: 'hidden' }}
                aria-hidden={!isOpen}
            >
                {topBar}
                <div className="min-h-0 flex-1 overflow-y-auto">
                    <ErrorBoundary>{children}</ErrorBoundary>
                </div>
            </div>
        </aside>
    );
};
