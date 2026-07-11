import type { Message } from '@opencode-ai/sdk/v2';

import type { ChatMessageEntry } from './types';

const resolveMessageRole = (message: ChatMessageEntry): string | null => {
    const info = message.info as { clientRole?: string | null; role?: string | null };
    return (typeof info.clientRole === 'string' ? info.clientRole : null)
        ?? (typeof info.role === 'string' ? info.role : null)
        ?? null;
};

interface RetryOverlayInput {
    sessionId: string | null;
    message: string;
    confirmedAt?: number;
    fallbackTimestamp: number;
}

export const applyRetryOverlay = (
    messages: ChatMessageEntry[],
    input: RetryOverlayInput,
): ChatMessageEntry[] => {
    if (!input.sessionId) {
        return messages;
    }

    const retryError = {
        name: 'SessionRetry',
        message: input.message,
        data: { message: input.message },
    };

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

    if (targetAssistantIndex >= 0) {
        const existing = messages[targetAssistantIndex];
        const existingInfo = existing.info as { error?: unknown };
        if (existingInfo.error) {
            return messages;
        }

        return messages.map((message, index) => {
            if (index !== targetAssistantIndex) {
                return message;
            }
            return {
                ...message,
                info: {
                    ...(message.info as Record<string, unknown>),
                    error: retryError,
                } as unknown as Message,
            };
        });
    }

    const eventTime = typeof input.confirmedAt === 'number' ? input.confirmedAt : input.fallbackTimestamp;
    const syntheticId = `synthetic_retry_notice_${input.sessionId}`;
    const synthetic: ChatMessageEntry = {
        info: {
            id: syntheticId,
            sessionID: input.sessionId,
            role: 'assistant',
            time: { created: eventTime, completed: eventTime },
            finish: 'stop',
            error: retryError,
        } as unknown as Message,
        parts: [],
    };

    const next = messages.slice();
    next.splice(lastUserIndex + 1, 0, synthetic);
    return next;
};
