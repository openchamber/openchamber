import React from 'react';

import { GuestIcon } from '@/components/layout/GuestRailIcon';
import { ProviderLogo } from '@/components/ui/ProviderLogo';
import { guestPackageIconSrc, resolveGuestIconName } from '@/lib/guests/icon';
import { isExtensionQuotaProviderId } from '@/lib/quota/extensionProviders';
import { getRuntimeUrlResolver } from '@/lib/runtime-url';
import { useQuotaStore } from '@/stores/useQuotaStore';

/**
 * The mark of a usage provider: a built-in's logo, or for a provider an
 * extension serves the extension's own icon, as its rail icon and its card
 * in Settings → Extensions draw it (a Remixicon from the sprite, or the
 * package's SVG masked in the text colour).
 */
export const QuotaProviderLogo: React.FC<{ providerId: string; className?: string }> = ({ providerId, className }) => {
  const extension = useQuotaStore((state) => (
    isExtensionQuotaProviderId(providerId) ? state.extensionProviders.find((entry) => entry.id === providerId) ?? null : null
  ));
  const iconSrc = React.useMemo(
    () => (extension ? guestPackageIconSrc(extension.guestId, extension.icon, getRuntimeUrlResolver().authenticatedAsset) : undefined),
    [extension],
  );
  if (!extension) return <ProviderLogo providerId={providerId} className={className} />;
  return <GuestIcon icon={resolveGuestIconName(extension.icon)} iconSrc={iconSrc} className={className} />;
};
