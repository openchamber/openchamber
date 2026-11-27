import { useSelectionStore } from '@/sync/selection-store';
import { useUIStore } from '@/stores/useUIStore';

type ColumnModel = { providerId: string; modelId: string };

export const carryColumnLevelToAgent = (
    sessionId: string,
    agentName: string,
    model: ColumnModel,
    variant: string | null | undefined,
    { fillUnremembered }: { fillUnremembered: boolean },
): void => {
    const selection = useSelectionStore.getState();
    const fillsGap = fillUnremembered
        && variant !== undefined
        && selection.getAgentModelVariantForSession(sessionId, agentName, model.providerId, model.modelId) === undefined;
    if (!useUIStore.getState().keepModelOnAgentSwitch && !fillsGap) return;
    selection.saveAgentModelVariantForSession(sessionId, agentName, model.providerId, model.modelId, variant);
};
