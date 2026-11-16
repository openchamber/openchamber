import { hasGuestPage } from '@openchamber/sdk';

import { isMobileSurfaceRuntime } from '@/lib/runtimeSurface';
import { pluginModeFromId, type PluginContextPanelMode } from '@/lib/surfaces/modes';

import { isGuestActive } from './capabilities.ts';
import { guestHasSharedSurface } from './surfaces.ts';
import type { InstalledGuest } from './types.ts';

/**
 * Which of a guest's big frames the phone may show. The panel page, the live
 * screen it docks to, and the attach panel or dialog need `panel.mobile`; the
 * full-screen page needs its own opt-in, which the server already resolved
 * (`page: true` follows the panel). Host-drawn data, Work Status sections,
 * UI blocks and file editors need no opt-in and are not asked here.
 */
type GuestPhoneFrame = 'panel' | 'page';

export const mayGuestShowOnPhone = (guest: InstalledGuest, frame: GuestPhoneFrame): boolean => (
  frame === 'panel'
    ? Boolean(guest.entry) && guest.entryMobile === true
    : Boolean(guest.pageEntry) && guest.pageMobile === true
);

/**
 * Whether this device may open the guest's panel or attach frame: always off
 * the phone (the caller already checked the guest is active), on the phone
 * only with the opt-in.
 */
export const guestPanelOpensHere = (guest: InstalledGuest): boolean => (
  !isMobileSurfaceRuntime() || mayGuestShowOnPhone(guest, 'panel')
);

/**
 * The extension tabs of the phone's workspace drawer: active guests that
 * opted their panel in and have something to show in it (a page, or a live
 * screen with the page docked to it), in catalog order. Empty off the phone.
 */
export const phoneGuestPanelModes = (guests: readonly InstalledGuest[]): PluginContextPanelMode[] => {
  if (!isMobileSurfaceRuntime()) return [];
  return guests
    .filter((guest) => isGuestActive(guest) && mayGuestShowOnPhone(guest, 'panel')
      && (hasGuestPage({ panel: guest }) || guestHasSharedSurface(guest)))
    .map((guest) => pluginModeFromId(guest.id));
};
