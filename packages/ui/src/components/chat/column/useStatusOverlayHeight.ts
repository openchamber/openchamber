import React from 'react';

// End inset reserved for the status row that floats over the timeline's
// bottom edge (its tallest resting height plus the mb-2 gap).
const STATUS_OVERLAY_RESERVED_HEIGHT = 40;

/**
 * The composer sits below the timeline, but the status/working row floats
 * OVER the timeline's bottom edge; its measured height keeps the live
 * streaming line above it and reserves matching end inset in the list.
 */
export const useStatusOverlayHeight = () => {
    const [statusOverlayHeight, setStatusOverlayHeight] = React.useState(0);
    // The reserve is fixed so the timeline's end does not move when the row
    // appears a commit after the session opened: a viewport pinned to the end
    // would otherwise be left sitting the row's height above it. Measurement
    // only extends the reserve for a taller row.
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
            // +8 for the mb-2 gap between the row and the composer, which the
            // node's own box does not include.
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
