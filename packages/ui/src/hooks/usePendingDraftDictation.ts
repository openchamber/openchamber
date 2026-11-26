import React from 'react';

import { useInputStore } from '@/sync/input-store';

type Dependencies = {
    draftId: number | null;
    enabled: boolean;
    start: () => void;
};

export function usePendingDraftDictation({ draftId, enabled, start }: Dependencies): void {
    const pending = useInputStore((state) => state.pendingDraftDictation);

    React.useEffect(() => {
        if (!enabled || pending === null || pending.draftId !== draftId) return;
        if (!useInputStore.getState().consumePendingDraftDictation(pending.draftId)) return;
        start();
    }, [draftId, enabled, pending, start]);
}
