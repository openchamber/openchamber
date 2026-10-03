/**
 * The shared-surface viewer open in this window, per extension. A page of the
 * same extension (its docked toolbar, its pages) sends the id with every
 * `serviceRequest`, and the host tells the service which viewer the call came
 * from and whether that viewer holds control. The host checks the id against
 * its live viewers, so a stale one only means the call goes out without it.
 */
const viewerIdByGuest = new Map<string, string>();

export const setSurfaceViewerId = (guestId: string, viewerId: string): void => {
  viewerIdByGuest.set(guestId, viewerId);
};

export const clearSurfaceViewerId = (guestId: string, viewerId: string): void => {
  if (viewerIdByGuest.get(guestId) === viewerId) viewerIdByGuest.delete(guestId);
};

export const getSurfaceViewerId = (guestId: string): string | undefined => viewerIdByGuest.get(guestId);
