import { readSessionNotice } from '@/lib/opencode/session-notices';
import { isSkippedTimelineMessage } from '../timelineRoles';
import type { ChatMessageEntry, TurnRecord } from './types';

export type TimelineEntry =
    | {
        kind: 'ungrouped';
        key: string;
        message: ChatMessageEntry;
        nextMessage?: ChatMessageEntry;
        isFirstRow?: boolean;
    }
    | {
        kind: 'turn';
        key: string;
        turn: TurnRecord;
        isLastTurn: boolean;
        hasLaterAssistant?: boolean;
        nextEntryFirstMessage?: ChatMessageEntry;
    };

type HistoryEntriesInput = {
    staticTurns: readonly TurnRecord[];
    lastTurnId: string | null;
    turnsWithLaterAssistant: ReadonlySet<string>;
    messages: readonly ChatMessageEntry[];
    ungroupedMessageIds: ReadonlySet<string>;
    hasStreamingTurn: boolean;
    trailingEntryFirstMessage: ChatMessageEntry | undefined;
};

export const findFirstVisibleMessageId = (messages: readonly ChatMessageEntry[]): string | undefined => (
    messages.find((message) => !isSkippedTimelineMessage(message.info) || readSessionNotice(message.info))?.info.id
);

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

    const firstVisibleMessageId = findFirstVisibleMessageId(messages);
    const ordered: TimelineEntry[] = [];
    messages.forEach((message, index) => {
        const turnEntry = turnEntryByUserMessageId.get(message.info.id);
        if (turnEntry) {
            ordered.push(turnEntry);
            return;
        }
        if (!ungroupedMessageIds.has(message.info.id)) return;
        if (!hasStreamingTurn && index === messages.length - 1) return;
        ordered.push({
            kind: 'ungrouped',
            key: `msg:${message.info.id}`,
            message,
            nextMessage: index < messages.length - 1 ? messages[index + 1] : undefined,
            isFirstRow: message.info.id === firstVisibleMessageId,
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
            && previous.nextMessage === next.nextMessage
            && previous.isFirstRow === next.isFirstRow;
    }
    return false;
};

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
