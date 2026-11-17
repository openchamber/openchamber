import { hasGuestPage } from '@openchamber/sdk';

import { isMobileSurfaceRuntime } from '@/lib/runtimeSurface';
import { pluginModeFromId, type PluginContextPanelMode } from '@/lib/surfaces/modes';

import { isGuestActive } from './capabilities.ts';
import { guestHasSharedSurface } from './surfaces.ts';
import type { InstalledGuest } from './types.ts';

type GuestPhoneFrame = 'panel' | 'page';

export const mayGuestShowOnPhone = (guest: InstalledGuest, frame: GuestPhoneFrame): boolean => (
  frame === 'panel'
    ? Boolean(guest.entry) && guest.entryMobile === true
    : Boolean(guest.pageEntry) && guest.pageMobile === true
);

export const guestPanelOpensHere = (guest: InstalledGuest): boolean => (
  !isMobileSurfaceRuntime() || mayGuestShowOnPhone(guest, 'panel')
);

export const phoneGuestPanelModes = (guests: readonly InstalledGuest[]): PluginContextPanelMode[] => {
  if (!isMobileSurfaceRuntime()) return [];
  return guests
    .filter((guest) => isGuestActive(guest) && mayGuestShowOnPhone(guest, 'panel')
      && (hasGuestPage({ panel: guest }) || guestHasSharedSurface(guest)))
    .map((guest) => pluginModeFromId(guest.id));
};
