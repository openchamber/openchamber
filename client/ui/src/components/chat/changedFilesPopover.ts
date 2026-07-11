import type { CSSProperties } from 'react';

export const changedFilesPopoverClassName =
    "w-max min-w-[280px] max-w-full rounded-xl p-1 shadow-[inset_0_1px_0_0_rgba(255,255,255,0.8),inset_0_0_0_1px_rgba(0,0,0,0.04),0_0_0_1px_rgba(0,0,0,0.10),0_1px_2px_-0.5px_rgba(0,0,0,0.08),0_4px_8px_-2px_rgba(0,0,0,0.08),0_12px_20px_-4px_rgba(0,0,0,0.08)] dark:shadow-[inset_0_1px_0_0_rgba(255,255,255,0.12),inset_0_0_0_1px_rgba(255,255,255,0.08),0_0_0_1px_rgba(0,0,0,0.36),0_1px_1px_-0.5px_rgba(0,0,0,0.22),0_3px_3px_-1.5px_rgba(0,0,0,0.20),0_6px_6px_-3px_rgba(0,0,0,0.16)] origin-[var(--transform-origin)]";

export const changedFilesPopoverStyle: CSSProperties = {
    maxWidth: 'calc(100cqw - 4ch)',
    backgroundColor: 'var(--surface-elevated)',
    color: 'var(--surface-elevated-foreground)',
};
