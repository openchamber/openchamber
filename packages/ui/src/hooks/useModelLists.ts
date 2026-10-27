import React from 'react';
import { selectProvidersForDirectory, useConfigStore } from '@/stores/useConfigStore';
import { useUIStore } from '@/stores/useUIStore';
import { resolveModelRefs } from '@/lib/modelRefs';

// `directory` resolves favorites and recents against that directory's catalog
// (a settings page editing another project), not the active one.
export const useModelLists = (directory?: string) => {
  const providers = useConfigStore((state) => (directory === undefined
    ? state.providers
    : selectProvidersForDirectory(state, directory)));
  const favoriteModels = useUIStore((state) => state.favoriteModels);
  const recentModels = useUIStore((state) => state.recentModels);
  const hiddenModels = useUIStore((state) => state.hiddenModels);

  const favoriteModelsList = React.useMemo(
    () => resolveModelRefs(favoriteModels, providers, hiddenModels),
    [favoriteModels, providers, hiddenModels],
  );

  const recentModelsList = React.useMemo(() => {
    return resolveModelRefs(recentModels, providers, hiddenModels)
      .filter(({ providerID, modelID }) =>
        !favoriteModels.some(fav => fav.providerID === providerID && fav.modelID === modelID)
      );
  }, [recentModels, providers, favoriteModels, hiddenModels]);

  return { favoriteModelsList, recentModelsList };
};
