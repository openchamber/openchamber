import { useConfigStore } from '@/stores/useConfigStore';
import { useSelectionStore } from '@/sync/selection-store';

export const cycleThinkingVariant = (sessionId: string | null | undefined): boolean => {
  const config = useConfigStore.getState();
  if (config.getCurrentModelVariants().length === 0) return false;
  const nextVariantOverride = config.cycleCurrentVariant();
  const { currentAgentName, currentProviderId, currentModelId } = useConfigStore.getState();
  if (sessionId && currentProviderId && currentModelId) {
    useSelectionStore.getState().pickSessionModel(sessionId, currentProviderId, currentModelId);
  }
  if (sessionId && currentAgentName && currentProviderId && currentModelId) {
    useSelectionStore.getState().saveAgentModelVariantForSession(
      sessionId,
      currentAgentName,
      currentProviderId,
      currentModelId,
      nextVariantOverride,
    );
  }
  return true;
};
