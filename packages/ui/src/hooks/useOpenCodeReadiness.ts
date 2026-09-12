import { useConfigStore } from '@/stores/useConfigStore';

export function useOpenCodeReadiness(resource: 'models' | 'agents' = 'models') {
  const connectionPhase = useConfigStore((s) => s.connectionPhase);
  const lastDisconnectReason = useConfigStore((s) => s.lastDisconnectReason);
  // Each catalog owns its readiness. Providers arriving cannot finish the
  // agent picker, and a successful empty catalog is different from loading.
  const isReady = useConfigStore((s) => resource === 'models'
    ? s.providersLoaded || s.providers.length > 0
    : s.agentsLoaded || s.agents.length > 0);
  // Only surface "unavailable" when we have nothing to show AND init failed.
  const isUnavailable = !isReady && lastDisconnectReason === 'init_error';

  return {
    isReady,
    isLoading: !isReady && !isUnavailable,
    isUnavailable,
    connectionPhase,
  };
}
