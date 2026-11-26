import type { UserModelChoice } from '@/lib/messages/userModelChoice';
import { useSelectionStore } from '@/sync/selection-store';

export const readSessionRecordModel = (sessionId: string, recordChoice: UserModelChoice | null, candidate: UserModelChoice) => {
    const key = recordChoice && candidate === recordChoice
        ? `${recordChoice.providerID}/${recordChoice.modelID}#${recordChoice.variant ?? ''}`
        : null;
    const selection = useSelectionStore.getState();
    const switched = key !== null && selection.isSessionModelSwitched(sessionId, key);
    const pick = selection.getSessionModelPick(sessionId);
    return {
        outranksSaved: key !== null && (switched || !pick),
        follow: () => {
            if (!key) return;
            if (switched && pick) selection.captureSessionModelPickSettlement(sessionId, pick.providerId, pick.modelId)();
            selection.markSessionModelFollowed(sessionId, key);
        },
    };
};
