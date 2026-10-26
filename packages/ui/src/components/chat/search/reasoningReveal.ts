import React from 'react';

// A search hit in the agent's reasoning leads to text that is usually folded
// away twice: inside a collapsed turn's activity, and inside the collapsed
// reasoning block. Whoever opens such a hit names its message here before the
// message link moves the timeline; the turn fold (MessageList) and the
// reasoning block (ReasoningPart) read it and open. Only the newest target is
// kept; a hit outside reasoning clears it.

type RevealTarget = { readonly messageId: string; readonly serial: number };

let target: RevealTarget | null = null;
let nextSerial = 1;
const listeners = new Set<() => void>();

export const requestReasoningReveal = (messageId: string | null): void => {
    if (target === null && messageId === null) return;
    target = messageId ? { messageId, serial: nextSerial++ } : null;
    for (const listener of listeners) listener();
};

/** Read at call time by code that is not rendering. */
export const isReasoningRevealTarget = (messageId: string): boolean => target?.messageId === messageId;

const subscribe = (listener: () => void) => {
    listeners.add(listener);
    return () => {
        listeners.delete(listener);
    };
};

/** A number that changes each time this message's reasoning is asked to open; 0 when it is not. */
export const useReasoningReveal = (messageId: string): number => React.useSyncExternalStore(
    subscribe,
    () => (target?.messageId === messageId ? target.serial : 0),
    () => 0,
);
