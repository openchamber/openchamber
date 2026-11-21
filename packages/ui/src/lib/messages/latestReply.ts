import type { Message, Part } from '@/lib/opencode/model';

import { flattenAssistantTextParts } from './messageText';

export interface LatestReply {
    messageId: string;
    text: string;
}

export interface LatestReplyRecord {
    info: Message;
    parts: Part[];
}

const completedReplyText = (record: LatestReplyRecord): string | null => {
    const { info, parts } = record;
    if (info.role !== 'assistant') return null;
    if (info.finish !== 'stop') return null;
    if (info.time.completed === undefined || info.time.completed <= 0) return null;

    const text = flattenAssistantTextParts(parts).trim();
    return text || null;
};

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

export const findCompletedReplyIds = (messages: readonly LatestReplyRecord[]): string[] => {
    const ids: string[] = [];
    for (const record of messages) {
        if (completedReplyText(record)) ids.push(record.info.id);
    }
    return ids;
};
