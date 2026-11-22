import { EMPTY_GUEST_CONNECTION, type GuestConnection } from '@openchamber/sdk';

import type { TrackerAuthStatus } from '@/lib/api/types';

export const trackerGuestConnection = (status: TrackerAuthStatus | null): GuestConnection => {
  if (!status?.connected) return EMPTY_GUEST_CONNECTION;
  const account = status.account;
  return { connected: true, account: account?.name ?? account?.user?.name ?? account?.id ?? '' };
};
