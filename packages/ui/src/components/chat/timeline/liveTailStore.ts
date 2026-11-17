import type { RenderEntry } from './types';

export type LiveTailStore = {
    get: () => RenderEntry | null;
    set: (entry: RenderEntry | null) => void;
    notify: () => void;
    subscribe: (listener: () => void) => () => void;
};

export const createLiveTailStore = (): LiveTailStore => {
    let current: RenderEntry | null = null;
    const listeners = new Set<() => void>();
    return {
        get: () => current,
        set: (entry) => {
            current = entry;
        },
        notify: () => {
            for (const listener of listeners) listener();
        },
        subscribe: (listener) => {
            listeners.add(listener);
            return () => {
                listeners.delete(listener);
            };
        },
    };
};
