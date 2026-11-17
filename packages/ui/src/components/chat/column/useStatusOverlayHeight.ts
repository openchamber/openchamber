import React from 'react';

const STATUS_OVERLAY_RESERVED_HEIGHT = 40;

export const useStatusOverlayHeight = () => {
    const [statusOverlayHeight, setStatusOverlayHeight] = React.useState(0);
    const composerOverlayHeight = Math.max(STATUS_OVERLAY_RESERVED_HEIGHT, statusOverlayHeight);
    const statusOverlayObserverRef = React.useRef<ResizeObserver | null>(null);
    const onStatusOverlayNode = React.useCallback((node: HTMLDivElement | null) => {
        statusOverlayObserverRef.current?.disconnect();
        statusOverlayObserverRef.current = null;
        if (!node || !globalThis.ResizeObserver) {
            setStatusOverlayHeight(0);
            return;
        }
        const update = () => {
            const height = node.getBoundingClientRect().height + 8;
            setStatusOverlayHeight((prev) => (Math.abs(prev - height) < 1 ? prev : height));
        };
        const observer = new ResizeObserver(update);
        observer.observe(node);
        statusOverlayObserverRef.current = observer;
        update();
    }, []);
    React.useEffect(() => () => {
        statusOverlayObserverRef.current?.disconnect();
        statusOverlayObserverRef.current = null;
    }, []);

    return { composerOverlayHeight, onStatusOverlayNode };
};
