import React from 'react';

import { getChatDraftIdentityKey, type ChatDraftIdentity } from '@/lib/chatDraftPersistence';

interface ComposerSubmission {
    identity: ChatDraftIdentity | null;
}

const sameIdentity = (left: ChatDraftIdentity | null, right: ChatDraftIdentity | null): boolean => {
    if (!left || !right) return left === right;
    return getChatDraftIdentityKey(left) === getChatDraftIdentityKey(right);
};

const isMaterializedDraft = (
    submitted: ChatDraftIdentity | null,
    current: ChatDraftIdentity | null,
    materializedSessionId: string | null,
): boolean => Boolean(
    current
    && materializedSessionId
    && current.sessionId === materializedSessionId
    && (!submitted || (submitted.sessionId === null && submitted.runtimeKey === current.runtimeKey)),
);

const hasPendingSubmission = (
    submissions: ReadonlySet<ComposerSubmission>,
    identity: ChatDraftIdentity | null,
    materializedSessionId: string | null,
): boolean => {
    for (const submission of submissions) {
        if (
            sameIdentity(submission.identity, identity)
            || isMaterializedDraft(submission.identity, identity, materializedSessionId)
        ) {
            return true;
        }
    }
    return false;
};

export function useComposerSubmission(
    identity: ChatDraftIdentity | null,
    materializedSessionId: string | null,
) {
    const submissionsRef = React.useRef(new Set<ComposerSubmission>());
    const mountedRef = React.useRef(true);
    const [, rerender] = React.useReducer((version) => version + 1, 0);

    React.useEffect(() => {
        mountedRef.current = true;
        return () => { mountedRef.current = false; };
    }, []);
    React.useEffect(() => {
        if (!identity || !materializedSessionId) return;
        for (const submission of submissionsRef.current) {
            if (isMaterializedDraft(submission.identity, identity, materializedSessionId)) {
                submission.identity = identity;
            }
        }
    }, [identity, materializedSessionId]);

    const begin = React.useCallback(() => {
        if (hasPendingSubmission(submissionsRef.current, identity, materializedSessionId)) return null;

        const submission = { identity };
        submissionsRef.current.add(submission);
        rerender();
        return {
            finish: () => {
                if (submissionsRef.current.delete(submission) && mountedRef.current) {
                    rerender();
                }
            },
        };
    }, [identity, materializedSessionId]);

    return {
        isPending: hasPendingSubmission(submissionsRef.current, identity, materializedSessionId),
        begin,
    };
}
