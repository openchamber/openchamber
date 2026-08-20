import React from 'react';

import { getComposerHeightLimit, getComposerHostHeightLimit } from './heightLimit';

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
            const scrollHeightLimit = parseFloat(scroller.style.maxHeight || '');
            if (Number.isFinite(scrollHeightLimit) && scrollHeightLimit >= 0) {
                const next = getComposerHostHeightLimit(
                    scrollHeightLimit,
                    editor.offsetHeight,
                    scroller.offsetHeight,
                );
                setHeightLimit((previous) => (previous === next ? previous : next));
                return;
            }

            // The editor normally publishes its limit first. This fallback
            // covers its initial mount before that passive effect has run.
            const lineHeight = parseFloat(window.getComputedStyle(content).lineHeight || '');
            if (!Number.isFinite(lineHeight) || lineHeight <= 0) return;
            const next = getComposerHeightLimit({
                maxLinesHeight: lineHeight * maxLines,
                boundHeight: bound?.clientHeight,
                surroundingHeight: bound && branch
                    ? branch.offsetHeight - host.offsetHeight
                    : undefined,
                boundGapPx,
            });
            setHeightLimit((previous) => (previous === next ? previous : next));
        };

        applyLimit();
        if (typeof ResizeObserver === 'undefined') return;
        const observer = new ResizeObserver(applyLimit);
        observer.observe(content);
        observer.observe(scroller);
        if (branch) observer.observe(branch);
        if (bound) observer.observe(bound);
        const styleObserver = typeof MutationObserver === 'undefined'
            ? null
            : new MutationObserver(applyLimit);
        styleObserver?.observe(scroller, { attributes: true, attributeFilter: ['style'] });
        return () => {
            observer.disconnect();
            styleObserver?.disconnect();
        };
    }, [active, boundGapPx, boundSelector, disabled, hostRef, maxLines]);

    return heightLimit;
}
