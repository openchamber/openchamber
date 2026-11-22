import { describe, expect, it, vi } from 'vitest';

import { createStartupPipelineRuntime } from './startup-pipeline-runtime.js';

describe('startup pipeline runtime', () => {
  it('publishes the listening port before bootstrapping managed OpenCode', async () => {
    const order = [];
    const broadcastUiEvent = vi.fn();
    const createTerminalRuntime = vi.fn(() => ({}));
    const runtime = createStartupPipelineRuntime({
      createTerminalRuntime,
      createDictationRuntime: () => ({}),
      createMessageStreamWsRuntime: () => ({}),
      createPersistentPtyWsRuntime: () => ({}),
      createServerStartupRuntime: () => ({
        resolveBindHost: () => '127.0.0.1',
        startListeningAndMaybeTunnel: async () => {
          order.push('listen');
          return { activePort: 3901 };
        },
        attachProcessHandlers: vi.fn(),
      }),
    });

    await runtime.run({
      app: {},
      broadcastUiEvent,
      setupProxy: vi.fn(),
      staticRoutesRuntime: { registerStaticRoutes: vi.fn() },
      apiOnly: false,
      tunnelRuntimeContext: {
        setActivePort: (port) => order.push(`port:${port}`),
      },
      scheduleOpenCodeApiDetection: () => order.push('detect'),
      bootstrapOpenCodeAtStartup: () => order.push('bootstrap'),
      process: {},
      crypto: {},
      server: {},
      attachSignals: false,
    });

    expect(order).toEqual(['listen', 'port:3901', 'detect', 'bootstrap']);
    expect(createTerminalRuntime).toHaveBeenCalledWith(expect.objectContaining({ broadcastUiEvent }));
  });

  const runWithGate = (gate) => {
    const order = [];
    const runtime = createStartupPipelineRuntime({
      createTerminalRuntime: () => ({}),
      createDictationRuntime: () => ({}),
      createMessageStreamWsRuntime: () => ({}),
      createPersistentPtyWsRuntime: () => ({}),
      createServerStartupRuntime: () => ({
        resolveBindHost: () => '127.0.0.1',
        startListeningAndMaybeTunnel: async () => {
          order.push('listen');
          return { activePort: 3901 };
        },
        attachProcessHandlers: vi.fn(),
      }),
    });
    const run = runtime.run({
      app: {},
      setupProxy: vi.fn(),
      staticRoutesRuntime: { registerStaticRoutes: vi.fn() },
      apiOnly: false,
      tunnelRuntimeContext: { setActivePort: vi.fn() },
      scheduleOpenCodeApiDetection: vi.fn(),
      bootstrapOpenCodeAtStartup: vi.fn(),
      process: {},
      crypto: {},
      server: {},
      attachSignals: false,
      port: 3901,
      handoffProbeGate: async (address) => {
        order.push('gate');
        await gate(address);
      },
    });
    return { run, order };
  };

  it('runs the handoff probe gate before listening, with the port and bind host', async () => {
    const seen = [];
    const { run, order } = runWithGate(async (address) => { seen.push(address); });
    await run;
    expect(seen).toEqual([{ port: 3901, bindHost: '127.0.0.1' }]);
    expect(order).toEqual(['gate', 'listen']);
  });

  it('does not listen when the handoff probe gate refuses', async () => {
    const { run, order } = runWithGate(async () => { throw new Error('preflight-failed'); });
    await expect(run).rejects.toThrow('preflight-failed');
    expect(order).toEqual(['gate']);
  });
});
