import React from 'react';
import { createPortal } from 'react-dom';
import { cn } from '@/lib/utils';

/** The selection menu's frame and mobile safe-area placement, shared by both selection modes. */
export const TextSelectionToolbar = React.forwardRef<HTMLDivElement, React.HTMLAttributes<HTMLDivElement> & {
    mobile: boolean;
}>(function TextSelectionToolbar({ mobile, className, children, ...props }, ref) {
    const toolbar = (
        <div
            {...props}
            ref={ref}
            data-slot="text-selection-toolbar"
            className={cn(
                mobile
                    ? 'fixed inset-s-3 inset-e-3 bottom-[calc(0.5rem+env(safe-area-inset-bottom,0px))] z-50 mx-auto flex max-w-[420px] flex-col gap-2 rounded-2xl p-2 oc-glass-popover oc-glass-floating'
                    : 'flex items-center whitespace-nowrap rounded-full p-1 oc-glass-popover oc-glass-floating',
                className,
            )}
        >
            {children}
        </div>
    );
    return mobile ? createPortal(toolbar, document.body) : toolbar;
});

/** Mobile actions keep the text-selection menu's rounded tile, spacing and tone. */
export const TextSelectionToolbarAction = React.forwardRef<HTMLButtonElement, React.ButtonHTMLAttributes<HTMLButtonElement> & {
    mobile: boolean;
    primary?: boolean;
}>(function TextSelectionToolbarAction({ mobile, primary = false, className, type = 'button', ...props }, ref) {
    return (
        <button
            {...props}
            ref={ref}
            type={type}
            className={cn(
                'flex min-w-0 items-center gap-2 text-start text-sm font-medium leading-tight active:opacity-80 disabled:opacity-60 disabled:cursor-not-allowed transition-opacity duration-150',
                mobile ? 'rounded-xl px-3 py-2.5' : 'rounded-full px-3.5 py-1.5 hover:bg-[var(--interactive-hover)]',
                primary ? 'bg-[var(--primary-base)] text-[var(--primary-foreground)]' : cn('text-foreground', mobile && 'bg-foreground/[0.04]'),
                className,
            )}
        />
    );
});
