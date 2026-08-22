import { describe, expect, it } from 'bun:test';

import { createTunnelService } from './index.js';
import {
  TUNNEL_INTENT_EPHEMERAL_PUBLIC,
  TUNNEL_MODE_QUICK,
  TUNNEL_PROVIDER_CLOUDFLARE,
  TUNNEL_PROVIDER_NGROK,
  TUNNEL_PROVIDER_TAILSCALE,
} from './types.js';

const createProvider = ({ provider, start, stop, resolvePublicUrl }) => ({
  id: provider,
  capabilities: {
    provider,
    modes: [{ key: TUNNEL_MODE_QUICK, intent: TUNNEL_INTENT_EPHEMERAL_PUBLIC, supports: ['httpsPort'] }],
  },
  checkAvailability: async () => ({ available: true }),
  start,
  stop,
  resolvePublicUrl: resolvePublicUrl || ((controller) => controller?.getPublicUrl?.() ?? null),
});

const createRegistry = (providers) => ({
  get: (providerId) => providers[providerId] ?? null,
});

describe('createTunnelService', () => {
  it('returns provider startup errors to route callers', async () => {
    let controller = null;
    const provider = createProvider({
      provider: TUNNEL_PROVIDER_NGROK,
      start: async () => {
        throw new Error('ngrok authtoken is not configured');
      },
    });
    const service = createTunnelService({
      registry: createRegistry({ [TUNNEL_PROVIDER_NGROK]: provider }),
      getController: () => controller,
      setController: (next) => { controller = next; },
      getActivePort: () => 3000,
    });

    try {
      await service.start({ provider: TUNNEL_PROVIDER_NGROK, mode: TUNNEL_MODE_QUICK });
      throw new Error('Expected service.start to fail');
    } catch (error) {
      expect(error.name).toBe('TunnelServiceError');
      expect(error.code).toBe('startup_failed');
      expect(error.message).toBe('ngrok authtoken is not configured');
    }
  });

  it('replaces an active quick tunnel when the provider changes', async () => {
    let stopped = false;
    let ngrokStarted = false;
    let controller = {
      provider: TUNNEL_PROVIDER_CLOUDFLARE,
      mode: TUNNEL_MODE_QUICK,
      stop: () => { stopped = true; },
      getPublicUrl: () => 'https://cloudflare.example',
    };
    const cloudflareProvider = createProvider({
      provider: TUNNEL_PROVIDER_CLOUDFLARE,
      start: async () => controller,
    });
    const ngrokProvider = createProvider({
      provider: TUNNEL_PROVIDER_NGROK,
      start: async () => {
        ngrokStarted = true;
        return {
          mode: TUNNEL_MODE_QUICK,
          getPublicUrl: () => 'https://demo.ngrok-free.app',
        };
      },
    });
    const service = createTunnelService({
      registry: createRegistry({
        [TUNNEL_PROVIDER_CLOUDFLARE]: cloudflareProvider,
        [TUNNEL_PROVIDER_NGROK]: ngrokProvider,
      }),
      getController: () => controller,
      setController: (next) => { controller = next; },
      getActivePort: () => 3000,
    });

    const result = await service.start({ provider: TUNNEL_PROVIDER_NGROK, mode: TUNNEL_MODE_QUICK });

    expect(stopped).toBe(true);
    expect(ngrokStarted).toBe(true);
    expect(result.provider).toBe(TUNNEL_PROVIDER_NGROK);
    expect(result.publicUrl).toBe('https://demo.ngrok-free.app');
  });


  it('replaces an active Tailscale tunnel when the HTTPS frontend port changes', async () => {
    let controller = {
      provider: TUNNEL_PROVIDER_TAILSCALE,
      mode: TUNNEL_MODE_QUICK,
      tailscaleHttpsPort: 443,
      stop: () => {},
      getPublicUrl: () => 'https://tailscale.example',
    };
    let stopped = false;
    let started = false;
    const tailscaleProvider = createProvider({
      provider: TUNNEL_PROVIDER_TAILSCALE,
      stop: () => { stopped = true; },
      start: async () => {
        started = true;
        return {
          mode: TUNNEL_MODE_QUICK,
          tailscaleHttpsPort: 8443,
          getPublicUrl: () => 'https://tailscale-new.example',
        };
      },
    });
    const service = createTunnelService({
      registry: createRegistry({ [TUNNEL_PROVIDER_TAILSCALE]: tailscaleProvider }),
      getController: () => controller,
      setController: (next) => { controller = next; },
      getActivePort: () => 3000,
    });

    const result = await service.start({
      provider: TUNNEL_PROVIDER_TAILSCALE,
      mode: TUNNEL_MODE_QUICK,
      tailscaleHttpsPort: 8443,
    });

    expect(stopped).toBe(true);
    expect(started).toBe(true);
    expect(result.publicUrl).toBe('https://tailscale-new.example');
    expect(controller.tailscaleHttpsPort).toBe(8443);
  });
});
