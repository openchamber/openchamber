import React from 'react';

import { onNavigationRelease } from '../lib/scroll/timelineScrollIntent';
import { ANCHOR_HOLD_MAX_FRAMES, ANCHOR_HOLD_STABLE_FRAMES } from '../lib/scroll/messageViewportAnchor';

export const useNavigationSettle = (
    sessionKey: string,
    resolveScrollContainer: () => HTMLElement | null,
) => {
    const cancelNavigationRef = React.useRef<(() => void) | null>(null);
    React.useLayoutEffect(() => () => {
        cancelNavigationRef.current?.();
    }, [sessionKey]);
    const settleNavigationTarget = React.useCallback((
        findElement: () => HTMLElement | null,
        desiredOffsetTop: number,
    ) => {
        cancelNavigationRef.current?.();
        const container = resolveScrollContainer();
        if (!container || typeof window === 'undefined') {
            return;
        }
        let frames = 0;
        let stable = 0;
        let cancelled = false;
        let frame: number;
        let stopReleaseListener: (() => void) | null = null;
        const cancelOnUserInput = () => {
            cancelled = true;
            window.cancelAnimationFrame(frame);
            container.removeEventListener('touchstart', cancelOnUserInput);
            container.removeEventListener('wheel', cancelOnUserInput);
            stopReleaseListener?.();
            if (cancelNavigationRef.current === cancelOnUserInput) cancelNavigationRef.current = null;
        };
        cancelNavigationRef.current = cancelOnUserInput;
        container.addEventListener('touchstart', cancelOnUserInput, { passive: true });
        container.addEventListener('wheel', cancelOnUserInput, { passive: true });
        stopReleaseListener = onNavigationRelease(container, cancelOnUserInput);
        const step = () => {
            if (cancelled) return;
            const element = findElement();
            if (element) {
                const delta = element.getBoundingClientRect().top
                    - container.getBoundingClientRect().top
                    - desiredOffsetTop;
                if (Math.abs(delta) > 0.5) {
                    container.scrollTop += delta;
                    stable = 0;
                } else {
                    stable += 1;
                }
            }
            frames += 1;
            if (stable >= ANCHOR_HOLD_STABLE_FRAMES || frames >= ANCHOR_HOLD_MAX_FRAMES) {
                cancelOnUserInput();
                return;
            }
            frame = window.requestAnimationFrame(step);
        };
        frame = window.requestAnimationFrame(step);
    }, [resolveScrollContainer]);

    return { cancelNavigationRef, settleNavigationTarget };
};
