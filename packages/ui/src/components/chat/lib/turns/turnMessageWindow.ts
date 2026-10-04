import React from 'react';

// A turn's assistant messages are one row of the virtualized timeline, so a
// long agentic turn mounted every step at once whenever any part of it was on
// screen. Past this many messages a turn mounts only a window of its steps
// and mounts the rest as they approach the viewport.
export const TURN_MESSAGE_WINDOW_THRESHOLD = 30;
export const TURN_MESSAGE_WINDOW_SIZE = 20;
export const TURN_MESSAGE_REVEAL_CHUNK = 20;

/**
 * Which messages of a turn are mounted: all but the first `hiddenHead` and
 * the last `hiddenTail`. A hidden head stands in for older steps above the
 * reader; a hidden tail for later steps below. Only a settled turn ever has
 * a hidden tail, so steps appended by a running turn are always mounted.
 */
export interface TurnMessageWindowRange {
    readonly hiddenHead: number;
    readonly hiddenTail: number;
}

export const FULL_MESSAGE_WINDOW: TurnMessageWindowRange = { hiddenHead: 0, hiddenTail: 0 };

const windowedCount = (messageCount: number): number => (
    messageCount > TURN_MESSAGE_WINDOW_THRESHOLD ? messageCount - TURN_MESSAGE_WINDOW_SIZE : 0
);

// A turn coming into view at the live end shows its newest steps.
export const initialMessageWindow = (messageCount: number): TurnMessageWindowRange => ({
    hiddenHead: windowedCount(messageCount),
    hiddenTail: 0,
});

/**
 * The window of a settled activity fold the reader just opened: the end of
 * the fold that stays on screen. A reader on the timeline's end is held
 * there, so the fold grows upward from the final answer and its newest steps
 * are what they see; anywhere else the header stays put, the fold opens
 * downward, and its first steps are what they see.
 */
export const openedFoldMessageWindow = (messageCount: number, readerAtEnd: boolean): TurnMessageWindowRange => (
    readerAtEnd
        ? { hiddenHead: windowedCount(messageCount), hiddenTail: 0 }
        : { hiddenHead: 0, hiddenTail: windowedCount(messageCount) }
);

/**
 * Whether mounting a batch in place of the head spacer must hold the first
 * mounted message still. The batch moves everything below the spacer's top
 * by its real height minus the estimate. A spacer starting above the
 * viewport would carry what the reader sees along with it (scrolling up, by
 * several screens once the spacer peeks in and everything left mounts at
 * once), so the first mounted message is held while it is on screen or
 * above. A spacer starting inside the viewport fills in place, and one
 * covering the whole viewport leaves nothing under the reader to hold. A
 * tail spacer needs no hold: it grows below what the reader sees.
 */
export const shouldHoldRevealAnchor = (input: {
    spacerTop: number;
    firstMountedTop: number;
    viewTop: number;
    viewBottom: number;
}): boolean => input.spacerTop <= input.viewTop && input.firstMountedTop < input.viewBottom;

/**
 * The mounted window of each turn, per open timeline.
 *
 * Lives above the rows because a turn row remounts while the timeline stays
 * (the streaming tail hands over to a static row when the turn finishes); the
 * remounted row must keep what the reader already revealed, or the content
 * above the viewport would collapse back into the estimate. Opening a settled
 * fold writes here to pick the end it opens at, and navigation to mount a
 * message it is about to scroll to.
 */
export interface TurnMessageWindowStore {
    range: (turnId: string) => TurnMessageWindowRange | undefined;
    setRange: (turnId: string, range: TurnMessageWindowRange) => void;
    subscribe: (listener: () => void) => () => void;
}

export const createTurnMessageWindowStore = (): TurnMessageWindowStore => {
    const ranges = new Map<string, TurnMessageWindowRange>();
    const listeners = new Set<() => void>();
    return {
        range: (turnId) => ranges.get(turnId),
        setRange: (turnId, range) => {
            const current = ranges.get(turnId);
            if (current && current.hiddenHead === range.hiddenHead && current.hiddenTail === range.hiddenTail) return;
            ranges.set(turnId, range);
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
