import { describe, expect, it, vi } from 'vitest';

import { createStartupPipelineRuntime } from './startup-pipeline-runtime.js';

describe('startup pipeline runtime', () => {
  it('publishes the listening port before bootstrapping managed OpenCode', async () => {
    const order = [];
    let startupTunnelRequest;
    const runtime = createStartupPipelineRuntime({
      createTerminalRuntime: () => ({}),
      createDictationRuntime: () => ({}),
      createMessageStreamWsRuntime: () => ({}),
      createServerStartupRuntime: () => ({
        resolveBindHost: () => '127.0.0.1',
        startListeningAndMaybeTunnel: async ({ startupTunnelRequest: request }) => {
          order.push('listen');
          startupTunnelRequest = request;
          return { activePort: 3901 };
        },
        attachProcessHandlers: vi.fn(),
      }),
    });

    await runtime.run({
      app: {},
      setupProxy: vi.fn(),
      staticRoutesRuntime: { registerStaticRoutes: vi.fn() },
      apiOnly: false,
      tunnelRuntimeContext: {
        setActivePort: (port) => order.push(`port:${port}`),
      },
      startupTunnelRequest: {
        provider: 'tailscale',
        mode: 'private-network',
        tailscaleHttpsPort: 9443,
      },
      scheduleOpenCodeApiDetection: () => order.push('detect'),
      bootstrapOpenCodeAtStartup: () => order.push('bootstrap'),
      process: {},
      crypto: {},
      server: {},
      attachSignals: false,
    });

    expect(order).toEqual(['listen', 'port:3901', 'detect', 'bootstrap']);
    expect(startupTunnelRequest.tailscaleHttpsPort).toBe(9443);
  });
});
