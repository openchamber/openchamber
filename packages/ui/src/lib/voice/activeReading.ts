import { create } from 'zustand';

interface ActiveReading {
    key: string;
    token: symbol;
    stop: () => void;
}

const useActiveReadingStore = create<{ active: ActiveReading | null }>(() => ({ active: null }));

export const useIsReading = (key: string): boolean => (
    useActiveReadingStore((state) => state.active?.key === key)
);

export const isCurrentReading = (token: symbol): boolean => (
    useActiveReadingStore.getState().active?.token === token
);

export const stopActiveReading = (): void => {
    const { active } = useActiveReadingStore.getState();
    if (!active) return;
    useActiveReadingStore.setState({ active: null });
    active.stop();
};

export const stopReadingUnderKey = (key: string): void => {
    if (useActiveReadingStore.getState().active?.key === key) {
        stopActiveReading();
    }
};

export const startReading = (key: string, stop: () => void): symbol => {
    stopActiveReading();
    const token = Symbol(key);
    useActiveReadingStore.setState({ active: { key, token, stop } });
    return token;
};

export const finishReading = (token: symbol): void => {
    if (isCurrentReading(token)) {
        useActiveReadingStore.setState({ active: null });
    }
};

export const createReadingPlaybackGuard = <T = void>(
    token: symbol,
    canStart?: () => boolean,
    prepare?: (playback: T) => Promise<void>,
): ((playback: T) => Promise<void>) => {
    let started = false;
    const check = () => {
        if (!isCurrentReading(token) || (!started && canStart?.() === false)) {
            if (isCurrentReading(token)) stopActiveReading();
            throw new DOMException('Reading cancelled before playback', 'AbortError');
        }
    };
    return async (playback) => {
        check();
        await prepare?.(playback);
        check();
        started = true;
    };
};
