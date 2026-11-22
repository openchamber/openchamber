import type { InstalledGuest } from '@/lib/guests/types';
import type { TrackerDescriptor } from './types';

const EXTENSION_TRACKER_PREFIX = 'ext-';

export const isExtensionTrackerId = (id: string): boolean => id.startsWith(EXTENSION_TRACKER_PREFIX);

export const extensionTrackerGuest = (descriptor: TrackerDescriptor, guests: readonly InstalledGuest[]): InstalledGuest | null => {
  if (!isExtensionTrackerId(descriptor.id)) return null;
  const guestId = descriptor.id.slice(EXTENSION_TRACKER_PREFIX.length);
  return guests.find((guest) => guest.id === guestId && guest.tracker) ?? null;
};
