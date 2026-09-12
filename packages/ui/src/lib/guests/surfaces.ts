import type { ContextSurfaceDescriptor } from '@/lib/surfaces/registry';
import { pluginModeFromId } from '@/lib/surfaces/modes';

import { isGuestActive } from './capabilities.ts';

import { guestPackageIconSrc, resolveGuestIconName } from './icon.ts';
import type { InstalledGuest } from './types.ts';

/** Rail surfaces for the enabled guests, in catalog order. The rail and the digit shortcuts must agree on this list. */
export const enabledGuestSurfaces = (
  guests: readonly InstalledGuest[],
  authenticatedAsset: (path: string) => string,
): ContextSurfaceDescriptor[] => guests
  .filter(isGuestActive)
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
