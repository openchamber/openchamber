import { getMiniChatRuntimeArgs } from '@/lib/desktop';
import { isRelayModeActive } from '@/lib/relay/runtime-tunnel';
import { getRuntimeExtraHeadersSync } from '@/lib/runtime-auth';
import { getRuntimeApiBaseUrl, getRuntimeKey } from '@/lib/runtime-switch';

export const contextWindowRuntimeKey = (): string => {
  if (isRelayModeActive()) return getRuntimeKey();
  const address = getRuntimeApiBaseUrl() || globalThis.window?.location.origin;
  if (!address) return getRuntimeKey();
  const url = new URL(address);
  return `${url.protocol}//${url.host}${url.pathname.replace(/\/+$/, '')}`;
};

export const contextWindowMatchesRuntime = (key: string): boolean => (
  key === contextWindowRuntimeKey() || (key.startsWith('host:') && key === getRuntimeKey())
);

export const contextWindowRuntimeArgs = () => {
  const args = getMiniChatRuntimeArgs();
  return isRelayModeActive() ? args : { ...args, runtimeKey: '', requestHeaders: getRuntimeExtraHeadersSync() };
};
