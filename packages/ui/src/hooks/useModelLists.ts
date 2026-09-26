import React from 'react';
import { selectProvidersForDirectory, useConfigStore } from '@/stores/useConfigStore';
import { useUIStore } from '@/stores/useUIStore';
import type { Model, Provider } from '@/lib/opencode/model';
import { findCatalogModel } from '@/lib/modelIdentity';

// The config store regroups OpenCode v2's flat model list under its provider.
type ProviderModel = Model;
type ProviderWithModelList = Provider & { models: ProviderModel[] };

export interface ModelListItem {
  provider: ProviderWithModelList;
  model: ProviderModel;
  providerID: string;
  modelID: string;
}

export const useModelLists = (directory?: string) => {
  const providers = useConfigStore((state) => directory === undefined
    ? state.providers : selectProvidersForDirectory(state, directory));
  const favoriteModels = useUIStore((state) => state.favoriteModels);
  const recentModels = useUIStore((state) => state.recentModels);
  const hiddenModels = useUIStore((state) => state.hiddenModels);

  const isHidden = React.useCallback((providerID: string, modelID: string) => {
    return hiddenModels.some((item) => item.providerID === providerID && item.modelID === modelID);
  }, [hiddenModels]);

  const resolvedFavorites = React.useMemo(() => {
    return favoriteModels
      .map(({ providerID, modelID }) => {
        const provider = providers.find((p) => p.id === providerID);
        if (!provider) return null;
        const providerModels = Array.isArray(provider.models) ? provider.models : [];
        const model = findCatalogModel(providerModels, modelID);
        if (!model) return null;
        if (isHidden(providerID, modelID) || isHidden(providerID, model.id)) return null;
        return { savedModelID: modelID, entry: { provider, model, providerID, modelID: model.id } };
      })
      .filter((item): item is { savedModelID: string; entry: ModelListItem } => item !== null);
  }, [favoriteModels, providers, isHidden]);

  // Picker rows use catalog ids; the star and reorder actions still address
  // the original persisted key until the user changes that favorite.
  const favoriteKeys = React.useMemo(() => {
    const keys = new Map<string, Map<string, string[]>>();
    for (const { savedModelID, entry: { providerID, model } } of resolvedFavorites) {
      let providerKeys = keys.get(providerID);
      if (!providerKeys) {
        providerKeys = new Map();
        keys.set(providerID, providerKeys);
      }
      const aliases = providerKeys.get(model.id) ?? [];
      aliases.push(savedModelID);
      providerKeys.set(model.id, aliases);
    }
    return keys;
  }, [resolvedFavorites]);

  const favoriteModelsList = React.useMemo(() => {
    const seen = new Map<string, Set<string>>();
    return resolvedFavorites.flatMap(({ entry }) => {
      let providerModels = seen.get(entry.providerID);
      if (!providerModels) {
        providerModels = new Set();
        seen.set(entry.providerID, providerModels);
      }
      if (providerModels.has(entry.model.id)) return [];
      providerModels.add(entry.model.id);
      return [entry];
    });
  }, [resolvedFavorites]);

  const getFavoriteModelKey = React.useCallback((providerID: string, modelID: string) => (
    favoriteKeys.get(providerID)?.get(modelID)?.[0] ?? modelID
  ), [favoriteKeys]);

  const getFavoriteModelAliases = React.useCallback((providerID: string, modelID: string) => (
    favoriteKeys.get(providerID)?.get(modelID) ?? []
  ), [favoriteKeys]);

  const recentModelsList = React.useMemo(() => {
    const seen = new Set<string>();
    return recentModels
      .map(({ providerID, modelID }) => {
        const provider = providers.find((p) => p.id === providerID);
        if (!provider) return null;
        const providerModels = Array.isArray(provider.models) ? provider.models : [];
        const model = findCatalogModel(providerModels, modelID);
        if (!model) return null;
        if (isHidden(providerID, modelID) || isHidden(providerID, model.id)) return null;
        return { provider, model, providerID, modelID: model.id };
      })
      .filter((item): item is ModelListItem => item !== null)
      .filter(({ providerID, model }) =>
        !favoriteKeys.get(providerID)?.has(model.id)
      )
      .filter(({ providerID, modelID }) => {
        const key = JSON.stringify([providerID, modelID]);
        if (seen.has(key)) return false;
        seen.add(key);
        return true;
      });
  }, [recentModels, providers, favoriteKeys, isHidden]);

  return { favoriteModelsList, recentModelsList, getFavoriteModelKey, getFavoriteModelAliases };
};
