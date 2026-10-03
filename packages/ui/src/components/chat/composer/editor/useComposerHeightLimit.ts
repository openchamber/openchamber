import React from 'react';

import { getComposerHostHeightLimit } from './heightLimit';

interface UseComposerHeightLimitOptions {
    active: boolean;
    disabled?: boolean;
    hostRef: React.RefObject<HTMLElement | null>;
    maxLines: number;
    boundSelector?: string;
    boundGapPx?: number;
}

export function useComposerHeightLimit(options: UseComposerHeightLimitOptions): number | null {
    const {
        active,
        disabled = false,
        hostRef,
        maxLines,
        boundSelector,
        boundGapPx = 0,
    } = options;
    const [heightLimit, setHeightLimit] = React.useState<number | null>(null);

    React.useLayoutEffect(() => {
        if (!active || disabled) {
            setHeightLimit(null);
            return;
        }

        const host = hostRef.current;
        const content = host?.querySelector<HTMLElement>('.cm-content');
        const editor = host?.querySelector<HTMLElement>('[data-chat-input="true"]');
        const scroller = editor?.querySelector<HTMLElement>('.cm-scroller');
        if (!host || !content || !editor || !scroller) return;

        const bound = boundSelector ? host.closest<HTMLElement>(boundSelector) : null;
        let branch: HTMLElement | null = null;
        if (bound) {
            branch = host;
            while (branch.parentElement && branch.parentElement !== bound) {
                branch = branch.parentElement;
            }
        }

        const applyLimit = () => {
            const lineHeight = parseFloat(window.getComputedStyle(content).lineHeight || '');
            if (!Number.isFinite(lineHeight) || lineHeight <= 0) return;
            const next = getComposerHostHeightLimit({
                maxLinesHeight: lineHeight * maxLines,
                editorHeight: editor.offsetHeight,
                renderedScrollHeight: scroller.offsetHeight,
                boundHeight: bound?.clientHeight,
                // Excluding the host keeps this budget stable when its
                // failed-dictation min-height changes.
                branchHeight: bound && branch ? branch.offsetHeight : undefined,
                hostHeight: bound && branch ? host.offsetHeight : undefined,
                boundGapPx,
            });
            setHeightLimit((previous) => (previous === next ? previous : next));
        };

        applyLimit();
        if (!window.ResizeObserver) return;
        const observer = new window.ResizeObserver(applyLimit);
        observer.observe(content);
        observer.observe(editor);
        observer.observe(scroller);
        if (branch) observer.observe(branch);
        if (bound) observer.observe(bound);
        return () => observer.disconnect();
    }, [active, boundGapPx, boundSelector, disabled, hostRef, maxLines]);

    return heightLimit;
}
