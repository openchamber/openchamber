import { getActiveRelayTunnel } from './runtime-tunnel';
import { wsUrlToTunnelPath } from './tunnel-payloads';
import { wrapBrowserWebSocket, type RelayTunnelWebSocket } from './tunnel-client';
import { isCapacitorApp } from '@/lib/platform';
import { getRuntimeExtraHeadersSync } from '@/lib/runtime-auth';
import { getRuntimeUrlResolver } from '@/lib/runtime-url';
import { nativeWebSocketHeaders, openNativeWebSocket } from './native-websocket';

export const openRuntimeWebSocket = (url: string, protocols?: string[]): RelayTunnelWebSocket => {
  const relay = getActiveRelayTunnel();
  if (relay) {
    return relay.openWebSocket(wsUrlToTunnelPath(url), protocols);
  }
  const headers = getRuntimeExtraHeadersSync();
  if (Object.keys(headers).length > 0 && isCapacitorApp()) {
    const scopedHeaders = nativeWebSocketHeaders(url, getRuntimeUrlResolver().api('/'), headers);
    if (scopedHeaders) {
      return openNativeWebSocket(url, scopedHeaders, protocols);
    }
  }
  return wrapBrowserWebSocket(protocols ? new WebSocket(url, protocols) : new WebSocket(url));
};
