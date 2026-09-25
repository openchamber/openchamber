import React from 'react';

import { useGuestStatusSections } from '@/hooks/useGuestSurfaces';
import type { InstalledGuest } from '@/lib/guests/types';
import { extensionSectionId, type ExtensionSectionId } from './sections';

export type WorkStatusExtensionSections = {
  /** Section ids of available extensions, in catalog order. */
  ids: ExtensionSectionId[];
  byId: ReadonlyMap<ExtensionSectionId, InstalledGuest>;
};

/**
 * Extension sections the panel and the sections dialog may place. Empty on
 * VS Code and mobile, where no guest is loaded (`useGuestStatusSections`).
 */
export const useWorkStatusExtensionSections = (): WorkStatusExtensionSections => {
  const guests = useGuestStatusSections();
  return React.useMemo(() => {
    const byId = new Map<ExtensionSectionId, InstalledGuest>();
    for (const guest of guests) byId.set(extensionSectionId(guest.id), guest);
    return { ids: [...byId.keys()], byId };
  }, [guests]);
};
