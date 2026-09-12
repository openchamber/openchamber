import React from 'react';
import { useConfigStore } from '@/stores/useConfigStore';
import { useUIStore } from '@/stores/useUIStore';
import type { Provider } from '@opencode-ai/sdk/v2';

type ProviderModel = Provider["models"][string];
type ProviderWithModelList = Omit<Provider, "models"> & { models: ProviderModel[] };

export interface ModelListItem {
  provider: ProviderWithModelList;
  model: ProviderModel;
  providerID: string;
  modelID: string;
}

export const useModelLists = () => {
  const providers = useConfigStore((state) => state.providers);
  const favoriteModels = useUIStore((state) => state.favoriteModels);
  const recentModels = useUIStore((state) => state.recentModels);
  const hiddenModels = useUIStore((state) => state.hiddenModels);
  const disabledProviders = useUIStore((state) => state.disabledProviders);

  const isHidden = React.useCallback((providerID: string, modelID: string) => {
    return hiddenModels.some((item) => item.providerID === providerID && item.modelID === modelID);
  }, [hiddenModels]);

  // A disabled provider is hidden from every selector, including the
  // favorites/recent shortcuts that bypass the per-provider sections.
  const isProviderDisabled = React.useCallback((providerID: string) => {
    return disabledProviders.includes(providerID);
  }, [disabledProviders]);

  const favoriteModelsList = React.useMemo(() => {
    return favoriteModels
      .map(({ providerID, modelID }) => {
        const provider = providers.find((p) => p.id === providerID);
        if (!provider) return null;
        const providerModels = Array.isArray(provider.models) ? provider.models : [];
        const model = providerModels.find((m: ProviderModel) => m.id === modelID);
        if (!model) return null;
        if (isProviderDisabled(providerID)) return null;
        if (isHidden(providerID, modelID)) return null;
        return { provider, model, providerID, modelID };
      })
      .filter((item): item is ModelListItem => item !== null);
  }, [favoriteModels, providers, isHidden, isProviderDisabled]);

  const recentModelsList = React.useMemo(() => {
    return recentModels
      .map(({ providerID, modelID }) => {
        const provider = providers.find((p) => p.id === providerID);
        if (!provider) return null;
        const providerModels = Array.isArray(provider.models) ? provider.models : [];
        const model = providerModels.find((m: ProviderModel) => m.id === modelID);
        if (!model) return null;
        if (isProviderDisabled(providerID)) return null;
        if (isHidden(providerID, modelID)) return null;
        return { provider, model, providerID, modelID };
      })
      .filter((item): item is ModelListItem => item !== null)
      .filter(({ providerID, modelID }) =>
        !favoriteModels.some(fav => fav.providerID === providerID && fav.modelID === modelID)
      );
  }, [recentModels, providers, favoriteModels, isHidden, isProviderDisabled]);

  return { favoriteModelsList, recentModelsList };
};
