import { useLoadedOpenCodeModelSettings, useOpenCodeModelSettings } from '@/lib/opencodeModelSettings';
import React from 'react';
import { selectProvidersForDirectory, useConfigStore } from '@/stores/useConfigStore';
import { useUIStore } from '@/stores/useUIStore';
import { resolveModelRefs } from '@/lib/modelRefs';

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
  const effectiveHiddenModels = React.useMemo(() => {
    const openCodeHidden = Object.entries(openCodeSettings)
      .filter(([, settings]) => settings?.hidden === true)
      .flatMap(([key]) => {
        const slash = key.indexOf('/');
        return slash > 0 ? [{ providerID: key.slice(0, slash), modelID: key.slice(slash + 1) }] : [];
      });
    return openCodeHidden.length > 0 ? [...hiddenModels, ...openCodeHidden] : hiddenModels;
  }, [hiddenModels, openCodeSettings]);

  const favoriteModelsList = React.useMemo(
    () => resolveModelRefs(favoriteModels, providers, effectiveHiddenModels),
    [favoriteModels, providers, effectiveHiddenModels],
  );

  const recentModelsList = React.useMemo(() => {
    return resolveModelRefs(recentModels, providers, effectiveHiddenModels)
      .filter(({ providerID, modelID }) =>
        !favoriteModels.some(fav => fav.providerID === providerID && fav.modelID === modelID)
      );
  }, [recentModels, providers, favoriteModels, effectiveHiddenModels]);

  return { favoriteModelsList, recentModelsList };
};
