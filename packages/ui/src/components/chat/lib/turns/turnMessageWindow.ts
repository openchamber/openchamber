import React from 'react';

// A turn's assistant messages are one row of the virtualized timeline, so a
// long agentic turn mounted every step at once whenever any part of it was on
// screen. Past this many messages a turn mounts only its newest steps and
// mounts older ones as they approach the viewport.
export const TURN_MESSAGE_WINDOW_THRESHOLD = 30;
export const TURN_MESSAGE_WINDOW_TAIL = 20;
export const TURN_MESSAGE_REVEAL_CHUNK = 20;

export const initialHiddenMessageCount = (messageCount: number): number => (
    messageCount > TURN_MESSAGE_WINDOW_THRESHOLD ? messageCount - TURN_MESSAGE_WINDOW_TAIL : 0
);

/**
 * Whether mounting a batch in place of the spacer must hold the first
 * mounted message still. The batch moves everything below the spacer's top
 * by its real height minus the estimate. A spacer starting above the
 * viewport would carry what the reader sees along with it (scrolling up, by
 * several screens once the spacer peeks in and everything left mounts at
 * once), so the first mounted message is held while it is on screen or
 * above. A spacer starting inside the viewport fills in place, and one
 * covering the whole viewport leaves nothing under the reader to hold.
 */
export const shouldHoldRevealAnchor = (input: {
    spacerTop: number;
    firstMountedTop: number;
    viewTop: number;
    viewBottom: number;
}): boolean => input.spacerTop <= input.viewTop && input.firstMountedTop < input.viewBottom;

/**
 * How many leading messages each turn keeps unmounted, per open timeline.
 *
 * Lives above the rows because a turn row remounts while the timeline stays
 * (the streaming tail hands over to a static row when the turn finishes); the
 * remounted row must keep what the reader already revealed, or the content
 * above the viewport would collapse back into the estimate. Navigation also
 * writes here to mount a message it is about to scroll to.
 */
export interface TurnMessageWindowStore {
    hiddenCount: (turnId: string) => number | undefined;
    setHiddenCount: (turnId: string, count: number) => void;
    subscribe: (listener: () => void) => () => void;
}

export const createTurnMessageWindowStore = (): TurnMessageWindowStore => {
    const hidden = new Map<string, number>();
    const listeners = new Set<() => void>();
    return {
        hiddenCount: (turnId) => hidden.get(turnId),
        setHiddenCount: (turnId, count) => {
            if (hidden.get(turnId) === count) return;
            hidden.set(turnId, count);
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

// Null renders every message: windowing is off for this timeline.
export const TurnMessageWindowContext = React.createContext<TurnMessageWindowStore | null>(null);
