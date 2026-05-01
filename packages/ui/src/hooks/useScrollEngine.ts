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
    cancelAll: () => void;
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
    const followObserversRef = React.useRef<{ resize: ResizeObserver; mutation: MutationObserver } | null>(null);

    const cancelSpring = React.useCallback(() => {
        if (scrollAnimRef.current) {
            scrollAnimRef.current.stop();
            scrollAnimRef.current = undefined;
        }
    }, []);

    const teardownFollowObservers = React.useCallback(() => {
        const observers = followObserversRef.current;
        if (!observers) return;
        observers.resize.disconnect();
        observers.mutation.disconnect();
        followObserversRef.current = null;
    }, []);

    const cancelFollow = React.useCallback(() => {
        teardownFollowObservers();
        if (followRafRef.current !== null && typeof window !== 'undefined') {
            window.cancelAnimationFrame(followRafRef.current);
            followRafRef.current = null;
        }
        followActiveRef.current = false;
        followPersistRef.current = false;
        setIsFollowingBottom(false);
    }, [teardownFollowObservers]);

    const cancelAll = React.useCallback(() => {
        cancelSpring();
        cancelFollow();
    }, [cancelSpring, cancelFollow]);

    // One burst of the lerp loop — runs until scrollTop catches up to bottom, then stops.
    // Re-invoked by observers when persist mode content grows.
    const runFollowBurst = React.useCallback(() => {
        if (followActiveRef.current) return;
        const container = containerRef.current;
        if (!container) return;
        followActiveRef.current = true;
        if (!followPersistRef.current) {
            setIsFollowingBottom(true);
        }
        let stableFrames = 0;

        const tick = () => {
            const c = containerRef.current;
            if (!c || !followActiveRef.current) {
                followActiveRef.current = false;
                followRafRef.current = null;
                if (!followPersistRef.current) {
                    setIsFollowingBottom(false);
                }
                return;
            }

            const target = c.scrollHeight - c.clientHeight;
            const current = c.scrollTop;
            const delta = target - current;

            if (Math.abs(delta) <= SNAP_EPSILON) {
                c.scrollTop = target;
                stableFrames += 1;
                if (stableFrames >= FOLLOW_STABLE_FRAME_LIMIT) {
                    followActiveRef.current = false;
                    followRafRef.current = null;
                    if (!followPersistRef.current) {
                        setIsFollowingBottom(false);
                    }
                    return;
                }
                followRafRef.current = window.requestAnimationFrame(tick);
                return;
            }

            stableFrames = 0;
            c.scrollTop = current + delta * LERP_FACTOR;
            followRafRef.current = window.requestAnimationFrame(tick);
        };

        followRafRef.current = window.requestAnimationFrame(tick);
    }, [containerRef]);

    // Observer-driven persist mode — RAF bursts only fire when content actually changes.
    // No idle CPU cost while waiting for the next token.
    const setupFollowObservers = React.useCallback(() => {
        const container = containerRef.current;
        if (!container || followObserversRef.current) return;

        const onChange = () => {
            if (!followPersistRef.current) return;
            runFollowBurst();
        };

        const resize = new ResizeObserver(onChange);
        const inner = container.firstElementChild;
        if (inner instanceof Element) {
            resize.observe(inner);
        }
        resize.observe(container);

        const mutation = new MutationObserver(onChange);
        mutation.observe(container, { childList: true, subtree: true });

        followObserversRef.current = { resize, mutation };
    }, [containerRef, runFollowBurst]);

    const startFollowLoop = React.useCallback((persist = false) => {
        const wasPersist = followPersistRef.current;
        followPersistRef.current = persist || wasPersist;
        if (followPersistRef.current) {
            if (!wasPersist) {
                setIsFollowingBottom(true);
            }
            setupFollowObservers();
        }
        runFollowBurst();
    }, [runFollowBurst, setupFollowObservers]);

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
            cancelAll,
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
            cancelAll,
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
