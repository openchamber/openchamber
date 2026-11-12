import React from 'react';
import { ProviderLogo } from '@/components/ui/ProviderLogo';

const MAX_LOGOS = 4;

/** Overlapping provider logos of a multi-run's lanes, for mobile run rows. */
export const MobileRunProviderLogos: React.FC<{ providerIDs: readonly string[] }> = ({ providerIDs }) => (
  <span className="inline-flex shrink-0 items-center -space-x-1">
    {providerIDs.slice(0, MAX_LOGOS).map((providerID) => (
      <span key={providerID} className="inline-flex size-4 items-center justify-center rounded-full bg-background ring-1 ring-background">
        <ProviderLogo providerId={providerID} className="size-3 opacity-80" />
      </span>
    ))}
  </span>
);
