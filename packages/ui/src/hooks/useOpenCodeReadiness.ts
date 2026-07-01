import { useConfigStore } from '@/stores/useConfigStore';

export function useOpenCodeReadiness() {
  const isInitialized = useConfigStore((s) => s.isInitialized);
  const connectionPhase = useConfigStore((s) => s.connectionPhase);
  const lastDisconnectReason = useConfigStore((s) => s.lastDisconnectReason);
  // Stale-while-revalidate: when provider data was hydrated from the persisted
  // cache, treat the pickers as ready immediately so they paint last-known
  // models/agents while initializeApp() refreshes in the background. Without
  // this, the cache is invisible — the pickers stay on "Loading…" until the
  // full init round-trip completes even though the data is already in the store.
  const hasCachedProviders = useConfigStore((s) => s.providers.length > 0);
  const isReady = isInitialized || hasCachedProviders;
  // Only surface "unavailable" when we have nothing to show AND init failed.
  const isUnavailable = !isReady && lastDisconnectReason === 'init_error';

  return {
    isReady,
    isLoading: !isReady && !isUnavailable,
    isUnavailable,
    connectionPhase,
  };
}
