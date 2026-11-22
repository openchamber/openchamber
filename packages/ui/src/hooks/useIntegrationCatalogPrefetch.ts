/**
 * Reads OpenCode's integration list and the disabled-provider list once the
 * app has started and the browser is idle, so Settings → Providers opens on
 * the integration list instead of waiting for the read and the first picker
 * catalog is already filtered by the disabled list. Mounted by the
 * desktop/web/VS Code app only: the phone layout reads the list when
 * Settings opens, and so does any window talking to its server through the
 * relay, where every byte is paid.
 */
import React from 'react';

import { preloadProviderLogos } from '@/hooks/useProviderLogo';
import { prefetchIntegrationCatalog } from '@/lib/opencode/integration-catalog';
import { prefetchDisabledProviders } from '@/lib/disabledProviders';
import { isRelayModeActive } from '@/lib/relay/runtime-tunnel';
import { POPULAR_PROVIDERS } from '@/components/sections/providers/connectableProviders';

const prefetch = () => {
  if (isRelayModeActive()) return;
  prefetchIntegrationCatalog();
  prefetchDisabledProviders();
  preloadProviderLogos(POPULAR_PROVIDERS.map((provider) => provider.id));
};

/** `ready` is true once the app is initialized and connected to OpenCode; `epoch` changes with the runtime. */
export const useIntegrationCatalogPrefetch = (ready: boolean, epoch: number): void => {
  React.useEffect(() => {
    if (!ready) return;
    // Safari has no requestIdleCallback.
    if ('requestIdleCallback' in window) {
      const handle = window.requestIdleCallback(prefetch, { timeout: 10_000 });
      return () => window.cancelIdleCallback(handle);
    }
    const timeout = setTimeout(prefetch, 3000);
    return () => clearTimeout(timeout);
  }, [ready, epoch]);
};
