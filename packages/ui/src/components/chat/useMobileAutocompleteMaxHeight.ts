import React from 'react';

/**
 * Mobile: clamp an autocomplete popup (anchored above the composer via
 * `bottom-full`) so it never rises past the top of the chat area. The chat
 * `<main>` starts below the app header in both the Capacitor shell and the
 * mobile browser, so its top edge is the correct boundary for both.
 *
 * Re-measures on window resizes and when the native keyboard choreography
 * settles (the composer — and therefore the popup's anchor — moves with it).
 *
 * Returns an inline max-height in px, or undefined when disabled. NOTE: the
 * inline value REPLACES any `max-h-*` class (it does not combine) — on mobile
 * the popup is allowed to grow all the way to the boundary, unlike the
 * desktop design cap.
 */
export const useMobileAutocompleteMaxHeight = (
    containerRef: React.RefObject<HTMLElement | null>,
    enabled: boolean,
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
            // <main>'s top can sit ABOVE the visible screen (negative client
            // coordinates). The binding boundary is whichever is lower: the
            // chat area's top or the visual viewport's top (its offsetTop is
            // expressed in the same layout-viewport client coordinates).
            const visualTop = window.visualViewport?.offsetTop ?? 0;
            const boundaryTop = Math.max(main.getBoundingClientRect().top, visualTop);
            // The popup's bottom edge is its anchor (composer top) and does not
            // depend on its current height.
            const available = el.getBoundingClientRect().bottom - boundaryTop - 8;
            const next = Math.max(120, Math.floor(available));
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
