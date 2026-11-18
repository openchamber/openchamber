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
    maxHeight?: number;
    holdReserve?: boolean;
}

const mountedPanels = new WeakMap<HTMLElement, number>();

export function ComposerFloatingPanel({ header, children, compact = false, role, ariaLabel, maxHeight, holdReserve = false }: ComposerFloatingPanelProps) {
    const panelRef = React.useRef<HTMLDivElement | null>(null);
    const holdReserveRef = React.useRef(holdReserve);
    holdReserveRef.current = holdReserve;

    React.useLayoutEffect(() => {
        const panel = panelRef.current;
        const column = panel?.closest<HTMLElement>('[data-composer-bound]');
        if (!panel || !column) return;
        mountedPanels.set(column, (mountedPanels.get(column) ?? 0) + 1);
        column.setAttribute('data-floating-panel', 'true');
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
