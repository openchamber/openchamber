import React from 'react';

import type { LegendListRef } from '@legendapp/list/react';

import { onNavigationRelease } from '../lib/scroll/timelineScrollIntent';
import { ANCHOR_HOLD_MAX_FRAMES, ANCHOR_HOLD_STABLE_FRAMES } from '../lib/scroll/messageViewportAnchor';

export const useNavigationSettle = (
    sessionKey: string,
    resolveScrollContainer: () => HTMLElement | null,
    listRef?: React.MutableRefObject<LegendListRef | null>,
) => {
    const cancelNavigationRef = React.useRef<(() => void) | null>(null);
    React.useLayoutEffect(() => () => {
        cancelNavigationRef.current?.();
    }, [sessionKey]);
    const settleNavigationTarget = React.useCallback((
        findElement: () => HTMLElement | null,
        readDesiredOffset: () => number,
        options?: { throughList?: boolean; rearmOnMeasurement?: boolean },
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
        let stopMeasurementListener: (() => void) | null = null;
        const cancelOnUserInput = () => {
            cancelled = true;
            window.cancelAnimationFrame(frame);
            container.removeEventListener('touchstart', cancelOnUserInput);
            container.removeEventListener('wheel', cancelOnUserInput);
            stopReleaseListener?.();
            stopMeasurementListener?.();
            if (cancelNavigationRef.current === cancelOnUserInput) cancelNavigationRef.current = null;
        };
        cancelNavigationRef.current = cancelOnUserInput;
        container.addEventListener('touchstart', cancelOnUserInput, { passive: true });
        container.addEventListener('wheel', cancelOnUserInput, { passive: true });
        stopReleaseListener = onNavigationRelease(container, cancelOnUserInput);
        if (options?.rearmOnMeasurement) {
            stopMeasurementListener = listRef?.current?.getState().listen('totalSize', () => {
                stable = 0;
            }) ?? null;
        }
        const step = () => {
            if (cancelled) return;
            const element = findElement();
            if (element) {
                const delta = element.getBoundingClientRect().top
                    - container.getBoundingClientRect().top
                    - readDesiredOffset();
                if (Math.abs(delta) > 0.5) {
                    const list = options?.throughList ? listRef?.current : null;
                    if (list) {
                        void list.scrollToOffset({ offset: container.scrollTop + delta, animated: false });
                    } else {
                        container.scrollTop += delta;
                    }
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
    }, [listRef, resolveScrollContainer]);

    return { cancelNavigationRef, settleNavigationTarget };
};
