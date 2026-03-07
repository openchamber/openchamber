import { computeStreamingThrottleDelay } from './useStreamingTextThrottle';

const assert = (condition: unknown, message: string): void => {
    if (!condition) {
        throw new Error(message);
    }
};

export const runUseStreamingTextThrottleTests = (): void => {
    assert(
        computeStreamingThrottleDelay(0, 0, 100) === 100,
        'throttle delay should start at full interval',
    );

    assert(
        computeStreamingThrottleDelay(100, 160, 100) === 40,
        'throttle delay should shrink as elapsed time grows',
    );

    assert(
        computeStreamingThrottleDelay(100, 260, 100) === 0,
        'throttle delay should flush immediately after interval',
    );
};
