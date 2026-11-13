import { useConfigStore } from '@/stores/useConfigStore';
import { useSelectionStore } from '@/sync/selection-store';

/**
 * Moves the current model to its next effort level and records the choice
 * for `sessionId`, so the session keeps it. Returns false when the model has
 * no effort levels. The keyboard shortcut and the phone's effort button both
 * cycle through this.
 */
export const cycleThinkingVariant = (sessionId: string | null | undefined): boolean => {
  const config = useConfigStore.getState();
  if (config.getCurrentModelVariants().length === 0) return false;
  const nextVariantOverride = config.cycleCurrentVariant();
  const { currentAgentName, currentProviderId, currentModelId } = useConfigStore.getState();
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
