import React from 'react';

import { useConfigStore } from '@/stores/useConfigStore';
import { followSpaceModel, spaceModelRefusal } from './space-model-access';
import { spaceIdOfDirectory } from './space-route';
import { useSpacesStore } from './spaces-store';

export const useComposerFollowsSpace = (draftDirectory: string | null): void => {
  const handled = React.useRef<string | null>(null);
  const spaceId = spaceIdOfDirectory(draftDirectory);
  const running = useSpacesStore((state) => (spaceId ? state.journey?.get(spaceId)?.state === 'running' : false));
  const catalogRead = useSpacesStore((state) => {
    const projectDirectory = spaceId ? state.journey?.get(spaceId)?.projectDirectory : null;
    return projectDirectory ? state.catalogProviders.has(projectDirectory) && state.customProviders.has(projectDirectory) : false;
  });
  const catalog = useConfigStore((state) => state.providers);
  const currentProviderId = useConfigStore((state) => state.currentProviderId);
  React.useEffect(() => {
    if (!draftDirectory || !running || !currentProviderId || handled.current === draftDirectory) return;
    if (!spaceModelRefusal({ requestId: null, directory: draftDirectory }, currentProviderId)) {
      if (catalogRead) handled.current = draftDirectory;
      return;
    }
    if (followSpaceModel(draftDirectory)) handled.current = draftDirectory;
  }, [catalog, catalogRead, currentProviderId, draftDirectory, running]);
};
