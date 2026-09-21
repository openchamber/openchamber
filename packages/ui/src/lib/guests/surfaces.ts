import { GUEST_SURFACE_DOCK_DEFAULT, GUEST_SURFACE_DOCK_SIZE_DEFAULT, hasGuestPage, type GuestSurfaceDock } from '@openchamber/sdk';

import type { ContextSurfaceDescriptor } from '@/lib/surfaces/registry';
import { pluginModeFromId } from '@/lib/surfaces/modes';

import { isGuestActive } from './capabilities.ts';

import { guestPackageIconSrc, resolveGuestIconName } from './icon.ts';
import type { InstalledGuest } from './types.ts';

/** An extension whose rail panel is a host-drawn shared surface, not an iframe. */
export const guestHasSharedSurface = (guest: Pick<InstalledGuest, 'service'>): boolean => guest.service?.surface === true;

export type GuestSurfaceDocking = { dock: GuestSurfaceDock; size: number };

/**
 * Where the extension's own page sits beside its shared surface (a toolbar
 * above, a tool column beside) and how thick it is, or null when the
 * surface is the whole panel.
 */
export const guestSurfaceDocking = (guest: Pick<InstalledGuest, 'service' | 'entry' | 'entryDock' | 'entrySize'>): GuestSurfaceDocking | null => {
  if (!guestHasSharedSurface(guest) || !guest.entry) return null;
  return { dock: guest.entryDock ?? GUEST_SURFACE_DOCK_DEFAULT, size: guest.entrySize ?? GUEST_SURFACE_DOCK_SIZE_DEFAULT };
};

/**
 * Rail surfaces for the enabled guests with a page or a shared surface, in
 * catalog order. The rail and the digit shortcuts must agree on this list.
 * Background-only and tools-only extensions have no visible panel and get
 * no surface.
 */
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
  defaultWidthFraction: 0.45,
});
