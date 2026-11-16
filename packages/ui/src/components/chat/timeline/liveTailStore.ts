import type { RenderEntry } from './types';

/**
 * The live tail's entry with the part store's newest parts, for the rows of
 * the tail. `LiveTailSource` computes it once per publish; only the rows of
 * the tail read it, so a streamed part re-renders those and nothing else.
 */
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
