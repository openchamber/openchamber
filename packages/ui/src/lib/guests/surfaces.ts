import { GUEST_SURFACE_DOCK_DEFAULT, GUEST_SURFACE_DOCK_SIZE_DEFAULT, hasGuestPage, type GuestSurfaceDock } from '@openchamber/sdk';

import type { ContextSurfaceDescriptor } from '@/lib/surfaces/registry';
import { pluginModeFromId } from '@/lib/surfaces/modes';

import { isGuestActive } from './capabilities.ts';

import { guestPackageIconSrc, resolveGuestIconName } from './icon.ts';
import type { InstalledGuest } from './types.ts';

export const guestHasSharedSurface = (guest: Pick<InstalledGuest, 'service'>): boolean => guest.service?.surface === true;

export type GuestSurfaceDocking = { dock: GuestSurfaceDock; size: number };

export const guestSurfaceDocking = (guest: Pick<InstalledGuest, 'service' | 'entry' | 'entryDock' | 'entrySize'>): GuestSurfaceDocking | null => {
  if (!guestHasSharedSurface(guest) || !guest.entry) return null;
  return { dock: guest.entryDock ?? GUEST_SURFACE_DOCK_DEFAULT, size: guest.entrySize ?? GUEST_SURFACE_DOCK_SIZE_DEFAULT };
};

export const enabledGuestSurfaces = (
  guests: readonly InstalledGuest[],
  authenticatedAsset: (path: string) => string,
): ContextSurfaceDescriptor[] => guests
  .filter((guest) => isGuestActive(guest) && (hasGuestPage({ panel: guest }) || guestHasSharedSurface(guest)))
  .map((guest) => guestSurfaceFromInstalled(guest, authenticatedAsset));

const guestSurfaceFromInstalled = (
  guest: InstalledGuest,
  authenticatedAsset: (path: string) => string,
): ContextSurfaceDescriptor => ({
  id: pluginModeFromId(guest.id),
  mode: pluginModeFromId(guest.id),
  icon: resolveGuestIconName(guest.icon),
  iconSrc: guestPackageIconSrc(guest.id, guest.icon, authenticatedAsset),
  label: guest.name,
  labelKey: 'contextRail.surface.plugin',
  descriptionKey: 'contextRail.surface.plugin.description',
  availability: 'always',
});
