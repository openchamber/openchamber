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

    const projection = projectTurnRecords([entry.turn.userMessage, ...assistantMessages], {
        showTextJustificationActivity: options.showTextJustificationActivity,
        showTurnChangedFiles: options.showTurnChangedFiles,
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
