import React from 'react';

const GLIDE_MS = 220;
const GLIDE_EASING = 'cubic-bezier(0.22, 1, 0.36, 1)';

const prefersReducedMotion = (): boolean => window.matchMedia('(prefers-reduced-motion: reduce)').matches;

const currentTranslateY = (element: HTMLElement): number => {
    const { transform } = getComputedStyle(element);
    if (transform === '' || transform === 'none') return 0;
    return new DOMMatrixReadOnly(transform).m42;
};

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
        const top = anchor.getBoundingClientRect().top - rows.getBoundingClientRect().top;
        const previous = previousRef.current;
        previousRef.current = { anchor, top, hiddenRows };
        if (!active || !previous || hiddenRows <= previous.hiddenRows || prefersReducedMotion()) return;
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
