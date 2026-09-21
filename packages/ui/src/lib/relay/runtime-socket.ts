// Opens a runtime WebSocket the right way for the active runtime: through the
// relay tunnel when relay mode is active, or a native browser WebSocket
// otherwise (wrapped to the same shape). Every runtime WS consumer — the event
// pipeline, dictation, terminal — must go through here so relay mode carries
// ALL socket traffic, not just the main event stream. A raw `new WebSocket(url)`
// against a relay-mode runtime fails: the resolver yields a tunnel-virtual URL
// (or a capacitor:// origin) that the platform WebSocket rejects with
// "The string did not match the expected pattern".

import { getActiveRelayTunnel } from './runtime-tunnel';
import { wsUrlToTunnelPath } from './tunnel-payloads';
import { wrapBrowserWebSocket, type RelayTunnelWebSocket } from './tunnel-client';

export const openRuntimeWebSocket = (url: string, protocols?: string[]): RelayTunnelWebSocket => {
  const relay = getActiveRelayTunnel();
  if (relay) {
    return relay.openWebSocket(wsUrlToTunnelPath(url), protocols);
  }
  return wrapBrowserWebSocket(protocols ? new WebSocket(url, protocols) : new WebSocket(url));
};
