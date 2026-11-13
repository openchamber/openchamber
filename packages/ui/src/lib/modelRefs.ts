import { findCatalogModel, type Model, type Provider } from '@/lib/opencode/model';
import type { ModelRef } from '@/lib/settings/parsers';

// The config store regroups OpenCode v2's flat model list under its provider.
type ProviderWithModelList = Provider & { models: Model[] };

/**
 * Resolves stored model refs against a catalog, in order, dropping refs whose
 * provider or model the catalog no longer lists and refs the user hid. The
 * stored lists stay untouched: favorites are shared by every project while
 * catalogs differ per directory, so a ref missing here may be live elsewhere
 * or come back when its provider is reconnected.
 */
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

/**
 * The favorite after (delta 1) or before (delta -1) `current` among the ones
 * the catalog can run, the same ones the model picker lists. From a model
 * outside that list, forward starts at the first one. Null when none resolve.
 */
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
