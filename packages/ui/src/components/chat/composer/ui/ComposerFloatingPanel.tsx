import React from 'react';
import { cn } from '@/lib/utils';

interface ComposerFloatingPanelProps {
    header: React.ReactNode;
    children?: React.ReactNode;
    compact?: boolean;
    role?: 'dialog' | 'region';
    ariaLabel?: string;
}

/** Shared dock for mutually exclusive BTW, queue, and suggestion panels. */
/** Panels mounted per chat column, so the marker survives an overlap. */
const mountedPanels = new WeakMap<HTMLElement, number>();

export function ComposerFloatingPanel({ header, children, compact = false, role, ariaLabel }: ComposerFloatingPanelProps) {
    const panelRef = React.useRef<HTMLDivElement | null>(null);

    React.useLayoutEffect(() => {
        const panel = panelRef.current;
        const column = panel?.closest<HTMLElement>('[data-composer-bound]');
        if (!panel || !column) return;
        // Marks the column while any panel is docked above the composer, so
        // chrome that would end up over the panel (the recap hint) can hide.
        mountedPanels.set(column, (mountedPanels.get(column) ?? 0) + 1);
        column.setAttribute('data-floating-panel', 'true');
        // Only the floating status/navigation overlays use this offset.
        // Transcript dimensions and scroll insets remain unchanged.
        const update = () => {
            const gap = Number.parseFloat(getComputedStyle(panel).marginBottom) || 0;
            const clearance = `${Math.ceil(panel.getBoundingClientRect().height + gap)}px`;
            if (column.style.getPropertyValue('--chat-floating-panel-clearance') !== clearance) {
                column.style.setProperty('--chat-floating-panel-clearance', clearance);
            }
        };
        update();
        const observer = globalThis.ResizeObserver ? new ResizeObserver(update) : null;
        observer?.observe(panel, { box: 'border-box' });
        return () => {
            observer?.disconnect();
            column.style.removeProperty('--chat-floating-panel-clearance');
            const remaining = (mountedPanels.get(column) ?? 1) - 1;
            if (remaining <= 0) {
                mountedPanels.delete(column);
                column.removeAttribute('data-floating-panel');
            } else {
                mountedPanels.set(column, remaining);
            }
        };
    }, []);

    return (
        <div ref={panelRef} className="chat-input-column absolute bottom-full left-0 right-0 z-30 mb-3" role={role} aria-label={ariaLabel}>
            <div className="oc-glass-popover w-full min-w-0 overflow-hidden rounded-xl border border-[var(--interactive-border)] shadow-[0_4px_16px_-4px_rgb(0_0_0_/_0.12)]">
                <div className={cn('flex items-center gap-2 px-3', compact ? 'min-h-8 py-0' : 'py-1.5')}>
                    {header}
                </div>
                {children}
            </div>
        </div>
    );
}
