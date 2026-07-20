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
    activeStreamingMessageId: string | null | undefined;
    liveParts: Part[];
    showTextJustificationActivity: boolean;
    showTurnChangedFiles: boolean;
    mergeHiddenUserTurns?: { planModeEnabled: boolean };
};

const withLiveParts = (
    message: ChatMessageEntry,
    activeStreamingMessageId: string,
    liveParts: Part[],
): ChatMessageEntry => {
    if (message.info.id !== activeStreamingMessageId || message.parts === liveParts) {
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
    const activeStreamingMessageId = options.activeStreamingMessageId;
    if (!activeStreamingMessageId) {
        return entry;
    }

    if (entry.kind === 'ungrouped') {
        const message = withLiveParts(entry.message, activeStreamingMessageId, options.liveParts);
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
        const next = withLiveParts(message, activeStreamingMessageId, options.liveParts);
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
