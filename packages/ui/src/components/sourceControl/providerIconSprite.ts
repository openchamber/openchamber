import type { IconName } from '@/components/icon/icons';
import { iconSpriteData } from '@/components/icon/sprite';
import type { SourceControlProviderDescriptor } from '@/lib/source-control/providers/descriptor';

export type ProviderIconVariant = 'line' | 'fill';

export const PROVIDER_FALLBACK_ICON: IconName = 'git-branch';

const isSpriteName = (name: string | undefined): name is IconName => name !== undefined && Object.hasOwn(iconSpriteData, name);

/** The sprite icon the descriptor names for `variant`, or null when the sprite does not carry it. */
export const providerSpriteName = (descriptor: SourceControlProviderDescriptor, variant: ProviderIconVariant): IconName | null => {
  const preferred = variant === 'fill' ? descriptor.icon.filledSprite ?? descriptor.icon.sprite : descriptor.icon.sprite;
  return isSpriteName(preferred) ? preferred : null;
};

/**
 * The provider's mark as an SVG data URI, for surfaces that take an icon URL
 * and mask it in `currentColor` (the context-panel rail). Sprite, else the
 * descriptor's path (validated path data only), else the branch icon.
 */
export const providerIconSrc = (descriptor: SourceControlProviderDescriptor): string => {
  const sprite = providerSpriteName(descriptor, 'line');
  const body = sprite ? iconSpriteData[sprite]
    : descriptor.icon.path ? `<path d="${descriptor.icon.path}" fill="currentColor"/>`
      : iconSpriteData[PROVIDER_FALLBACK_ICON];
  return `data:image/svg+xml,${encodeURIComponent(`<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 24 24">${body}</svg>`)}`;
};
