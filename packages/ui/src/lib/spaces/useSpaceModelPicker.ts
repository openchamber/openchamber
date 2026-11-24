import React from 'react';

import { useI18n } from '@/lib/i18n';
import { spaceOfferAllows, useSpaceModelOffer, type SpaceTarget } from './space-model-offer';
import { useSpacesStore } from './spaces-store';

export type SpaceModelPicker = {
  allows: (providerId: string) => boolean;
  noResults: string | null;
  giveAccess: { label: string; onSelect: () => void } | null;
};

export const useSpaceModelPicker = (
  target: SpaceTarget | null,
  providers: readonly { id: string; name?: string }[],
  setOpen: (open: boolean) => void,
): SpaceModelPicker | null => {
  const { t } = useI18n();
  const offer = useSpaceModelOffer(target);
  const setOpenRef = React.useRef(setOpen);
  React.useLayoutEffect(() => { setOpenRef.current = setOpen; });
  const stopWaiting = React.useRef<(() => void) | null>(null);
  React.useEffect(() => () => stopWaiting.current?.(), []);

  const spaceId = offer?.spaceId ?? null;
  const again = offer?.needsAgain.length === 1 ? offer.needsAgain[0] : null;
  const giveAccess = React.useCallback(() => {
    if (!spaceId) return;
    stopWaiting.current?.();
    setOpenRef.current(false);
    useSpacesStore.getState().openAccessDialog(spaceId, again);
    stopWaiting.current = useSpacesStore.subscribe((state) => {
      if (state.accessDialog) return;
      stopWaiting.current?.();
      stopWaiting.current = null;
      if (state.journey) setOpenRef.current(true);
    });
  }, [again, spaceId]);

  return React.useMemo(() => {
    if (!offer) return null;
    const label = offer.give === 'after_start'
      ? t('spaces.modelPicker.startFirst')
      : again
        ? t('spaces.modelPicker.giveAgain', { provider: providers.find((provider) => provider.id === again)?.name ?? again })
        : t('spaces.group.access.give');
    return {
      allows: (providerId) => spaceOfferAllows(offer, providerId),
      noResults: offer.held?.length === 0 ? t('spaces.modelPicker.noAccess') : null,
      giveAccess: offer.give ? { label, onSelect: giveAccess } : null,
    };
  }, [again, giveAccess, offer, providers, t]);
};
