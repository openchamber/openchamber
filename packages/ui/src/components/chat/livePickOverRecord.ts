import { shouldPreserveManualModelOverride, type UserModelChoice } from '@/lib/messages/userModelChoice';
import { useSelectionStore } from '@/sync/selection-store';

export const livePickOverRecord = (
    sessionId: string,
    sessionRecordChoice: UserModelChoice | null,
    candidate: UserModelChoice | null,
    selectionSource: 'auto' | 'manual' | undefined,
) => {
    const sessionModel = sessionRecordChoice?.providerID && sessionRecordChoice.modelID
        ? { providerID: sessionRecordChoice.providerID, id: sessionRecordChoice.modelID, variant: sessionRecordChoice.variant }
        : undefined;
    const pick = useSelectionStore.getState().liveSessionModelPick(sessionId, sessionModel);
    return shouldPreserveManualModelOverride({ selectionSource, savedSessionModel: pick, candidate }) ? pick : null;
};
