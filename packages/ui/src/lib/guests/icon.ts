import { isGuestPackageSvgIcon } from '@openchamber/sdk';

import { iconSpriteData } from '@/components/icon/sprite';
import type { IconName } from '@/components/icon/icons';

export const FALLBACK_GUEST_ICON = 'window' satisfies IconName;

/** Product marks in `scripts/generate-icon-sprite.mjs`. Guests name Remixicon or a package SVG. */
const HOST_PRODUCT_ICONS = new Set([
  'claude-code',
  'cloudflare',
  'command-code',
  'cursor',
  'linear',
  'openchamber',
]);

const isGuestIconName = (name: string): name is IconName => (
  Object.hasOwn(iconSpriteData, name) && !HOST_PRODUCT_ICONS.has(name)
);

export const resolveGuestIconName = (name: string): IconName => (
  isGuestPackageSvgIcon(name) || !isGuestIconName(name) ? FALLBACK_GUEST_ICON : name
);

export { isGuestPackageSvgIcon };

export const guestPackageIconSrc = (
  guestId: string,
  icon: string,
  authenticatedAsset: (path: string) => string,
): string | undefined => (
  isGuestPackageSvgIcon(icon)
    ? authenticatedAsset(`/api/guests/${guestId}/${icon}`)
    : undefined
);
