import React from 'react';

import { useShownAfter } from '@/hooks/useShownAfter';

type SessionSelection = { sessionId: string | null; directory: string | null };

const STARVED_SWITCH_MS = 300;

export const useShownSessionSelection = <T extends SessionSelection>(
    target: T,
    newSessionDraftOpen = false,
): T => {
    const deferred = React.useDeferredValue(target);
    const settled = deferred.sessionId === target.sessionId
        || (newSessionDraftOpen && target.sessionId === null)
        || (deferred.sessionId === null && target.sessionId !== null);
    const starved = useShownAfter(!settled, STARVED_SWITCH_MS);
    return settled || (starved && target.sessionId !== null) ? target : deferred;
};
