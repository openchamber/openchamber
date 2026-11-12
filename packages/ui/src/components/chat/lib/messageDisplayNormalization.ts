import { normalizeParts } from '../message/partUtils';
import type { ChatMessageEntry } from './turns/types';

const normalizeMessageParts = (message: ChatMessageEntry): ChatMessageEntry => {
    const parts = normalizeParts(message.parts);
    if (parts.length === message.parts.length) {
        return message;
    }
    return {
        ...message,
        parts,
    };
};

const normalizedMessageBySource = new WeakMap<ChatMessageEntry, ChatMessageEntry>();

/**
 * The message a timeline row renders, with malformed parts dropped.
 *
 * Cached by source reference: streaming re-renders resolve an unchanged
 * message without rebuilding it, which also keeps its identity stable for the
 * turn projection.
 */
export const getNormalizedMessageForDisplay = (message: ChatMessageEntry): ChatMessageEntry => {
    const cached = normalizedMessageBySource.get(message);
    if (cached) {
        return cached;
    }

    const normalized = normalizeMessageParts(message);
    normalizedMessageBySource.set(message, normalized);
    return normalized;
};
