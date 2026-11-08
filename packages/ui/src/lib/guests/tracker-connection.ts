import { EMPTY_GUEST_CONNECTION, type GuestConnection } from '@openchamber/sdk';

import type { TrackerAuthStatus } from '@/lib/api/types';

/** A tracker's auth status as a frame's `connection`. Not connected until the status has answered. */
export const trackerGuestConnection = (status: TrackerAuthStatus | null): GuestConnection => {
  if (!status?.connected) return EMPTY_GUEST_CONNECTION;
  const account = status.account;
  return { connected: true, account: account?.name ?? account?.user?.name ?? account?.id ?? '' };
};
