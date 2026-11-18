import { hasGuestCapability, isGuestApproved, type GuestCapability } from '@openchamber/sdk';

import type { InstalledGuest } from './types.ts';

export const isGuestActive = (guest: InstalledGuest): boolean => (
  guest.enabled !== false && isGuestApproved(guest.capabilities)
);

export const guestNeedsApproval = (guest: InstalledGuest): boolean => !isGuestApproved(guest.capabilities);

export const guestMay = (guest: InstalledGuest | null, capability: GuestCapability): boolean => (
  guest !== null && isGuestActive(guest) && hasGuestCapability(guest.capabilities, capability)
);
