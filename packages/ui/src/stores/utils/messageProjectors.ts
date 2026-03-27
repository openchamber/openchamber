import type { Message, Part } from '@opencode-ai/sdk/v2';

export const resolveClientRole = (info: Pick<Message, 'role'> & { clientRole?: string | null }): string => {
    const role = info.clientRole ?? info.role;
    return typeof role === 'string' ? role : '';
};

export const normalizeMessageInfoForProjection = <T extends Message>(info: T): T => {
    const clientRole = resolveClientRole(info);
    const shouldMarkUser = clientRole === 'user';

    return {
        ...info,
        clientRole,
        ...(shouldMarkUser ? { userMessageMarker: true } : {}),
    } as T;
};

export interface ChatMessageRecord {
    info: Message;
    parts: Part[];
}

export const normalizeMessageRecordsForProjection = (messages: ChatMessageRecord[]): ChatMessageRecord[] => {
    return messages.map((message) => ({
        ...message,
        info: normalizeMessageInfoForProjection(message.info),
        parts: Array.isArray(message.parts) ? message.parts : [],
    }));
};

export const filterMessagesByRevertPoint = <T extends { info: { id: string } }>(
    messages: T[],
    revertMessageId: string | null,
): T[] => {
    if (!revertMessageId) {
        return messages;
    }

    const revertIndex = messages.findIndex((message) => message.info.id === revertMessageId);
    if (revertIndex < 0) {
        return messages;
    }

    return messages.slice(0, revertIndex);
};
