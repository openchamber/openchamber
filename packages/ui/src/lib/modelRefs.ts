import { findCatalogModel, type Model, type Provider } from '@/lib/opencode/model';
import type { ModelRef } from '@/lib/settings/parsers';

type ProviderWithModelList = Provider & { models: Model[] };

export const resolveModelRefs = <P extends ProviderWithModelList>(
  refs: readonly ModelRef[],
  providers: readonly P[],
  hiddenModels: readonly ModelRef[],
): Array<ModelRef & { provider: P; model: Model }> => refs.flatMap(({ providerID, modelID }) => {
  const provider = providers.find((p) => p.id === providerID);
  const model = provider ? findCatalogModel(provider.models, modelID) : undefined;
  if (!provider || !model) return [];
  if (hiddenModels.some((item) => item.providerID === providerID && item.modelID === modelID)) return [];
  return [{ provider, model, providerID, modelID }];
});

export const getNextFavoriteModel = (
  favorites: readonly ModelRef[],
  providers: readonly ProviderWithModelList[],
  hiddenModels: readonly ModelRef[],
  current: ModelRef,
  delta: number,
): ModelRef | null => {
  const available = resolveModelRefs(favorites, providers, hiddenModels);
  if (available.length === 0) return null;
  const index = available.findIndex((item) => (
    item.providerID === current.providerID && item.modelID === current.modelID
  ));
  const { providerID, modelID } = available[(index + delta + available.length) % available.length];
  return { providerID, modelID };
};
