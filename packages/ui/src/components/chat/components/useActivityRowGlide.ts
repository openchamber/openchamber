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

/**
 * While a working turn shows only its latest rows (above and below the pages
 * it showed), each new row pushes the oldest out at the top, and rows differ
 * in height (a one-line text, a tool row): the window grew and shrank by a
 * row's difference with every step.
 * A reader following the end glided down for the growth and was pulled back
 * up when the next step shrank it, every step. While the turn works the
 * window keeps the tallest height it has had, so the end only ever moves
 * down. Its rows stay right under the header; the space it keeps falls below
 * the newest row, where the next step lands (kept above the rows, it read as
 * a hole under the header). A grown row raises it before the frame is drawn
 * (a resize observer runs between layout and paint). A change of width is
 * no step: the rows re-wrap, and the floor follows their new height, so a
 * chat that narrowed and widened again leaves no space behind. Nor is a big
 * row leaving the window (a long reply with a table among the latest rows):
 * the floor holds no more than a few lines, or the steps after it were drawn
 * at the top of hundreds of pixels of empty space.
 */
// The most a step can shrink the window and keep its height: the difference
// between rows of a few lines and a tool row.
const LIVE_ROWS_FLOOR_HOLD_PX = 96;

export const useLiveRowsFloor = (
    floorRef: React.RefObject<HTMLElement | null>,
    contentRef: React.RefObject<HTMLElement | null>,
    active: boolean,
): void => {
    React.useLayoutEffect(() => {
        const floor = floorRef.current;
        const rows = contentRef.current;
        if (!floor || !rows) return;
        if (!active) {
            floor.style.minHeight = '';
            return;
        }
        let width = rows.offsetWidth;
        const raise = () => {
            const height = rows.offsetHeight;
            const resized = rows.offsetWidth !== width;
            width = rows.offsetWidth;
            const held = parseFloat(floor.style.minHeight) || 0;
            if (resized || height > held || held - height > LIVE_ROWS_FLOOR_HOLD_PX) floor.style.minHeight = `${height}px`;
        };
        raise();
        const observer = new ResizeObserver(raise);
        observer.observe(rows);
        return () => observer.disconnect();
    }, [active, floorRef, contentRef]);
};
