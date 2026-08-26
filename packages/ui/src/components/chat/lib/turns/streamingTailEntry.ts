import type { Part } from '@opencode-ai/sdk/v2';

import { getNormalizedMessageForDisplay } from '../messageDisplayNormalization';
import { projectTurnRecords } from './projectTurnRecords';
import type { ChatMessageEntry, TurnRecord } from './types';

export type StreamingTailEntry =
    | {
        kind: 'ungrouped';
        key: string;
        message: ChatMessageEntry;
        previousMessage?: ChatMessageEntry;
        nextMessage?: ChatMessageEntry;
    }
    | { kind: 'turn'; key: string; turn: TurnRecord; isLastTurn: boolean };

type BuildLiveStreamingEntryOptions = {
    // Live parts for EVERY message of the streaming tail, not only the one
    // currently streaming: when the stream moves to the next step message, the
    // previous message's base record can still lag behind the part store, and
    // rendering it from that stale snapshot briefly drops its completed tool
    // parts — remounting them (and replaying their reveal animation) once the
    // record catches up.
    livePartsByMessageId: Readonly<Record<string, Part[]>>;
    showTextJustificationActivity: boolean;
    showTurnChangedFiles: boolean;
    mergeHiddenUserTurns?: { planModeEnabled: boolean };
};

const withLiveParts = (
    message: ChatMessageEntry,
    livePartsByMessageId: Readonly<Record<string, Part[]>>,
): ChatMessageEntry => {
    const liveParts = livePartsByMessageId[message.info.id];
    // An empty live array is ambiguous — the store may simply not have loaded
    // this message's parts — and must never erase parts the record does have.
    if (!liveParts || liveParts.length === 0 || message.parts === liveParts) {
        return message;
    }

    return getNormalizedMessageForDisplay({
        ...message,
        parts: liveParts,
    });
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

    // Re-project from the turn's full ordered message records (not just
    // userMessage + assistants) so hidden user messages merged into this turn
    // keep parenting their assistant replies.
    const liveMessageById = new Map(assistantMessages.map((message) => [message.info.id, message]));
    const sourceMessages = entry.turn.messages.length > 0
        ? entry.turn.messages
            .slice()
            .sort((left, right) => left.order - right.order)
            .map((record) => liveMessageById.get(record.messageId) ?? record.message)
        : [entry.turn.userMessage, ...assistantMessages];

    const projection = projectTurnRecords(sourceMessages, {
        showTextJustificationActivity: options.showTextJustificationActivity,
        showTurnChangedFiles: options.showTurnChangedFiles,
        mergeHiddenUserTurns: options.mergeHiddenUserTurns,
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
