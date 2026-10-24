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

/** Text of an assistant message that is a finished answer, or null for anything else. */
const completedReplyText = (record: LatestReplyRecord): string | null => {
    const { info, parts } = record;
    if (info.role !== 'assistant') return null;
    if (info.finish !== 'stop') return null;
    if (info.time.completed === undefined || info.time.completed <= 0) return null;

    const text = flattenAssistantTextParts(parts).trim();
    return text || null;
};

/**
 * The last answer of the latest prompt: the newest completed assistant
 * message that finished with `stop` and has text to read. Steps that ended in
 * tool calls, aborted turns, and messages still streaming are left out.
 */
export const findLatestCompletedReply = (messages: readonly LatestReplyRecord[]): LatestReply | null => {
    for (let index = messages.length - 1; index >= 0; index -= 1) {
        const record = messages[index];
        if (!record) continue;
        if (record.info.role === 'user') return null;

        const text = completedReplyText(record);
        if (text) return { messageId: record.info.id, text };
    }

    return null;
};

/**
 * Every finished answer in the loaded history, across all turns. Automatic
 * reading marks them as already heard at its baseline, so a later trim that
 * makes an older answer the latest reply again cannot speak it for the first
 * time.
 */
export const findCompletedReplyIds = (messages: readonly LatestReplyRecord[]): string[] => {
    const ids: string[] = [];
    for (const record of messages) {
        if (completedReplyText(record)) ids.push(record.info.id);
    }
    return ids;
};
