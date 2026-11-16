import * as React from 'react';

export function usePreviewReturnScroll(
    previewKey: string | null,
): React.RefCallback<HTMLElement> {
    const scroller = React.useRef<HTMLElement | null>(null);
    const listScrollTop = React.useRef(0);
    const recordedFrom = React.useRef<HTMLElement | null>(null);
    const previewShown = React.useRef(false);
    const shownBefore = React.useRef<string | null>(null);

    // external: https://drafts.csswg.org/cssom-view/#dom-element-scrolltop A list-to-preview swap clamps the offset before its scroll event arrives.
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
