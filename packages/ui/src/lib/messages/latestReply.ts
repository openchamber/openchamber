import type { Message, Part } from '@/lib/opencode/model';

import { flattenAssistantTextParts } from './messageText';

export interface LatestReply {
    messageId: string;
    text: string;
}

/** One entry of the session history the search reads, newest last. */
export interface LatestReplyRecord {
    info: Message;
    parts: Part[];
}

/**
 * The last answer of the latest prompt: the newest completed assistant
 * message that finished with `stop` and has text to read. Steps that ended in
 * tool calls, aborted turns, and messages still streaming are left out.
 */
export const findLatestCompletedReply = (messages: readonly LatestReplyRecord[]): LatestReply | null => {
    for (let index = messages.length - 1; index >= 0; index -= 1) {
        const record = messages[index];
        if (!record) continue;

        const { info, parts } = record;
        if (info.role === 'user') return null;
        if (info.role !== 'assistant') continue;
        if (info.finish !== 'stop') continue;
        if (info.time.completed === undefined || info.time.completed <= 0) continue;

        const text = flattenAssistantTextParts(parts).trim();
        if (text) return { messageId: info.id, text };
    }

    return null;
};
