import React from 'react';
import { cn } from '@/lib/utils';
import { GlassPopupMotion } from './GlassPopupMotion';
import { publishFloatingPanelClearance, readFloatingPanelTailReserve, withdrawFloatingPanelClearance } from '../state/composerInsetReaders';

interface ComposerFloatingPanelProps {
    header: React.ReactNode;
    children?: React.ReactNode;
    compact?: boolean;
    role?: 'dialog' | 'region';
    ariaLabel?: string;
    /** Bounds the entire surface; shrinkable children receive the remaining height. */
    maxHeight?: number;
    holdReserve?: boolean;
}

/** Shared dock for the mutually exclusive BTW, permission, and form panels. */
/** Panels mounted per chat column, so the marker survives an overlap. */
const mountedPanels = new WeakMap<HTMLElement, number>();

export function ComposerFloatingPanel({ header, children, compact = false, role, ariaLabel, maxHeight, holdReserve = false }: ComposerFloatingPanelProps) {
    const panelRef = React.useRef<HTMLDivElement | null>(null);
    const holdReserveRef = React.useRef(holdReserve);
    holdReserveRef.current = holdReserve;

    React.useLayoutEffect(() => {
        const panel = panelRef.current;
        const column = panel?.closest<HTMLElement>('[data-composer-bound]');
        if (!panel || !column) return;
        // Marks the column while any panel is docked above the composer, so
        // chrome that would end up over the panel (the recap hint) can hide.
        mountedPanels.set(column, (mountedPanels.get(column) ?? 0) + 1);
        column.setAttribute('data-floating-panel', 'true');
        // The floating status/navigation overlays translate up by this
        // offset, and the transcript's tail spacer grows by it so the panel
        // never covers the last rows. Written onto those readers, not the
        // column, so a resize does not restyle the whole transcript.
        let reserve = holdReserveRef.current ? readFloatingPanelTailReserve(column) : 0;
        const update = () => {
            const gap = Number.parseFloat(getComputedStyle(panel).marginBottom) || 0;
            const clearance = Math.ceil(panel.getBoundingClientRect().height + gap);
            reserve = holdReserveRef.current ? Math.max(reserve, clearance) : clearance;
            publishFloatingPanelClearance(column, { clearance, tailReserve: reserve });
        };
        update();
        const observer = globalThis.ResizeObserver ? new ResizeObserver(update) : null;
        observer?.observe(panel, { box: 'border-box' });
        return () => {
            observer?.disconnect();
            const remaining = (mountedPanels.get(column) ?? 1) - 1;
            // A panel fading out overlaps the one replacing it; the newcomer
            // has already written its own clearance, so leave it in place.
            if (remaining <= 0) {
                withdrawFloatingPanelClearance(column);
                mountedPanels.delete(column);
                column.removeAttribute('data-floating-panel');
            } else {
                mountedPanels.set(column, remaining);
            }
        };
    }, []);

    return (
        <div ref={panelRef} className="chat-input-column absolute bottom-full inset-s-0 inset-e-0 z-30 mb-3" role={role} aria-label={ariaLabel}>
            {/* Shadow on the wrapper, never on the glass: see "Floating composer"
                in composer/DOCUMENTATION.md. */}
            <GlassPopupMotion className="origin-bottom rounded-xl">
            <div className={cn('oc-glass-popover oc-glass-floating w-full min-w-0 overflow-hidden rounded-xl', maxHeight !== undefined && 'flex flex-col')} style={{ maxHeight }}>
                <div className={cn('flex shrink-0 items-center gap-2 px-3', compact ? 'min-h-8 py-0' : 'py-1.5')}>
                    {header}
                </div>
                {children}
            </div>
            </GlassPopupMotion>
        </div>
    );
}
