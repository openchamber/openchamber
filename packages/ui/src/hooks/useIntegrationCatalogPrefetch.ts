import React from 'react';

import { preloadProviderLogos } from '@/hooks/useProviderLogo';
import { prefetchIntegrationCatalog } from '@/lib/opencode/integration-catalog';
import { isRelayModeActive } from '@/lib/relay/runtime-tunnel';
import { POPULAR_PROVIDERS } from '@/components/sections/providers/connectableProviders';

const prefetch = () => {
  if (isRelayModeActive()) return;
  prefetchIntegrationCatalog();
  preloadProviderLogos(POPULAR_PROVIDERS.map((provider) => provider.id));
};

export const useIntegrationCatalogPrefetch = (ready: boolean, epoch: number): void => {
  React.useEffect(() => {
    if (!ready) return;
    if ('requestIdleCallback' in window) {
      const handle = window.requestIdleCallback(prefetch, { timeout: 10_000 });
      return () => window.cancelIdleCallback(handle);
    }
    const timeout = setTimeout(prefetch, 3000);
    return () => clearTimeout(timeout);
  }, [ready, epoch]);
};
