import React from 'react';
import type { TimelineRevealGate } from '../timelineRevealGate';

const TIMELINE_SETTLE_STABLE_FRAMES = 2;
const TIMELINE_SETTLE_CAP_MS = 300;

export const useTimelineReveal = ({
    timelineRootRef,
    scrollRef,
    revealGate,
    showingTranscript,
    endPinningReleased,
}: {
    timelineRootRef: React.RefObject<HTMLDivElement | null>;
    scrollRef: React.RefObject<HTMLDivElement | null>;
    revealGate: TimelineRevealGate;
    showingTranscript: boolean;
    endPinningReleased: boolean;
}): void => {
    const endPinningReleasedRef = React.useRef(endPinningReleased);
    endPinningReleasedRef.current = endPinningReleased;
    React.useLayoutEffect(() => {
        const root = timelineRootRef.current;
        if (!root || !showingTranscript) return;
        root.setAttribute('data-timeline-reveal', 'pending');
        let finished = false;
        let timer: number | null = null;
        let frame: number | null = null;
        const reveal = () => {
            if (finished) return;
            finished = true;
            if (timer !== null) window.clearTimeout(timer);
            const startedAt = performance.now();
            let lastHeight = -1;
            let stableFrames = 0;
            const settle = () => {
                frame = null;
                const node = scrollRef.current;
                let height = -1;
                if (node) {
                    height = node.scrollHeight;
                    if (!endPinningReleasedRef.current) {
                        const end = height - node.clientHeight;
                        if (end - node.scrollTop > 1) node.scrollTop = end;
                    }
                }
                stableFrames = height === lastHeight ? stableFrames + 1 : 0;
                lastHeight = height;
                if (stableFrames < TIMELINE_SETTLE_STABLE_FRAMES && performance.now() - startedAt < TIMELINE_SETTLE_CAP_MS) {
                    frame = window.requestAnimationFrame(settle);
                    return;
                }
                root.removeAttribute('data-timeline-reveal');
            };
            frame = window.requestAnimationFrame(settle);
        };
        queueMicrotask(() => {
            if (finished) return;
            revealGate.close();
            if (revealGate.holds === 0) {
                reveal();
                return;
            }
            revealGate.onEmpty = reveal;
            timer = window.setTimeout(reveal, revealGate.capMs);
        });
        return () => {
            finished = true;
            if (timer !== null) window.clearTimeout(timer);
            if (frame !== null) window.cancelAnimationFrame(frame);
            revealGate.onEmpty = null;
        };
    }, [revealGate, scrollRef, showingTranscript, timelineRootRef]);
};
