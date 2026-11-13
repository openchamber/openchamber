/**
 * Keeps the extension catalog current while the app runs.
 *
 * The rail reads the catalog on mount and on a runtime switch, but another
 * window, another device, or an author rebuilding a folder install can change
 * it at any time. The server announces each change on the control stream; this
 * hook reads the catalog again then, and when the stream reconnects, since a
 * change made during the gap was not announced to this client. Frames reload
 * on their own when a package's revision moves.
 */

import React from 'react';

import { loadGuestCatalog, reloadGuestCatalog } from '@/lib/guests/load-catalog';
import { subscribeOpenchamberEvents } from '@/lib/openchamberEvents';

export const useGuestCatalogSync = (): void => {
  React.useEffect(() => subscribeOpenchamberEvents((event) => {
    if (event.type === 'guests-changed') void reloadGuestCatalog();
    else if (event.type === 'event-stream-ready') void loadGuestCatalog();
  }), []);
};
