import React from 'react';

import { isVSCodeRuntime } from '@/lib/desktop';
import { isGuestActive } from '@/lib/guests/capabilities';
import { useGuestsStore } from '@/lib/guests/store';

import { NO_EXTENSION_BLOCKS, collectExtensionBlocks, type ExtensionBlocks } from './catalog';

export const useExtensionBlocks = (): ExtensionBlocks => {
  const guests = useGuestsStore((state) => state.guests);
  return React.useMemo(() => {
    if (isVSCodeRuntime()) return NO_EXTENSION_BLOCKS;
    return collectExtensionBlocks(guests.flatMap((guest) => (isGuestActive(guest)
      ? (guest.blocks ?? []).map((block) => ({ ...block, guestId: guest.id }))
      : [])));
  }, [guests]);
};
