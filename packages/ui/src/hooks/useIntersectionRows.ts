import React from 'react';

export function useIntersectionRows(scrollRef: React.RefObject<HTMLElement | null>, enabled: boolean, overscan: number) {
    const observerRef = React.useRef<IntersectionObserver | null>(null);
    const rowsRef = React.useRef(new Map<Element, (visible: boolean) => void>());
    const observeRow = React.useCallback((node: Element, update: (visible: boolean) => void) => {
        rowsRef.current.set(node, update);
        observerRef.current?.observe(node);
        return () => {
            rowsRef.current.delete(node);
            observerRef.current?.unobserve(node);
        };
    }, []);

    React.useEffect(() => {
        const root = scrollRef.current;
        if (!enabled || !root) return;
        const observer = new IntersectionObserver((changes) => {
            for (const change of changes) {
                rowsRef.current.get(change.target)?.(change.isIntersecting);
            }
        }, { root, rootMargin: `${overscan}px 0px` });
        observerRef.current = observer;
        for (const row of rowsRef.current.keys()) observer.observe(row);
        return () => {
            observer.disconnect();
            observerRef.current = null;
        };
    }, [enabled, overscan, scrollRef]);

    return observeRow;
}
