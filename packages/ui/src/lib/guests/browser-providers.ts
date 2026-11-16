import { serviceProvides } from '@openchamber/sdk';

import { isGuestActive } from './capabilities.ts';
import type { InstalledGuest } from './types.ts';

export const BUILTIN_BROWSER_PROVIDER = 'builtin';

export const browserProviderGuests = (guests: readonly InstalledGuest[]): InstalledGuest[] => (
  guests.filter((guest) => isGuestActive(guest) && serviceProvides(guest.service, 'browser'))
);
