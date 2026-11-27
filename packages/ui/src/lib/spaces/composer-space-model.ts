import { useConfigStore } from '@/stores/useConfigStore';
import { useGlobalSessionsStore } from '@/stores/useGlobalSessionsStore';
import { useSelectionStore } from '@/sync/selection-store';
import { modelForSpaceOffer, spaceOfferAllows, type ModelChoice, type SpaceModelOffer } from './space-model-offer';

const sessionModelOf = (sessionId: string): ModelChoice | null => {
  const selection = useSelectionStore.getState();
  const saved = selection.getSessionModelPick(sessionId) ?? selection.getSessionModelSelection(sessionId);
  if (saved) return saved;
  const model = useGlobalSessionsStore.getState().activeSessions.find((session) => session.id === sessionId)?.model;
  return model ? { providerId: model.providerID, modelId: model.id } : null;
};

export const composerModelForSpace = (offer: SpaceModelOffer | null, ownSessionId: string | null): ModelChoice | null => {
  if (!offer?.held) return null;
  const { providers: catalog, currentProviderId, currentModelId } = useConfigStore.getState();
  const own = ownSessionId ? sessionModelOf(ownSessionId) : null;
  if (own && spaceOfferAllows(offer, own.providerId) && catalog.some((provider) => provider.id === own.providerId && provider.models.some((model) => model.modelID === own.modelId))) {
    return own.providerId === currentProviderId && own.modelId === currentModelId ? null : own;
  }
  return spaceOfferAllows(offer, currentProviderId) ? null : modelForSpaceOffer(offer, catalog);
};
