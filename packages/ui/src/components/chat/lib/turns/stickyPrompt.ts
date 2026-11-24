import { isHiddenUserMessage } from '../../message/hiddenUserMessage';
import type { TimelineRow } from './timelineRows';
import type { ChatMessageEntry } from './types';

/**
 * Whether a prompt row can pin to the top: a real user message, not the hidden
 * context row a prompt is split into.
 */
export const turnHeaderCanStick = (userMessage: ChatMessageEntry): boolean => (
    userMessage.info.role === 'user' && !isHiddenUserMessage(userMessage)
);

/**
 * The rows the list keeps on top while what follows scrolls under them: the
 * prompts that can stick, and the answered questions' cards.
 */
export const stickyRowIndicesOf = (rows: readonly TimelineRow[]): number[] | undefined => {
    const indices: number[] = [];
    rows.forEach((row, index) => {
        if (row.kind === 'turn-head' && turnHeaderCanStick(row.entry.turn.userMessage)) indices.push(index);
        else if (row.kind === 'turn-message' && row.questionSticks) indices.push(index);
    });
    return indices.length > 0 ? indices : undefined;
};

/** A row that starts a new sticky span and pushes the header above it up: a prompt, an answered question, or an ungrouped row. */
export const endsStickySpan = (row: TimelineRow): boolean => (
    row.kind === 'turn-head' || row.kind === 'ungrouped' || (row.kind === 'turn-message' && row.questionSticks === true)
);

/**
 * How far the list has moved a pinned row below its own place, set on the
 * row's container while it is the pinned one. A row that lets go of the top
 * edge (a batch of questions) draws itself back at its place with it.
 */
export const STICKY_ROW_OFFSET = '--sticky-row-offset';
/** Dispatched (bubbling) from a row's container when its offset changes. */
export const STICKY_ROW_OFFSET_EVENT = 'stickyrowoffset';
