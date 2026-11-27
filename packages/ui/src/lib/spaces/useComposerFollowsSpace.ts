import React from 'react';

import { useConfigStore } from '@/stores/useConfigStore';
import { composerModelForSpace } from './composer-space-model';
import { useSpaceModelOffer, type SpaceTarget } from './space-model-offer';
import { spaceIdOfDirectory } from './space-route';
import { isSpaceStopped } from './spaces-store';

export const useComposerFollowsSpace = (target: SpaceTarget | null, sessionId: string | null): void => {
  const offer = useSpaceModelOffer(target);
  const restored = React.useRef<string | null>(null);
  const catalog = useConfigStore((state) => state.providers);
  const activeDirectory = useConfigStore((state) => state.activeDirectoryKey);
  const requestId = target?.requestId ?? null;
  const currentProviderId = useConfigStore((state) => state.currentProviderId);
  React.useEffect(() => {
    if (!offer?.held || catalog.length === 0) return;
    if (!requestId && spaceIdOfDirectory(activeDirectory) !== offer.spaceId) return;
    const ownSessionId = sessionId && restored.current !== sessionId && isSpaceStopped(offer.spaceId) ? sessionId : null;
    if (sessionId) restored.current = sessionId;
    const model = composerModelForSpace(offer, ownSessionId);
    if (model) useConfigStore.getState().followModel(model.providerId, model.modelId);
  }, [activeDirectory, catalog, currentProviderId, offer, requestId, sessionId]);
};
