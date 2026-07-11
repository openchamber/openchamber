import type { Part } from '@opencode-ai/sdk/v2';

import { filterSyntheticParts } from '@/lib/messages/synthetic';
import { normalizeParts } from '../message/partUtils';
import type { ChatMessageEntry } from './turns/types';

export const hasCompactionPart = (message: ChatMessageEntry): boolean => {
    return message.parts.some((part) => {
        const type = (part as { type?: unknown } | null | undefined)?.type;
        return type === 'compaction';
    });
};

const normalizeCompactionCommandMessage = (message: ChatMessageEntry): ChatMessageEntry => {
    if (!hasCompactionPart(message)) {
        return message;
    }

    let changedParts = false;
    const nextParts = message.parts.map((part) => {
        const type = (part as { type?: unknown } | null | undefined)?.type;
        if (type !== 'compaction') {
            return part;
        }
        changedParts = true;
        return { type: 'text', text: '/compact' } as Part;
    });

    const info = message.info as unknown as { clientRole?: string | null | undefined };
    const needsClientRole = info.clientRole !== 'user';

    if (!changedParts && !needsClientRole) {
        return message;
    }

    return {
        ...message,
        info: needsClientRole
            ? ({
                ...(message.info as unknown as Record<string, unknown>),
                clientRole: 'user',
            } as unknown as typeof message.info)
            : message.info,
        parts: changedParts ? nextParts : message.parts,
    };
};

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

export const getNormalizedMessageForDisplay = (message: ChatMessageEntry): ChatMessageEntry => {
    const cached = normalizedMessageBySource.get(message);
    if (cached) {
        return cached;
    }

    const normalizedPartMessage = normalizeMessageParts(message);
    const normalizedCompactionMessage = normalizeCompactionCommandMessage(normalizedPartMessage);
    const filteredParts = filterSyntheticParts(normalizedCompactionMessage.parts);
    const normalized = filteredParts === normalizedCompactionMessage.parts
        ? normalizedCompactionMessage
        : {
            ...normalizedCompactionMessage,
            parts: filteredParts,
        };

    normalizedMessageBySource.set(message, normalized);
    return normalized;
};
