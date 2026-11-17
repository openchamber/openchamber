import React from 'react';

import { useGuestStatusSections } from '@/hooks/useGuestSurfaces';
import type { InstalledGuest } from '@/lib/guests/types';
import { extensionSectionId, type ExtensionSectionId } from './sections';

export type WorkStatusExtensionSections = {
  ids: ExtensionSectionId[];
  byId: ReadonlyMap<ExtensionSectionId, InstalledGuest>;
};

export const useWorkStatusExtensionSections = (): WorkStatusExtensionSections => {
  const guests = useGuestStatusSections();
  return React.useMemo(() => {
    const byId = new Map<ExtensionSectionId, InstalledGuest>();
    for (const guest of guests) byId.set(extensionSectionId(guest.id), guest);
    return { ids: [...byId.keys()], byId };
  }, [guests]);
};
