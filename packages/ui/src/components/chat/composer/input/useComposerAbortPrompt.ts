import type { useComposerSessionScope } from './useComposerSessionScope';
import React from 'react';
import { useSessionUIStore } from '@/sync/session-ui-store';

type Dependencies = {
    sessionScope: Pick<ReturnType<typeof useComposerSessionScope>, 'currentSessionId' | 'clearAbortPrompt'>;
};

export function useComposerAbortPrompt({
    sessionScope,
}: Dependencies) {
    const { currentSessionId, clearAbortPrompt } = sessionScope;

    const abortPromptOwnerRef = React.useRef(currentSessionId);

    React.useEffect(() => {
        const previous = abortPromptOwnerRef.current;
        abortPromptOwnerRef.current = currentSessionId;
        if (previous !== currentSessionId && previous && useSessionUIStore.getState().abortPromptSessionId === previous) {
            clearAbortPrompt();
        }
    }, [currentSessionId, clearAbortPrompt]);
}
