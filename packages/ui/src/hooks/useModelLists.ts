import { useLoadedOpenCodeModelSettings, useOpenCodeModelSettings } from '@/lib/opencodeModelSettings';
import React from 'react';
import { selectProvidersForDirectory, useConfigStore } from '@/stores/useConfigStore';
import { useUIStore } from '@/stores/useUIStore';
import { findCatalogModel, type Model, type Provider } from '@/lib/opencode/model';

// The config store regroups OpenCode v2's flat model list under its provider.
type ProviderModel = Model;
type ProviderWithModelList = Provider & { models: ProviderModel[] };

interface ModelListItem {
  provider: ProviderWithModelList;
  model: ProviderModel;
  providerID: string;
  modelID: string;
}

// `directory` resolves favorites and recents against that directory's catalog
// (a settings page editing another project), not the active one.
export const useModelLists = (directory?: string) => {
  const providers = useConfigStore((state) => (directory === undefined
    ? state.providers
    : selectProvidersForDirectory(state, directory)));
  const favoriteModels = useUIStore((state) => state.favoriteModels);
  const recentModels = useUIStore((state) => state.recentModels);
  const hiddenModels = useUIStore((state) => state.hiddenModels);

  // OpenCode's own `hidden` (its config) keeps a model out of every picker too.
  useLoadedOpenCodeModelSettings();
  const openCodeSettings = useOpenCodeModelSettings((state) => state.models);
  const isHidden = React.useCallback((providerID: string, modelID: string) => {
    return hiddenModels.some((item) => item.providerID === providerID && item.modelID === modelID)
      || openCodeSettings[`${providerID}/${modelID}`]?.hidden === true;
  }, [hiddenModels, openCodeSettings]);

  const favoriteModelsList = React.useMemo(() => {
    return favoriteModels
      .map(({ providerID, modelID }) => {
        const provider = providers.find((p) => p.id === providerID);
        if (!provider) return null;
        const model = findCatalogModel(provider.models, modelID);
        if (!model) return null;
        if (isHidden(providerID, modelID)) return null;
        return { provider, model, providerID, modelID };
      })
      .filter((item): item is ModelListItem => item !== null);
  }, [favoriteModels, providers, isHidden]);

  const recentModelsList = React.useMemo(() => {
    return recentModels
      .map(({ providerID, modelID }) => {
        const provider = providers.find((p) => p.id === providerID);
        if (!provider) return null;
        const model = findCatalogModel(provider.models, modelID);
        if (!model) return null;
        if (isHidden(providerID, modelID)) return null;
        return { provider, model, providerID, modelID };
      })
      .filter((item): item is ModelListItem => item !== null)
      .filter(({ providerID, modelID }) =>
        !favoriteModels.some(fav => fav.providerID === providerID && fav.modelID === modelID)
      );
  }, [recentModels, providers, favoriteModels, isHidden]);

  return { favoriteModelsList, recentModelsList };
};
