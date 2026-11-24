import { isCapacitorApp } from '@/lib/platform';
import { isRelayModeActive } from '@/lib/relay/runtime-tunnel';
import { getRuntimeApiBaseUrl, isSshForwardedRuntime } from '@/lib/runtime-switch';
import { isLoopbackHttpUrl } from '@/lib/url';

const isServerOnThisMachine = (): boolean => {
  if (isRelayModeActive() || isSshForwardedRuntime()) return false;
  const pageOrigin = typeof window === 'undefined' || isCapacitorApp() ? '' : window.location?.origin ?? '';
  return isLoopbackHttpUrl(getRuntimeApiBaseUrl() || pageOrigin);
};

export const isServerOffline = (): boolean => (
  typeof navigator === 'object' && navigator !== null && navigator.onLine === false && !isServerOnThisMachine()
);
