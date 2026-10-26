import React from 'react';

const GLIDE_MS = 220;
const GLIDE_EASING = 'cubic-bezier(0.22, 1, 0.36, 1)';

const prefersReducedMotion = (): boolean => window.matchMedia('(prefers-reduced-motion: reduce)').matches;

// The translation an animation in flight currently applies to the element.
const currentTranslateY = (element: HTMLElement): number => {
    const { transform } = getComputedStyle(element);
    if (transform === '' || transform === 'none') return 0;
    return new DOMMatrixReadOnly(transform).m42;
};

/**
 * While a working turn shows only its latest rows, a new row pushes the
 * oldest one out at the top and everything moves up by its height at once.
 * This replays that move as a short glide: after the commit, the rows are drawn
 * back where they were and slide into place (FLIP). Only `transform` changes,
 * so layout, scroll following and the reader's position stay as they are. The
 * last element of the rows is the reference: it is the one that grows, and it
 * stays mounted between steps.
 */
export const useActivityRowGlide = (
    rowsRef: React.RefObject<HTMLElement | null>,
    hiddenRows: number,
    active: boolean,
): void => {
    const previousRef = React.useRef<{ anchor: Element; top: number; hiddenRows: number } | null>(null);

    React.useLayoutEffect(() => {
        const rows = rowsRef.current;
        const anchor = rows?.lastElementChild;
        if (!rows || !anchor) {
            previousRef.current = null;
            return;
        }
        // Layout positions: both rects carry the same running transform.
        const top = anchor.getBoundingClientRect().top - rows.getBoundingClientRect().top;
        const previous = previousRef.current;
        previousRef.current = { anchor, top, hiddenRows };
        if (!active || !previous || hiddenRows <= previous.hiddenRows || prefersReducedMotion()) return;
        // The row the eye follows moved up: the anchor if it is still there,
        // else nothing reliable to measure against.
        if (!previous.anchor.isConnected) return;
        const previousAnchorTop = previous.anchor.getBoundingClientRect().top - rows.getBoundingClientRect().top;
        const delta = previous.top - previousAnchorTop;
        if (delta <= 0.5) return;
        const from = delta + currentTranslateY(rows);
        for (const animation of rows.getAnimations()) animation.cancel();
        rows.animate(
            [{ transform: `translateY(${from}px)` }, { transform: 'translateY(0)' }],
            { duration: GLIDE_MS, easing: GLIDE_EASING },
        );
    });
};
