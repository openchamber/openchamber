import type { Part } from '@/lib/opencode/model';
import { isSessionNoticePart, sessionNoticePlacement } from '@/lib/opencode/session-notices';

import { getNormalizedMessageForDisplay } from '../messageDisplayNormalization';
import { projectTurnRecords } from './projectTurnRecords';
import type { ChatMessageEntry, TurnRecord } from './types';

export type StreamingTailEntry =
    | {
        kind: 'ungrouped';
        key: string;
        message: ChatMessageEntry;
        nextMessage?: ChatMessageEntry;
    }
    | { kind: 'turn'; key: string; turn: TurnRecord; isLastTurn: boolean };

type BuildLiveStreamingEntryOptions = {
    livePartsByMessageId: Readonly<Record<string, Part[]>>;
    showTurnChangedFiles: boolean;
    mergeHiddenUserTurns?: boolean;
};

const liveMessageByRecord = new WeakMap<ChatMessageEntry, { parts: Part[]; message: ChatMessageEntry }>();

const withNoticeRows = (recordParts: readonly Part[], liveParts: Part[]): Part[] => {
    if (!recordParts.some(isSessionNoticePart)) return liveParts;
    const before = recordParts.filter((part) => sessionNoticePlacement(part) === 'before');
    const after = recordParts.filter((part) => sessionNoticePlacement(part) === 'after');
    return [...before, ...liveParts, ...after];
};

const withLiveParts = (
    message: ChatMessageEntry,
    livePartsByMessageId: Readonly<Record<string, Part[]>>,
): ChatMessageEntry => {
    const liveParts = livePartsByMessageId[message.info.id];
    if (!liveParts || liveParts.length === 0 || message.parts === liveParts) {
        return message;
    }

    const remembered = liveMessageByRecord.get(message);
    if (remembered?.parts === liveParts) return getNormalizedMessageForDisplay(remembered.message);
    const merged = { ...message, parts: withNoticeRows(message.parts, liveParts) };
    liveMessageByRecord.set(message, { parts: liveParts, message: merged });
    return getNormalizedMessageForDisplay(merged);
};

export const buildLiveStreamingEntry = <TEntry extends StreamingTailEntry>(
    entry: TEntry,
    options: BuildLiveStreamingEntryOptions,
): TEntry => {
    const livePartsByMessageId = options.livePartsByMessageId;

    if (entry.kind === 'ungrouped') {
        const message = withLiveParts(entry.message, livePartsByMessageId);
        if (message === entry.message) {
            return entry;
        }
        return {
            ...entry,
            message,
        };
    }

    let changed = false;
    const assistantMessages = entry.turn.assistantMessages.map((message) => {
        const next = withLiveParts(message, livePartsByMessageId);
        if (next !== message) {
            changed = true;
        }
        return next;
    });

    if (!changed) {
        return entry;
    }

    const liveMessageById = new Map(assistantMessages.map((message) => [message.info.id, message]));
    const sourceMessages = entry.turn.messages.length > 0
        ? entry.turn.messages
            .slice()
            .sort((left, right) => left.order - right.order)
            .map((record) => liveMessageById.get(record.messageId) ?? record.message)
        : [entry.turn.userMessage, ...assistantMessages];

    const projection = projectTurnRecords(sourceMessages, {
        showTurnChangedFiles: options.showTurnChangedFiles,
        mergeHiddenUserTurns: options.mergeHiddenUserTurns,
        firstMessageOpensTurn: true,
    });
    const turn = projection.turns[0] ?? {
        ...entry.turn,
        assistantMessages,
        assistantMessageIds: assistantMessages.map((message) => message.info.id),
    };

    return {
        ...entry,
        turn,
    };
};
