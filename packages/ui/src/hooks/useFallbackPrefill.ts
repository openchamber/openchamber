import React from 'react';
import { parseModelIdentifier } from '@/lib/modelIdentifier';
import { isAutoModel } from '@/lib/routing/autoModel';
import type { RoutingConfig } from '@/lib/routing/routingApi';

export const useFallbackPrefill = (
  loaded: boolean,
  serverConfig: RoutingConfig | null,
  settingsDefaultModel: string | undefined,
  settingsDefaultVariant: string | null | undefined,
  update: (mutate: (config: RoutingConfig) => RoutingConfig) => void,
): ((providerID: string, modelID: string) => void) => {
  const prefilledRef = React.useRef(false);
  React.useEffect(() => {
    if (prefilledRef.current || !loaded || !serverConfig) return;
    if (serverConfig.fallback) {
      prefilledRef.current = true;
      return;
    }
    const parsed = parseModelIdentifier(settingsDefaultModel);
    if (!parsed || isAutoModel(parsed.providerId, parsed.modelId)) return;
    prefilledRef.current = true;
    update((config) => (config.fallback ? config : {
      ...config,
      fallback: { model: { providerID: parsed.providerId, modelID: parsed.modelId }, variant: settingsDefaultVariant ?? null },
    }));
  }, [loaded, serverConfig, settingsDefaultModel, settingsDefaultVariant]);
  return React.useCallback((providerID: string, modelID: string) => {
    prefilledRef.current = true;
    update((config) => ({ ...config, fallback: providerID && modelID ? { model: { providerID, modelID }, variant: null } : null }));
  }, [update]);
};
