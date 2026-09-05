import React from 'react';

import { Icon } from '@/components/icon/Icon';
import type { IconName } from '@/components/icon/icons';
import { cn } from '@/lib/utils';

type GuestRailIconProps = {
  src: string;
  className?: string;
};

export const cssMaskUrl = (src: string): string => {
  const escaped = src.replace(/\\/g, '\\\\').replace(/"/g, '\\"');
  return `url("${escaped}")`;
};

/**
 * Package brand SVGs usually fill the 24×24 viewBox; Remixicon glyphs keep ~2px
 * inset. Scale the mask so a guest mark matches host rail icons at the same box.
 */
export const GUEST_RAIL_ICON_MASK_SIZE = '84%';

/** Guest SVG as a currentColor silhouette. `<img>` cannot inherit the rail token. */
export const GuestRailIcon: React.FC<GuestRailIconProps> = ({ src, className }) => {
  const mask = cssMaskUrl(src);
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
