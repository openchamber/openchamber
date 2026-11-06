import type { GuestUpdate } from './types.ts';

/** How long after the app opens the check runs; startup has enough to do first. */
export const GUEST_UPDATE_NOTICE_DELAY_MS = 20_000;
/** An app left open for days still hears about updates. */
export const GUEST_UPDATE_NOTICE_INTERVAL_MS = 4 * 60 * 60 * 1000;

/** One string per set of offered versions, so the same versions are announced once. */
export const guestUpdateFingerprint = (updates: Record<string, GuestUpdate>): string => (
  Object.entries(updates).map(([id, update]) => `${id}@${update.version}`).sort().join(',')
);
