import React from 'react';
import { applyModelPickToRetry } from '@/sync/session-actions';
import { useSelectionStore } from '@/sync/selection-store';
import { useSessionStatus } from '@/sync/sync-context';

export function useRetryModelPick(sessionId: string | null, directory: string | undefined): void {
    const status = useSessionStatus(sessionId ?? '', directory);
    const retryAttempt = status?.type === 'retry' ? status.attempt : undefined;
    const pick = useSelectionStore((state) => {
        const model = sessionId ? state.getSessionModelPick(sessionId) : null;
        return model ? `${model.providerId}/${model.modelId}` : null;
    });

    React.useEffect(() => {
        if (!sessionId || retryAttempt === undefined || !pick) return;
        applyModelPickToRetry(sessionId, directory).catch((error) => {
            console.warn('[useRetryModelPick] Model switch during retry failed:', error);
        });
    }, [directory, pick, retryAttempt, sessionId]);
}
