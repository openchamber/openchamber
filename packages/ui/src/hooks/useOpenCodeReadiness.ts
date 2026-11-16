import { selectCatalogLoadedForDirectory, useConfigStore } from '@/stores/useConfigStore';

export function useOpenCodeReadiness(resource: 'models' | 'agents' = 'models', directory?: string) {
  const connectionPhase = useConfigStore((s) => s.connectionPhase);
  const lastDisconnectReason = useConfigStore((s) => s.lastDisconnectReason);
  const isReady = useConfigStore((s) => directory !== undefined
    ? selectCatalogLoadedForDirectory(s, resource, directory)
    : resource === 'models'
      ? s.providersLoaded || s.providers.length > 0
      : s.agentsLoaded || s.agents.length > 0);
  const isUnavailable = !isReady && lastDisconnectReason === 'init_error';

  return {
    isReady,
    isLoading: !isReady && !isUnavailable,
    isUnavailable,
    connectionPhase,
  };
}
