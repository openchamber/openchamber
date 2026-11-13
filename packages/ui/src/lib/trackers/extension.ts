import type { InstalledGuest } from '@/lib/guests/types';
import type { TrackerDescriptor } from './types';

/** The host names an extension's tracker `ext-<panel.id>`, like its Git host and its notification channel. */
const EXTENSION_TRACKER_PREFIX = 'ext-';

export const isExtensionTrackerId = (id: string): boolean => id.startsWith(EXTENSION_TRACKER_PREFIX);

/** The installed extension whose tracker a served descriptor is, or null for a built-in or an extension that is gone. */
export const extensionTrackerGuest = (descriptor: TrackerDescriptor, guests: readonly InstalledGuest[]): InstalledGuest | null => {
  if (!isExtensionTrackerId(descriptor.id)) return null;
  const guestId = descriptor.id.slice(EXTENSION_TRACKER_PREFIX.length);
  return guests.find((guest) => guest.id === guestId && guest.tracker) ?? null;
};
