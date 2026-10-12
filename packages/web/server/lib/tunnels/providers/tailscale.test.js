import { describe, expect, it } from 'bun:test';

import { createTailscaleTunnelProvider, tailscaleTunnelProviderCapabilities } from './tailscale.js';
import {
  TUNNEL_INTENT_EPHEMERAL_PUBLIC,
  TUNNEL_INTENT_PRIVATE_NETWORK,
  TUNNEL_MODE_PRIVATE_NETWORK,
  TUNNEL_MODE_QUICK,
  TUNNEL_PROVIDER_TAILSCALE,
} from '../types.js';

describe('Tailscale tunnel provider', () => {
  it('declares Serve as the private default and Funnel as ephemeral public', () => {
    const provider = createTailscaleTunnelProvider();

    expect(provider.id).toBe(TUNNEL_PROVIDER_TAILSCALE);
    expect(tailscaleTunnelProviderCapabilities.defaults.mode).toBe(TUNNEL_MODE_PRIVATE_NETWORK);
    expect(tailscaleTunnelProviderCapabilities.modes).toEqual([
      expect.objectContaining({ key: TUNNEL_MODE_PRIVATE_NETWORK, intent: TUNNEL_INTENT_PRIVATE_NETWORK, supports: ['sessionTTL', 'httpsPort'] }),
      expect.objectContaining({ key: TUNNEL_MODE_QUICK, intent: TUNNEL_INTENT_EPHEMERAL_PUBLIC, supports: ['sessionTTL', 'httpsPort'] }),
    ]);
  });
});
