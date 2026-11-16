import React from 'react';
import type { TimelineRevealGate } from '../timelineRevealGate';

// A freshly opened timeline is shown once its content height has held still
// for this many consecutive frames, or after the cap.
const TIMELINE_SETTLE_STABLE_FRAMES = 2;
const TIMELINE_SETTLE_CAP_MS = 300;

// Opening a session paints the timeline as one finished picture: the root
// stays invisible only until the viewport is in place (the scroll hook's
// hold) and the list's measured heights settle, then everything appears
// together, without a fade: it is already in place, and a fade only
// delays the moment it can be read. Markdown does not hold it: its first
// paint already has the final geometry and highlighting only recolours code.
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
        // Revealed once the geometry has settled: after the last hold the
        // list still lays rows out from its own measurements over a few
        // frames, so the timeline stays hidden — pinned to the end on every
        // frame — until the content height has held still for two frames,
        // then shows already sitting on the end. The settle is bounded so a
        // list that keeps growing (images, late tool output) still appears.
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
        // Holds are taken in layout effects, including those of rows the list
        // mounts in a nested synchronous pass; a microtask runs after all of
        // them and still before the browser paints this commit.
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
