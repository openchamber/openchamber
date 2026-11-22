
import React from 'react';

import { loadGuestCatalog, reloadGuestCatalog } from '@/lib/guests/load-catalog';
import { subscribeOpenchamberEvents } from '@/lib/openchamberEvents';

export const useGuestCatalogSync = (): void => {
  React.useEffect(() => subscribeOpenchamberEvents((event) => {
    if (event.type === 'guests-changed') void reloadGuestCatalog();
    else if (event.type === 'event-stream-ready') void loadGuestCatalog();
  }), []);
};
