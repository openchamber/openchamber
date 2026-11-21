import React from 'react';

type SessionSelection = { sessionId: string | null; directory: string | null };

export const useShownSessionSelection = <T extends SessionSelection>(
    target: T,
    newSessionDraftOpen = false,
): T => {
    const deferred = React.useDeferredValue(target);
    if (deferred.sessionId === target.sessionId) return target;
    if (newSessionDraftOpen && target.sessionId === null) return target;
    return deferred.sessionId === null && target.sessionId !== null ? target : deferred;
};
