/**
 * The composer's draft text, held outside React state.
 *
 * The editor owns the document; this mirrors it on every change, so event
 * handlers read the text the user sees without waiting for a render, and a
 * keystroke re-renders only the subscribers whose derived value changed
 * (`useComposerTextValue`). Work that ran in an effect keyed on the text runs
 * from `useComposerTextEffect` instead.
 */

import React from 'react';

export interface ComposerText {
    get(): string;
    /** Replaces the text and tells subscribers; an equal text tells nobody. */
    set(text: string): void;
    subscribe(listener: () => void): () => void;
}

export function createComposerText(initial: string): ComposerText {
    let text = initial;
    const listeners = new Set<() => void>();
    return {
        get: () => text,
        set(next) {
            if (next === text) return;
            text = next;
            for (const listener of [...listeners]) listener();
        },
        subscribe(listener) {
            listeners.add(listener);
            return () => {
                listeners.delete(listener);
            };
        },
    };
}

/**
 * A value derived from the text. The component re-renders only when the
 * derived value changes, so `select` returns a primitive or a stable reference.
 */
export function useComposerTextValue<T>(text: ComposerText, select: (value: string) => T): T {
    return React.useSyncExternalStore(text.subscribe, () => select(text.get()));
}

/**
 * Runs `onText` with the current text now, again after every change, and
 * again when `deps` change: an effect keyed on the text and `deps`. A cleanup
 * it returns runs before the next call and on teardown.
 */
export function useComposerTextEffect(
    text: ComposerText,
    onText: (value: string) => void | (() => void),
    deps: React.DependencyList,
): void {
    React.useEffect(() => {
        let cleanup = onText(text.get());
        const unsubscribe = text.subscribe(() => {
            cleanup?.();
            cleanup = onText(text.get());
        });
        return () => {
            unsubscribe();
            cleanup?.();
        };
        // The caller lists what `onText` reads, as with any effect.
        // oxlint-disable-next-line react-hooks/exhaustive-deps
    }, [text, ...deps]);
}
