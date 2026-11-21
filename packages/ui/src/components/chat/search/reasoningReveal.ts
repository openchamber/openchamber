import React from 'react';


type RevealTarget = { readonly messageId: string; readonly serial: number };

let target: RevealTarget | null = null;
let nextSerial = 1;
const listeners = new Set<() => void>();

export const requestReasoningReveal = (messageId: string | null): void => {
    if (target === null && messageId === null) return;
    target = messageId ? { messageId, serial: nextSerial++ } : null;
    for (const listener of listeners) listener();
};

export const isReasoningRevealTarget = (messageId: string): boolean => target?.messageId === messageId;

const subscribe = (listener: () => void) => {
    listeners.add(listener);
    return () => {
        listeners.delete(listener);
    };
};

export const useReasoningReveal = (messageId: string): number => React.useSyncExternalStore(
    subscribe,
    () => (target?.messageId === messageId ? target.serial : 0),
    () => 0,
);
