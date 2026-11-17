import type { Session } from '@/lib/opencode/model';
import { isReviewSession } from '@/lib/sessionReviewMetadata';

export const resolveChatPromptReadOnly = (
    session: Session | null | undefined,
    allowPromptingSubagentSessions: boolean,
    readOnly: boolean,
    ownFolderAdmitted = true,
): boolean => {
    if (!ownFolderAdmitted) return true;
    if (isReviewSession(session)) {
        return readOnly;
    }

    if (session?.parentID) {
        return !allowPromptingSubagentSessions;
    }

    return readOnly;
};
