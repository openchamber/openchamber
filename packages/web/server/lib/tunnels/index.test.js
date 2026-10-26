import { describe, expect, it } from 'bun:test';

import { createTunnelService } from './index.js';
import {
  TUNNEL_INTENT_EPHEMERAL_PUBLIC,
  TUNNEL_MODE_QUICK,
  TUNNEL_PROVIDER_CLOUDFLARE,
  TUNNEL_MODE_SERVE,
  TUNNEL_PROVIDER_NGROK,
  TUNNEL_PROVIDER_TAILSCALE,
} from './types.js';
import { tailscaleTunnelProviderCapabilities } from './providers/tailscale.js';

const createProvider = ({ provider, start, stop, resolvePublicUrl }) => ({
  id: provider,
  capabilities: {
    provider,
    modes: [{ key: TUNNEL_MODE_QUICK, intent: TUNNEL_INTENT_EPHEMERAL_PUBLIC }],
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

  describe('HTTPS port changes', () => {
    const setup = () => {
      const starts = [];
      const stops = [];
      let controller = null;
      const provider = {
        ...createProvider({
          provider: TUNNEL_PROVIDER_TAILSCALE,
          start: async (request) => {
            starts.push(request.httpsPort);
            const port = request.httpsPort ?? 443;
            return { mode: request.mode, httpsPort: port, getPublicUrl: () => `https://box.ts.net:${port}` };
          },
          stop: (active) => { stops.push(active.httpsPort); },
        }),
        capabilities: tailscaleTunnelProviderCapabilities,
      };
      const service = createTunnelService({
        registry: createRegistry({ [TUNNEL_PROVIDER_TAILSCALE]: provider }),
        getController: () => controller,
        setController: (next) => { controller = next; },
        getActivePort: () => 3000,
      });
      return { service, starts, stops };
    };

    it('replaces the running tunnel when the port changes', async () => {
      const { service, starts, stops } = setup();
      await service.start({ provider: TUNNEL_PROVIDER_TAILSCALE, mode: TUNNEL_MODE_SERVE, httpsPort: 443 });
      const result = await service.start({ provider: TUNNEL_PROVIDER_TAILSCALE, mode: TUNNEL_MODE_SERVE, httpsPort: 8443 });

      expect(starts).toEqual([443, 8443]);
      expect(stops).toEqual([443]);
      expect(result.publicUrl).toBe('https://box.ts.net:8443');
    });

    it('keeps the running tunnel for the same port or no port', async () => {
      const { service, starts, stops } = setup();
      await service.start({ provider: TUNNEL_PROVIDER_TAILSCALE, mode: TUNNEL_MODE_SERVE, httpsPort: 8443 });
      await service.start({ provider: TUNNEL_PROVIDER_TAILSCALE, mode: TUNNEL_MODE_SERVE, httpsPort: 8443 });
      await service.start({ provider: TUNNEL_PROVIDER_TAILSCALE, mode: TUNNEL_MODE_SERVE });

      expect(starts).toEqual([8443]);
      expect(stops).toEqual([]);
    });
  });
});
