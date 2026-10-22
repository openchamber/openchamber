import React from 'react';
import { Icon } from '@/components/icon/Icon';
import type { SourceControlProviderDescriptor } from '@/lib/source-control/providers/descriptor';
import { cn } from '@/lib/utils';
import { PROVIDER_FALLBACK_ICON, providerSpriteName, type ProviderIconVariant } from './providerIconSprite';

interface ProviderIconProps {
  descriptor: SourceControlProviderDescriptor;
  variant?: ProviderIconVariant;
  className?: string;
}

/**
 * A source-control provider's mark: the sprite icon its descriptor names,
 * else the 24x24 path it serves, else the branch icon. Server data never
 * reaches the DOM as markup: a path is drawn as a `d` attribute.
 */
export const ProviderIcon = React.memo(({ descriptor, variant = 'line', className }: ProviderIconProps) => {
  const sprite = providerSpriteName(descriptor, variant);
  if (sprite) return <Icon name={sprite} className={className} />;
  if (!descriptor.icon.path) return <Icon name={PROVIDER_FALLBACK_ICON} className={className} />;
  return (
    <svg className={cn('remixicon', className)} viewBox="0 0 24 24" xmlns="http://www.w3.org/2000/svg" aria-hidden="true">
      <path d={descriptor.icon.path} fill="currentColor" />
    </svg>
  );
});

ProviderIcon.displayName = 'ProviderIcon';
