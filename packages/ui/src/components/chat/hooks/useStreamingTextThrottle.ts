import React from 'react';

interface UseStreamingTextThrottleInput {
    text: string;
    isStreaming: boolean;
    throttleMs?: number;
    identityKey?: string;
    allowTextReplacement?: boolean;
}

const DEFAULT_STREAMING_TEXT_THROTTLE_MS = 100;

export const getStreamingThrottleText = (
    current: string,
    next: string,
    isStreaming: boolean,
    allowTextReplacement: boolean,
): string => {
    return isStreaming && !allowTextReplacement && current.length > next.length ? current : next;
};

const computeStreamingThrottleDelay = (lastEmitAt: number, now: number, throttleMs: number): number => {
    const elapsed = now - lastEmitAt;
    return Math.max(0, throttleMs - elapsed);
};

interface StreamingThrottleState {
    timer: ReturnType<typeof setTimeout> | null;
    pendingText: string;
    lastEmitAt: number;
}

const clearTimer = (state: StreamingThrottleState): void => {
    if (!state.timer) {
        return;
    }
    clearTimeout(state.timer);
    state.timer = null;
};

export const useStreamingTextThrottle = ({
    text,
    isStreaming,
    throttleMs = DEFAULT_STREAMING_TEXT_THROTTLE_MS,
    identityKey,
    allowTextReplacement = false,
}: UseStreamingTextThrottleInput): string => {
    const [throttledText, setThrottledText] = React.useState(text);
    const latestTextRef = React.useRef(text);
    const throttledTextRef = React.useRef(throttledText);

    const stateRef = React.useRef<StreamingThrottleState>({
        timer: null,
        pendingText: text,
        lastEmitAt: 0,
    });

    React.useEffect(() => {
        latestTextRef.current = text;
    }, [text]);

    React.useEffect(() => {
        throttledTextRef.current = throttledText;
    }, [throttledText]);

    React.useEffect(() => {
        const state = stateRef.current;
        clearTimer(state);
        state.pendingText = latestTextRef.current;
        state.lastEmitAt = 0;
        setThrottledText(latestTextRef.current);
    }, [identityKey]);

    React.useEffect(() => {
        const state = stateRef.current;
        state.pendingText = text;
        const currentThrottled = throttledTextRef.current;
        const stableText = getStreamingThrottleText(currentThrottled, text, isStreaming, allowTextReplacement);

        if (!isStreaming) {
            clearTimer(state);
            state.lastEmitAt = Date.now();
            setThrottledText(stableText);
            return;
        }

        const now = Date.now();
        const remaining = computeStreamingThrottleDelay(state.lastEmitAt, now, throttleMs);

        if (remaining <= 0) {
            clearTimer(state);
            state.lastEmitAt = now;
            setThrottledText(stableText);
            return;
        }

        clearTimer(state);
        state.timer = setTimeout(() => {
            state.timer = null;
            state.lastEmitAt = Date.now();
            setThrottledText((prev) => {
                return getStreamingThrottleText(prev, state.pendingText, isStreaming, allowTextReplacement);
            });
        }, remaining);

        return () => {
            clearTimer(state);
        };
    }, [allowTextReplacement, isStreaming, text, throttleMs]);

    React.useEffect(() => {
        const state = stateRef.current;
        return () => {
            clearTimer(state);
        };
    }, []);

    return throttledText;
};
