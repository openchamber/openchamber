import React from 'react';

import { Icon } from '@/components/icon/Icon';
import type { IconName } from '@/components/icon/icons';
import { cn } from '@/lib/utils';
import { useGuestIconSource } from '@/lib/guests/useGuestIconSource';
import { FALLBACK_GUEST_ICON } from '@/lib/guests/icon';

import { cssMaskUrl, GUEST_RAIL_ICON_MASK_SIZE } from './guestRailIconMask';

type GuestRailIconProps = {
  src: string;
  className?: string;
};



/** Guest SVG as a currentColor silhouette. `<img>` cannot inherit the rail token. */
export const GuestRailIcon: React.FC<GuestRailIconProps> = ({ src, className }) => {
  const resolvedSrc = useGuestIconSource(src);
  if (!resolvedSrc) return <Icon name={FALLBACK_GUEST_ICON} className={className} />;
  const mask = cssMaskUrl(resolvedSrc);
  return (
    <span
      aria-hidden="true"
      className={cn('inline-block bg-current', className)}
      style={{
        maskImage: mask,
        WebkitMaskImage: mask,
        maskSize: GUEST_RAIL_ICON_MASK_SIZE,
        maskRepeat: 'no-repeat',
        maskPosition: 'center',
      }}
    />
  );
};

type GuestIconProps = {
  icon: IconName;
  iconSrc?: string;
  className?: string;
};

/** Package SVG when `iconSrc` is set, otherwise a host Remixicon sprite name. */
export const GuestIcon: React.FC<GuestIconProps> = ({ icon, iconSrc, className }) => (
  iconSrc
    ? <GuestRailIcon src={iconSrc} className={className} />
    : <Icon name={icon} className={className} />
);
