const viewerIdByGuest = new Map<string, string>();

export const setSurfaceViewerId = (guestId: string, viewerId: string): void => {
  viewerIdByGuest.set(guestId, viewerId);
};

export const clearSurfaceViewerId = (guestId: string, viewerId: string): void => {
  if (viewerIdByGuest.get(guestId) === viewerId) viewerIdByGuest.delete(guestId);
};

export const getSurfaceViewerId = (guestId: string): string | undefined => viewerIdByGuest.get(guestId);
