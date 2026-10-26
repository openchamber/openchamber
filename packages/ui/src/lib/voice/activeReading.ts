import { create } from 'zustand';

// One reading at a time across the app: starting a new one stops whichever
// is playing. Readings started under the same key (the whole-message button,
// the mobile action sheet and the selection menu of one message) show as one:
// every control under that key sees it playing and can stop it, whichever of
// them started it.
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

/** Stops the reading in progress and records this one; the token identifies it. */
export const startReading = (key: string, stop: () => void): symbol => {
    stopActiveReading();
    const token = Symbol(key);
    useActiveReadingStore.setState({ active: { key, token, stop } });
    return token;
};

// The end of a reading that was already replaced or stopped must not clear
// the one playing now.
export const finishReading = (token: symbol): void => {
    if (isCurrentReading(token)) {
        useActiveReadingStore.setState({ active: null });
    }
};
