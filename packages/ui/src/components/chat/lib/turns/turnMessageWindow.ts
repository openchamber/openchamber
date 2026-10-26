import React from 'react';

// A turn's assistant messages are one row of the virtualized timeline, so a
// long agentic turn mounted every step at once whenever any part of it was on
// screen. Past this many rows a turn mounts only a window of them and mounts
// the rest as they approach the viewport. A row is what MessageBody draws for
// one part (a tool call, a text, a reasoning block; `activityRows.ts`), so a
// step that made dozens of parallel calls counts as dozens, not as one.
export const TURN_ROW_WINDOW_THRESHOLD = 60;
export const TURN_ROW_WINDOW_SIZE = 40;
export const TURN_ROW_REVEAL_CHUNK = 40;

/**
 * Which rows of a turn are mounted: all but the first `hiddenHead` and the
 * last `hiddenTail`. A hidden head stands in for older steps above the
 * reader; a hidden tail for later steps below. Only a settled turn ever has
 * a hidden tail, so rows appended by a running turn are always mounted.
 */
export interface TurnMessageWindowRange {
    readonly hiddenHead: number;
    readonly hiddenTail: number;
}

export const FULL_MESSAGE_WINDOW: TurnMessageWindowRange = { hiddenHead: 0, hiddenTail: 0 };

const windowedCount = (rowCount: number): number => (
    rowCount > TURN_ROW_WINDOW_THRESHOLD ? rowCount - TURN_ROW_WINDOW_SIZE : 0
);

// A turn coming into view at the live end shows its newest steps.
export const initialMessageWindow = (rowCount: number): TurnMessageWindowRange => ({
    hiddenHead: windowedCount(rowCount),
    hiddenTail: 0,
});

/**
 * The window of a settled activity fold the reader just opened. Its header
 * stays where the reader clicked it, also on the timeline's end (opening a
 * row lets go of the end, see useChatTimelineScroll), so the fold opens
 * downward and its first steps are what they see.
 */
export const openedFoldMessageWindow = (rowCount: number): TurnMessageWindowRange => ({
    hiddenHead: 0,
    hiddenTail: windowedCount(rowCount),
});

/** How a row range falls on the turn's messages. */
interface MountedMessages {
    // Messages at the start hidden whole, and rows of the next one skipped.
    readonly headMessages: number;
    readonly headSkipRows: number;
    // Messages at the end hidden whole.
    readonly tailMessages: number;
    // Rows the head and tail spacers stand in for.
    readonly hiddenHeadRows: number;
    readonly hiddenTailRows: number;
}

/**
 * Lays a row range onto messages of `rowsPerMessage` rows each. The head can
 * end inside a message, whose first rows MessageBody then skips; the tail
 * hides whole messages only, so it may mount a few of its rows early, and it
 * never reaches the message the head cuts into.
 */
export const resolveMountedMessages = (
    rowsPerMessage: readonly number[],
    range: TurnMessageWindowRange,
): MountedMessages => {
    let totalRows = 0;
    for (const rows of rowsPerMessage) totalRows += rows;
    const hiddenHeadRows = Math.min(range.hiddenHead, totalRows);
    let headLeft = hiddenHeadRows;
    let headMessages = 0;
    while (headMessages < rowsPerMessage.length && headLeft > 0 && rowsPerMessage[headMessages] <= headLeft) {
        headLeft -= rowsPerMessage[headMessages];
        headMessages += 1;
    }
    const firstTailCandidate = headMessages + (headLeft > 0 ? 1 : 0);
    let tailLeft = Math.min(range.hiddenTail, totalRows - hiddenHeadRows);
    let tailMessages = 0;
    let hiddenTailRows = 0;
    while (rowsPerMessage.length - tailMessages - 1 >= firstTailCandidate && tailLeft > 0) {
        const rows = rowsPerMessage[rowsPerMessage.length - tailMessages - 1];
        if (rows > tailLeft) break;
        tailLeft -= rows;
        hiddenTailRows += rows;
        tailMessages += 1;
    }
    return { headMessages, headSkipRows: headLeft, tailMessages, hiddenHeadRows, hiddenTailRows };
};

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
