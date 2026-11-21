
import React from 'react';

export interface ComposerText {
    get(): string;
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

export function useComposerTextValue<T>(text: ComposerText, select: (value: string) => T): T {
    return React.useSyncExternalStore(text.subscribe, () => select(text.get()));
}

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
        // oxlint-disable-next-line react-hooks/exhaustive-deps
    }, [text, ...deps]);
}
