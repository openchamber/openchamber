import React from 'react';
import { animate, type AnimationPlaybackControls } from 'motion';

type ScrollEngineOptions = {
    containerRef: React.RefObject<HTMLDivElement | null>;
    isMobile: boolean;
};

type ScrollOptions = {
    instant?: boolean;
    followBottom?: boolean; // Dynamically track bottom during streaming
    persistFollow?: boolean;
};

type ScrollEngineResult = {
    handleScroll: () => void;
    scrollToPosition: (position: number, options?: ScrollOptions) => void;
    forceManualMode: () => void;
    cancelFollow: () => void;
    isAtTop: boolean;
    isFollowingBottom: boolean;
    isManualOverrideActive: () => boolean;
    getScrollTop: () => number;
    getScrollHeight: () => number;
    getClientHeight: () => number;
};

// Spring config for one-shot scroll-to-bottom (button click, session switch).
const FAST_SPRING = {
    type: 'spring' as const,
    visualDuration: 0.35,
    bounce: 0,
};

// Exponential smoothing factor for the follow-bottom rAF loop.
// Each frame: scrollTop += (target - scrollTop) * LERP_FACTOR
// ~0.12-0.18 gives a smooth camera-follow feel at 60fps.
const LERP_FACTOR = 0.14;

// When the remaining distance is below this, snap exactly to bottom.
const SNAP_EPSILON = 0.5;
const FOLLOW_STABLE_FRAME_LIMIT = 8;

export const useScrollEngine = ({
    containerRef,
}: ScrollEngineOptions): ScrollEngineResult => {
    const [isAtTop, setIsAtTop] = React.useState(true);
    const [isFollowingBottom, setIsFollowingBottom] = React.useState(false);

    const atTopRef = React.useRef(true);
    const manualOverrideRef = React.useRef(false);

    // One-shot spring animation (for scroll-to-bottom button etc.)
    const scrollAnimRef = React.useRef<AnimationPlaybackControls | undefined>(undefined);

    // Continuous follow-bottom rAF loop (for streaming)
    const followRafRef = React.useRef<number | null>(null);
    const followActiveRef = React.useRef(false);
    const followPersistRef = React.useRef(false);

    const cancelSpring = React.useCallback(() => {
        if (scrollAnimRef.current) {
            scrollAnimRef.current.stop();
            scrollAnimRef.current = undefined;
        }
    }, []);

    const cancelFollow = React.useCallback(() => {
        if (followRafRef.current !== null && typeof window !== 'undefined') {
            window.cancelAnimationFrame(followRafRef.current);
            followRafRef.current = null;
        }
        followActiveRef.current = false;
        followPersistRef.current = false;
        setIsFollowingBottom(false);
    }, []);

    const cancelAll = React.useCallback(() => {
        cancelSpring();
        cancelFollow();
    }, [cancelSpring, cancelFollow]);

    // Continuous lerp loop that chases scrollHeight - clientHeight.
    const startFollowLoop = React.useCallback((persist = false) => {
        followPersistRef.current = persist || followPersistRef.current;
        if (followActiveRef.current) return; // already running
        followActiveRef.current = true;
        setIsFollowingBottom(true);
        let stableFrames = 0;

        const tick = () => {
            const container = containerRef.current;
            if (!container || !followActiveRef.current) {
                followActiveRef.current = false;
                followRafRef.current = null;
                setIsFollowingBottom(false);
                return;
            }

            const target = container.scrollHeight - container.clientHeight;
            const current = container.scrollTop;
            const delta = target - current;

            if (Math.abs(delta) <= SNAP_EPSILON) {
                container.scrollTop = target;
                if (followPersistRef.current) {
                    stableFrames = 0;
                    followRafRef.current = window.requestAnimationFrame(tick);
                    return;
                }
                stableFrames += 1;
                if (stableFrames >= FOLLOW_STABLE_FRAME_LIMIT) {
                    followActiveRef.current = false;
                    followRafRef.current = null;
                    setIsFollowingBottom(false);
                    return;
                }
                followRafRef.current = window.requestAnimationFrame(tick);
                return;
            }

            stableFrames = 0;
            container.scrollTop = current + delta * LERP_FACTOR;
            followRafRef.current = window.requestAnimationFrame(tick);
        };

        followRafRef.current = window.requestAnimationFrame(tick);
    }, [containerRef]);

    const scrollToPosition = React.useCallback(
        (position: number, options?: ScrollOptions) => {
            const container = containerRef.current;
            if (!container) return;

            const target = Math.max(0, position);
            const preferInstant = options?.instant ?? false;
            const followBottom = options?.followBottom ?? false;
            const persistFollow = options?.persistFollow ?? false;

            manualOverrideRef.current = false;

            // Instant scroll (session switch, etc.)
            if (typeof window === 'undefined' || preferInstant) {
                cancelAll();
                container.scrollTop = target;

                if (followBottom && typeof window !== 'undefined') {
                    startFollowLoop(persistFollow);
                }

                const atTop = target <= 1;
                if (atTopRef.current !== atTop) {
                    atTopRef.current = atTop;
                    setIsAtTop(atTop);
                }
                return;
            }

            // Follow-bottom mode: start the continuous lerp loop
            if (followBottom) {
                cancelSpring();
                startFollowLoop(persistFollow);
                return;
            }

            // One-shot scroll: stop everything and use spring animation
            cancelAll();

            const distance = Math.abs(target - container.scrollTop);
            if (distance <= SNAP_EPSILON) {
                container.scrollTop = target;
                const atTop = target <= 1;
                if (atTopRef.current !== atTop) {
                    atTopRef.current = atTop;
                    setIsAtTop(atTop);
                }
                return;
            }

            scrollAnimRef.current = animate(container.scrollTop, target, {
                ...FAST_SPRING,
                onUpdate: (v) => {
                    container.scrollTop = v;
                },
                onComplete: () => {
                    scrollAnimRef.current = undefined;
                },
            });
        },
        [cancelAll, cancelSpring, containerRef, setIsAtTop, startFollowLoop]
    );

    const forceManualMode = React.useCallback(() => {
        manualOverrideRef.current = true;
    }, []);

    const markManualOverride = React.useCallback(() => {
        manualOverrideRef.current = true;
        cancelFollow();
    }, [cancelFollow]);

    const isManualOverrideActive = React.useCallback(() => {
        return manualOverrideRef.current;
    }, []);

    const getScrollTop = React.useCallback(() => {
        return containerRef.current?.scrollTop ?? 0;
    }, [containerRef]);

    const getScrollHeight = React.useCallback(() => {
        return containerRef.current?.scrollHeight ?? 0;
    }, [containerRef]);

    const getClientHeight = React.useCallback(() => {
        return containerRef.current?.clientHeight ?? 0;
    }, [containerRef]);

    const handleScroll = React.useCallback(() => {
        const container = containerRef.current;
        if (!container) return;

        if (manualOverrideRef.current && scrollAnimRef.current) {
            cancelSpring();
        }

        const atTop = container.scrollTop <= 1;
        if (atTopRef.current !== atTop) {
            atTopRef.current = atTop;
            setIsAtTop(atTop);
        }
    }, [cancelSpring, containerRef]);

    React.useEffect(() => {
        const container = containerRef.current;
        if (!container) return;

        container.addEventListener('wheel', markManualOverride, { passive: true });
        container.addEventListener('touchstart', markManualOverride, { passive: true });

        return () => {
            container.removeEventListener('wheel', markManualOverride);
            container.removeEventListener('touchstart', markManualOverride);
        };
    }, [containerRef, markManualOverride]);

    React.useEffect(() => {
        return () => {
            cancelAll();
        };
    }, [cancelAll]);

    return React.useMemo(
        () => ({
            handleScroll,
            scrollToPosition,
            forceManualMode,
            cancelFollow,
            isAtTop,
            isFollowingBottom,
            isManualOverrideActive,
            getScrollTop,
            getScrollHeight,
            getClientHeight,
        }),
        [
            handleScroll,
            scrollToPosition,
            forceManualMode,
            cancelFollow,
            isAtTop,
            isFollowingBottom,
            isManualOverrideActive,
            getScrollTop,
            getScrollHeight,
            getClientHeight,
        ]
    );
};

export type { ScrollEngineResult, ScrollEngineOptions, ScrollOptions };
