import React from 'react';

import { selectCatalogLoadedForDirectory, useConfigStore } from '@/stores/useConfigStore';
import { isSpaceDirectory } from './space-route';

export const useSpaceCatalogDirectory = (directory: string | null | undefined): string | undefined => {
  const spaceDirectory = directory && isSpaceDirectory(directory) ? directory : undefined;
  const loaded = useConfigStore((state) => spaceDirectory !== undefined && selectCatalogLoadedForDirectory(state, 'models', spaceDirectory));
  const loadProviders = useConfigStore((state) => state.loadProviders);
  React.useEffect(() => {
    if (spaceDirectory && !loaded) void loadProviders({ directory: spaceDirectory, source: 'spaceModelPicker' });
  }, [loaded, loadProviders, spaceDirectory]);
  return loaded ? spaceDirectory : undefined;
};
