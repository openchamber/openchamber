import React from 'react';
import { createPortal } from 'react-dom';
import { cn } from '@/lib/utils';

/** Shared selection chrome. On phones it floats over the composer at the safe-area edge. */
export const SelectionActionPanel = React.forwardRef<HTMLDivElement, React.HTMLAttributes<HTMLDivElement> & {
    mobile: boolean;
    opaque?: boolean;
}>(function SelectionActionPanel({ mobile, opaque = false, children, className, ...props }, ref) {
    const panel = (
        <div
            ref={ref}
            {...props}
            className={cn(mobile ? 'fixed inset-s-3 inset-e-3 z-50' : 'relative', className)}
            style={mobile ? { bottom: 'calc(0.5rem + env(safe-area-inset-bottom, 0px))', ...props.style } : props.style}
        >
            <div className={cn('shadow-[0_4px_16px_-4px_rgb(0_0_0_/_0.12)]', mobile ? 'mx-auto max-w-[420px] rounded-2xl' : 'rounded-full')}>
                <div className={cn(
                    'border border-[var(--interactive-border)]',
                    opaque ? 'oc-surface-floating' : 'oc-glass-popover',
                    mobile ? 'safe-area-bottom rounded-2xl p-2' : 'rounded-full p-1',
                )}>
                    {children}
                </div>
            </div>
        </div>
    );
    return mobile ? createPortal(panel, document.body) : panel;
});
