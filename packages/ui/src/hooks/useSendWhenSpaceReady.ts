import React from 'react';

import { followPendingSpaceModel, pendingSpaceSendStep, type PendingSpaceSend } from '@/lib/spaces/space-send';
import { useSpacesStore } from '@/lib/spaces/spaces-store';

type Composer = { draftKey: string | null; providerId: string; modelId: string };

export const useSendWhenSpaceReady = <P extends PendingSpaceSend>(
  pending: P | null,
  composer: Composer,
  settle: (pending: P, send: boolean) => void,
): void => {
  const spaceState = useSpacesStore((state) => (pending ? state.journey?.get(pending.spaceId)?.state : undefined));
  const actionKind = useSpacesStore((state) => (pending ? state.actions.get(pending.spaceId)?.kind : undefined));
  const { draftKey, providerId, modelId } = composer;
  React.useEffect(() => {
    if (!pending) return;
    const step = pendingSpaceSendStep(pending, { draftKey, providerId, modelId });
    if (step === 'follow') followPendingSpaceModel(pending);
    else if (step !== 'wait') settle(pending, step === 'send');
  }, [actionKind, draftKey, modelId, pending, providerId, settle, spaceState]);
};
