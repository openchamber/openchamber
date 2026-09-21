import type { ChatMessageEntry } from './turns/types';

export const USER_SHELL_MARKER = 'The following tool was executed by the user';

const resolveMessageRole = (message: ChatMessageEntry): string | null => {
    const info = message.info as unknown as { clientRole?: string | null | undefined; role?: string | null | undefined };
    return (typeof info.clientRole === 'string' ? info.clientRole : null)
        ?? (typeof info.role === 'string' ? info.role : null)
        ?? null;
};

const getMessageParentId = (message: ChatMessageEntry): string | null => {
    const info = message.info as unknown as { parentID?: unknown };
    return typeof info.parentID === 'string' && info.parentID.length > 0 ? info.parentID : null;
};

export const isUserShellMarkerMessage = (message: ChatMessageEntry | undefined): boolean => {
    if (!message) return false;
    if (resolveMessageRole(message) !== 'user') return false;

    return message.parts.some((part) => {
        if (part?.type !== 'text') return false;
        const text = (part as unknown as { text?: unknown }).text;
        const synthetic = (part as unknown as { synthetic?: unknown }).synthetic;
        return synthetic === true && typeof text === 'string' && text.trim().startsWith(USER_SHELL_MARKER);
    });
};

export type ShellBridgeDetails = {
    command?: string;
    output?: string;
    status?: string;
};

export const getShellBridgeAssistantDetails = (
    message: ChatMessageEntry,
    expectedParentId: string | null,
): { hide: boolean; details: ShellBridgeDetails | null } => {
    if (resolveMessageRole(message) !== 'assistant') {
        return { hide: false, details: null };
    }

    if (expectedParentId && getMessageParentId(message) !== expectedParentId) {
        return { hide: false, details: null };
    }

    if (message.parts.length !== 1) {
        return { hide: false, details: null };
    }

    const part = message.parts[0] as unknown as {
        type?: unknown;
        tool?: unknown;
        state?: {
            status?: unknown;
            input?: { command?: unknown };
            output?: unknown;
            metadata?: { output?: unknown };
        };
    };

    if (part?.type !== 'tool') {
        return { hide: false, details: null };
    }

    const toolName = typeof part.tool === 'string' ? part.tool.toLowerCase() : '';
    if (toolName !== 'bash') {
        return { hide: false, details: null };
    }

    const command = typeof part.state?.input?.command === 'string' ? part.state.input.command : undefined;
    const output =
        (typeof part.state?.output === 'string' ? part.state.output : undefined)
        ?? (typeof part.state?.metadata?.output === 'string' ? part.state.metadata.output : undefined);
    const status = typeof part.state?.status === 'string' ? part.state.status : undefined;

    return {
        hide: true,
        details: {
            command,
            output,
            status,
        },
    };
};

/**
 * Finds the shell command a user shell-mode message executed by locating its
 * assistant bridge message (single bash tool part parented to the user
 * message) among the following entries.
 */
export const findShellCommandForMessage = (
    messages: ChatMessageEntry[],
    userIndex: number,
): string | null => {
    const userMessage = messages[userIndex];
    if (!userMessage) return null;
    const userId = userMessage.info.id;

    for (let index = userIndex + 1; index < messages.length; index += 1) {
        const candidate = messages[index];
        if (resolveMessageRole(candidate) === 'user') {
            break;
        }
        const { hide, details } = getShellBridgeAssistantDetails(candidate, userId);
        if (hide) {
            const command = typeof details?.command === 'string' ? details.command.trim() : '';
            return command.length > 0 ? command : null;
        }
    }

    return null;
};
