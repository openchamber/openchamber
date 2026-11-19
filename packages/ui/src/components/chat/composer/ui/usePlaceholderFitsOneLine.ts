import React from 'react';

let measureContext: CanvasRenderingContext2D | null | undefined;

function getMeasureContext(): CanvasRenderingContext2D | null {
    if (measureContext === undefined) {
        measureContext = document.createElement('canvas').getContext('2d');
    }
    return measureContext;
}

export function usePlaceholderFitsOneLine(
    hostRef: React.RefObject<HTMLElement | null>,
    text: string,
): boolean {
    const [fits, setFits] = React.useState(true);

    React.useLayoutEffect(() => {
        const content = hostRef.current?.querySelector<HTMLElement>('.cm-content');
        const context = getMeasureContext();
        if (!content || !context) return;

        let disposed = false;
        const measure = () => {
            if (disposed) return;
            const style = window.getComputedStyle(content);
            const available = content.clientWidth
                - (parseFloat(style.paddingLeft) || 0)
                - (parseFloat(style.paddingRight) || 0);
            if (available <= 0) return;
            context.font = `${style.fontStyle} ${style.fontWeight} ${style.fontSize} ${style.fontFamily}`;
            context.letterSpacing = style.letterSpacing === 'normal' ? '0px' : style.letterSpacing;
            const next = context.measureText(text).width <= available;
            setFits((previous) => (previous === next ? previous : next));
        };

        measure();
        void document.fonts?.ready.then(measure);

        if (typeof ResizeObserver === 'undefined') {
            window.addEventListener('resize', measure);
            return () => {
                disposed = true;
                window.removeEventListener('resize', measure);
            };
        }
        const observer = new ResizeObserver(measure);
        observer.observe(content);
        return () => {
            disposed = true;
            observer.disconnect();
        };
    }, [hostRef, text]);

    return fits;
}
