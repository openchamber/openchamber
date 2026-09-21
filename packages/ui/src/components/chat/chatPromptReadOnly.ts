import type { Session } from '@opencode-ai/sdk/v2';
import { isReviewSession } from '@/lib/sessionReviewMetadata';

export const resolveChatPromptReadOnly = (
    session: Session | null | undefined,
    allowPromptingSubagentSessions: boolean,
    readOnly: boolean,
): boolean => {
    // Review sessions are independent conversations even if an older server or
    // cached record still carries parentID. Their explicit metadata is the
    // authority; only the surface itself may make them read-only.
    if (isReviewSession(session)) {
        return readOnly;
    }

    if (session?.parentID) {
        return !allowPromptingSubagentSessions;
    }

    return readOnly;
};
