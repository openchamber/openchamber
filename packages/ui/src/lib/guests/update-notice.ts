import type { GuestUpdate } from './types.ts';

export const GUEST_UPDATE_NOTICE_DELAY_MS = 20_000;
export const GUEST_UPDATE_NOTICE_INTERVAL_MS = 4 * 60 * 60 * 1000;

export const guestUpdateFingerprint = (updates: Record<string, GuestUpdate>): string => (
  Object.entries(updates).map(([id, update]) => `${id}@${update.version}`).sort().join(',')
);
