import type { Message } from '@opencode-ai/sdk/v2';

export interface MessageRoleInfo {
    role: string;
    isUser: boolean;
}

export const deriveMessageRole = (
    messageInfo: Message | (Message & { clientRole?: string; userMessageMarker?: boolean })
): MessageRoleInfo => {
    const info = messageInfo as Message & { clientRole?: string; userMessageMarker?: boolean; origin?: string; source?: string };
    const clientRole = info?.clientRole;
    const serverRole = info?.role;
    const userMarker = info?.userMessageMarker === true;

    const isUser =
        userMarker ||
        clientRole === 'user' ||
        serverRole === 'user' ||
        info?.origin === 'user' ||
        info?.source === 'user';

    if (isUser) {
        return {
            role: 'user',
            isUser: true,
        };
    }

    return {
        role: clientRole || serverRole || 'assistant',
        isUser: false,
    };
};
