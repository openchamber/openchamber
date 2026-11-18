import React from 'react';

export const useMobileAutocompleteMaxHeight = (
    containerRef: React.RefObject<HTMLElement | null>,
    enabled: boolean,
    normalMaxHeight = 256,
    minimumHeight = 120,
): number | undefined => {
    const [maxHeight, setMaxHeight] = React.useState<number | undefined>(undefined);

    React.useLayoutEffect(() => {
        if (!enabled) return;
        const measure = () => {
            const el = containerRef.current;
            if (!el) return;
            const main = el.closest('main');
            if (!main) return;
            const visualTop = window.visualViewport?.offsetTop ?? 0;
            const boundaryTop = Math.max(main.getBoundingClientRect().top, visualTop);
            const available = Math.max(0, Math.floor(el.getBoundingClientRect().bottom - boundaryTop - 8));
            const next = available < normalMaxHeight ? Math.max(minimumHeight, available) : undefined;
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
