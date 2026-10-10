import type { ChatMessageEntry, TurnRecord } from './types';

/** One row of the transcript list: a turn, or a message that belongs to no turn. */
export type TimelineEntry =
    | {
        kind: 'ungrouped';
        key: string;
        message: ChatMessageEntry;
        previousMessage?: ChatMessageEntry;
        nextMessage?: ChatMessageEntry;
    }
    | {
        kind: 'turn';
        key: string;
        turn: TurnRecord;
        isLastTurn: boolean;
        hasLaterAssistant?: boolean;
        /** The first message of the row after this turn, for the last assistant message's footer. */
        nextEntryFirstMessage?: ChatMessageEntry;
    };

type HistoryEntriesInput = {
    staticTurns: readonly TurnRecord[];
    lastTurnId: string | null;
    turnsWithLaterAssistant: ReadonlySet<string>;
    /** Every displayed message, in order; read only when some are ungrouped. */
    messages: readonly ChatMessageEntry[];
    ungroupedMessageIds: ReadonlySet<string>;
    hasStreamingTurn: boolean;
    /** First message of the live tail row, which follows the history. */
    trailingEntryFirstMessage: ChatMessageEntry | undefined;
};

const entryFirstMessage = (entry: TimelineEntry): ChatMessageEntry => (
    entry.kind === 'turn' ? entry.turn.userMessage : entry.message
);

const orderHistoryEntries = ({
    staticTurns,
    lastTurnId,
    turnsWithLaterAssistant,
    messages,
    ungroupedMessageIds,
    hasStreamingTurn,
}: HistoryEntriesInput): TimelineEntry[] => {
    const turnEntries: TimelineEntry[] = staticTurns.map((turn) => ({
        kind: 'turn',
        key: `turn:${turn.turnId}`,
        turn,
        isLastTurn: turn.turnId === lastTurnId,
        hasLaterAssistant: turnsWithLaterAssistant.has(turn.turnId),
    }));
    if (ungroupedMessageIds.size === 0) return turnEntries;

    const turnEntryByUserMessageId = new Map<string, TimelineEntry>();
    for (const entry of turnEntries) {
        turnEntryByUserMessageId.set(entryFirstMessage(entry).info.id, entry);
    }

    const ordered: TimelineEntry[] = [];
    messages.forEach((message, index) => {
        const turnEntry = turnEntryByUserMessageId.get(message.info.id);
        if (turnEntry) {
            ordered.push(turnEntry);
            return;
        }
        if (!ungroupedMessageIds.has(message.info.id)) return;
        // Without a live turn the trailing entry renders the last message.
        if (!hasStreamingTurn && index === messages.length - 1) return;
        ordered.push({
            kind: 'ungrouped',
            key: `msg:${message.info.id}`,
            message,
            previousMessage: index > 0 ? messages[index - 1] : undefined,
            nextMessage: index < messages.length - 1 ? messages[index + 1] : undefined,
        });
    });
    return ordered;
};

const isSameEntry = (previous: TimelineEntry, next: TimelineEntry): boolean => {
    if (previous.kind === 'turn' && next.kind === 'turn') {
        return previous.turn === next.turn
            && previous.isLastTurn === next.isLastTurn
            && previous.hasLaterAssistant === next.hasLaterAssistant
            && previous.nextEntryFirstMessage === next.nextEntryFirstMessage;
    }
    if (previous.kind === 'ungrouped' && next.kind === 'ungrouped') {
        return previous.message === next.message
            && previous.previousMessage === next.previousMessage
            && previous.nextMessage === next.nextMessage;
    }
    return false;
};

/**
 * The transcript's history rows (everything before the live tail).
 *
 * Rows are memoized on the entry object, so an entry whose content did not
 * change keeps the object it had in `previous`: a new turn arriving or the
 * tail re-projecting re-renders the rows that changed, not every mounted one.
 * Returns `previous` itself when no row changed.
 */
export const buildHistoryEntries = (
    input: HistoryEntriesInput,
    previous: TimelineEntry[],
): TimelineEntry[] => {
    const ordered = orderHistoryEntries(input);
    const previousByKey = new Map<string, TimelineEntry>();
    for (const entry of previous) previousByKey.set(entry.key, entry);

    let unchanged = ordered.length === previous.length;
    const entries = ordered.map((entry, index) => {
        let next = entry;
        if (entry.kind === 'turn') {
            const following = ordered[index + 1];
            const nextEntryFirstMessage = following ? entryFirstMessage(following) : input.trailingEntryFirstMessage;
            if (nextEntryFirstMessage) next = { ...entry, nextEntryFirstMessage };
        }
        const reusable = previousByKey.get(next.key);
        if (reusable && isSameEntry(reusable, next)) next = reusable;
        if (next !== previous[index]) unchanged = false;
        return next;
    });
    return unchanged ? previous : entries;
};
