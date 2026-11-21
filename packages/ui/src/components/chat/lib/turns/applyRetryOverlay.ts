import type { Message } from '@/lib/opencode/model';

import type { RetryOverlay } from '../../timeline/types';
import type { ChatMessageEntry } from './types';

const resolveMessageRole = (message: ChatMessageEntry): string | null => {
    const info = message.info as { clientRole?: string | null; role?: string | null };
    return (typeof info.clientRole === 'string' ? info.clientRole : null)
        ?? (typeof info.role === 'string' ? info.role : null)
        ?? null;
};

export const applyRetryOverlay = (
    messages: ChatMessageEntry[],
    overlay: RetryOverlay | null,
): ChatMessageEntry[] => {
    if (!overlay || !overlay.sessionId) {
        return messages;
    }
    const { sessionId, lastIdleAt, notice } = overlay;

    let lastUserIndex = -1;
    for (let index = messages.length - 1; index >= 0; index -= 1) {
        if (resolveMessageRole(messages[index]) === 'user') {
            lastUserIndex = index;
            break;
        }
    }

    if (lastUserIndex < 0) {
        return messages;
    }

    let targetAssistantIndex = -1;
    for (let index = messages.length - 1; index > lastUserIndex; index -= 1) {
        if (resolveMessageRole(messages[index]) === 'assistant') {
            targetAssistantIndex = index;
            break;
        }
    }

    const existing = targetAssistantIndex >= 0 ? messages[targetAssistantIndex] : undefined;
    if (
        existing?.info.role === 'assistant'
        && existing.info.sessionID === sessionId
        && existing.info.retry
        && existing.info.error
        && (lastIdleAt === null || (existing.info.time.completed ?? existing.info.retry.at) > lastIdleAt)
    ) {
        const info = { ...existing.info };
        delete info.error;
        const next = messages.slice();
        next[targetAssistantIndex] = { ...existing, info };
        return next;
    }

    const existingInfo = existing?.info as { error?: unknown } | undefined;
    if (!notice || existingInfo?.error) {
        return messages;
    }

    const { message, confirmedAt, fallbackTimestamp } = notice;
    const retryError = { name: 'SessionRetry', message, data: { message } };
    const next = messages.slice();
    if (existing) {
        next[targetAssistantIndex] = {
            ...existing,
            info: { ...existing.info, error: retryError } as unknown as Message,
        };
        return next;
    }

    const eventTime = confirmedAt ?? fallbackTimestamp ?? 0;
    const synthetic: ChatMessageEntry = {
        info: {
            id: `synthetic_retry_notice_${sessionId}`,
            sessionID: sessionId,
            role: 'assistant',
            time: { created: eventTime, completed: eventTime },
            finish: 'stop',
            error: retryError,
        } as unknown as Message,
        parts: [],
    };

    next.splice(lastUserIndex + 1, 0, synthetic);
    return next;
};
