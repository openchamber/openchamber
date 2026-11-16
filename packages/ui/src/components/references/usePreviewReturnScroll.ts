import * as React from 'react';

/**
 * Keeps a list where it was while an item preview takes its place in the same
 * scroller, and starts each preview at its top.
 *
 * The phone's picker and board swap the list for the preview inside one scroll
 * area, so the browser clamps the list's offset to the shorter preview the
 * moment it replaces it, before the item's details arrive. The offset is
 * recorded while the list scrolls and put back in a layout effect, before the
 * return is painted.
 *
 * The returned ref owns the scroller: the element is replaced when the surface
 * crosses the phone layout threshold or a boundary retries.
 */
export function usePreviewReturnScroll(
    /** The shown preview's key, or null while the list shows. */
    previewKey: string | null,
): React.RefCallback<HTMLElement> {
    const scroller = React.useRef<HTMLElement | null>(null);
    const listScrollTop = React.useRef(0);
    // The element the offset was read from: a replaced scroller has its own.
    const recordedFrom = React.useRef<HTMLElement | null>(null);
    const previewShown = React.useRef(false);
    const shownBefore = React.useRef<string | null>(null);

    // The browser reports the swap's clamped offset in a scroll event after
    // this commit, so the state is known before a preview scroll can be read
    // as the list's.
    React.useLayoutEffect(() => {
        previewShown.current = previewKey !== null;
    }, [previewKey]);

    const remember = React.useCallback(() => {
        if (previewShown.current || !scroller.current) return;
        listScrollTop.current = scroller.current.scrollTop;
        recordedFrom.current = scroller.current;
    }, []);

    const bind = React.useCallback((node: HTMLElement | null) => {
        if (scroller.current === node) return;
        scroller.current?.removeEventListener('scroll', remember);
        scroller.current = node;
        node?.addEventListener('scroll', remember, { passive: true });
    }, [remember]);

    React.useLayoutEffect(() => {
        const node = scroller.current;
        if (!node) return;
        if (previewKey !== null) node.scrollTop = 0;
        else if (shownBefore.current !== null && recordedFrom.current === node) node.scrollTop = listScrollTop.current;
        shownBefore.current = previewKey;
    }, [previewKey]);

    return bind;
}
