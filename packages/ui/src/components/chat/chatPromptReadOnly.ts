import type { Session } from '@opencode-ai/sdk/v2';

export const resolveChatPromptReadOnly = (
    session: Session | null | undefined,
    allowPromptingSubagentSessions: boolean,
    readOnly: boolean,
): boolean => {
    if (session?.parentID) {
        return !allowPromptingSubagentSessions;
    }

    return readOnly;
};
