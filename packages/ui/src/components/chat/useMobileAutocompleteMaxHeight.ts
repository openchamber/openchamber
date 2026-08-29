import React from 'react';

/**
 * Clamp an autocomplete popup (anchored above the composer via `bottom-full`)
 * so it never rises past the top of the chat area. The chat `<main>` starts
 * below the app header, so its top edge is the correct boundary.
 *
 * Re-measures on window resizes and when the native keyboard choreography
 * settles (the composer — and therefore the popup's anchor — moves with it).
 *
 * Returns an inline max-height only when the available space is smaller than
 * the popup's normal CSS height cap. This keeps the desktop cap intact while
 * still protecting the header on tall draft composers.
 */
export const useMobileAutocompleteMaxHeight = (
    containerRef: React.RefObject<HTMLElement | null>,
    enabled: boolean,
    normalMaxHeight = 256,
): number | undefined => {
    const [maxHeight, setMaxHeight] = React.useState<number | undefined>(undefined);

    React.useLayoutEffect(() => {
        if (!enabled) return;
        const measure = () => {
            const el = containerRef.current;
            if (!el) return;
            const main = el.closest('main');
            if (!main) return;
            // Mobile browsers pan the page up to reveal the focused field, so
            // <main>'s top can sit above the visible screen. The binding
            // boundary is whichever is lower: the chat area's top or the
            // visual viewport's top.
            const visualTop = window.visualViewport?.offsetTop ?? 0;
            const boundaryTop = Math.max(main.getBoundingClientRect().top, visualTop);
            // The popup's bottom edge is its anchor (composer top) and does not
            // depend on its current height.
            const available = Math.max(0, Math.floor(el.getBoundingClientRect().bottom - boundaryTop - 8));
            // Floor: browser keyboard panning can put the anchor above the
            // measured boundary for a frame (or for the whole pan), which
            // would collapse the popup to zero height. A short popup that
            // slightly overlaps the header beats an invisible one.
            const next = available < normalMaxHeight ? Math.max(120, available) : undefined;
            setMaxHeight((prev) => (prev === next ? prev : next));
        };
        measure();
        window.addEventListener('resize', measure);
        window.addEventListener('oc:keyboard-settled', measure);
        window.visualViewport?.addEventListener('resize', measure);
        window.visualViewport?.addEventListener('scroll', measure);
        return () => {
            window.removeEventListener('resize', measure);
            window.removeEventListener('oc:keyboard-settled', measure);
            window.visualViewport?.removeEventListener('resize', measure);
            window.visualViewport?.removeEventListener('scroll', measure);
        };
    });

    return enabled ? maxHeight : undefined;
};
