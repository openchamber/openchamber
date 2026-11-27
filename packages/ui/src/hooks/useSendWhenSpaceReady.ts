import React from 'react';

import { pendingSpaceSendStep, type PendingSpaceSend, type SpaceSendModel } from '@/lib/spaces/space-send';
import { useSpacesStore } from '@/lib/spaces/spaces-store';

type Composer = { draftKey: string | null; providerId: string; modelId: string };

export const useSendWhenSpaceReady = <P extends PendingSpaceSend>(
  pending: P | null,
  composer: Composer,
  shown: SpaceSendModel | null,
  settle: (pending: P, send: boolean) => void,
): (() => { draftKey: string | null; model: SpaceSendModel | null }) => {
  const spaceState = useSpacesStore((state) => (pending ? state.journey?.get(pending.spaceId)?.state : undefined));
  const actionKind = useSpacesStore((state) => (pending ? state.actions.get(pending.spaceId)?.kind : undefined));
  const { draftKey, providerId, modelId } = composer;
  React.useEffect(() => {
    if (!pending) return;
    const step = pendingSpaceSendStep(pending, { draftKey, providerId, modelId });
    if (step !== 'wait') settle(pending, step === 'send');
  }, [actionKind, draftKey, modelId, pending, providerId, settle, spaceState]);
  const shownRef = React.useRef({ draftKey, model: shown });
  React.useLayoutEffect(() => { shownRef.current = { draftKey, model: shown }; });
  return React.useCallback(() => shownRef.current, []);
};
