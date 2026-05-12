import { EventEmitter } from 'node:events';
import fs from 'node:fs';
import path from 'node:path';
import { describe, expect, it } from 'vitest';

import { createTerminalRuntime } from './runtime.js';

function createRuntime(server) {
  const app = {
    post() {},
    get() {},
    delete() {},
  };

  return createTerminalRuntime({
    app,
    server,
    express: { text: () => (_req, _res, next) => next?.() },
    fs,
    path,
    uiAuthController: null,
    buildAugmentedPath: () => process.env.PATH || '',
    searchPathFor: () => null,
    isExecutable: () => false,
    isRequestOriginAllowed: async () => true,
    rejectWebSocketUpgrade() {},
    TERMINAL_INPUT_WS_HEARTBEAT_INTERVAL_MS: 30_000,
    TERMINAL_INPUT_WS_REBIND_WINDOW_MS: 1_000,
    TERMINAL_INPUT_WS_MAX_REBINDS_PER_WINDOW: 3,
  });
}

describe('terminal runtime', () => {
  it('removes its websocket upgrade listener on shutdown', async () => {
    const server = new EventEmitter();
    const runtime = createRuntime(server);

    expect(server.listenerCount('upgrade')).toBe(1);

    await runtime.shutdown();

    expect(server.listenerCount('upgrade')).toBe(0);
  });
});
