import { describe, test } from 'node:test';
import assert from 'node:assert/strict';

type BridgeRequest = { id: string; type: string };

describe('VS Code webview settings API', () => {
  test('propagates a failed bridge read and retries successfully', async () => {
    const originalWindow = globalThis.window;
    // SAFETY: acquireVsCodeApi is an optional webview global and is restored to this exact value below.
    const originalAcquire = (globalThis as typeof globalThis & { acquireVsCodeApi?: unknown }).acquireVsCodeApi;
    const messages: BridgeRequest[] = [];
    // bridge.ts emits a one-time { type: 'webview:ready' } handshake before the
    // first request. It carries no `id`, so skip past it and take the first
    // frame that is an actual request.
    const takeRequest = (): BridgeRequest => {
      for (let frame = messages.shift(); frame; frame = messages.shift()) {
        if (typeof frame.id === 'string') {
          return frame;
        }
      }
      throw new Error('Expected the bridge to post a request');
    };
    const testWindow = Object.assign(new EventTarget(), {
      __VSCODE_CONFIG__: { theme: 'light', workspaceFolder: '/workspace' },
    });

    try {
      Object.defineProperty(globalThis, 'window', {
        configurable: true,
        value: testWindow,
      });
      Object.defineProperty(globalThis, 'acquireVsCodeApi', {
        configurable: true,
        value: () => ({
          postMessage: (message: BridgeRequest) => messages.push(message),
          getState: () => undefined,
          setState: () => undefined,
        }),
      });

      const { createVSCodeSettingsAPI } = await import(`./settings?settings-failure-${Date.now()}`);
      const api = createVSCodeSettingsAPI();

      const failedLoad = api.load();
      const failedRequest = takeRequest();
      testWindow.dispatchEvent(new MessageEvent('message', {
        data: {
          id: failedRequest.id,
          type: failedRequest.type,
          success: false,
          error: 'settings unavailable',
        },
      }));
      await assert.rejects(failedLoad, /settings unavailable/);

      const successfulLoad = api.load();
      const successfulRequest = takeRequest();
      testWindow.dispatchEvent(new MessageEvent('message', {
        data: {
          id: successfulRequest.id,
          type: successfulRequest.type,
          success: true,
          data: { defaultModel: 'provider/model' },
        },
      }));
      await assert.doesNotReject(successfulLoad);
      const result = await successfulLoad;
      assert.equal(result.settings.defaultModel, 'provider/model');
      assert.equal(result.settings.lastDirectory, '/workspace');
    } finally {
      Object.defineProperty(globalThis, 'window', { configurable: true, value: originalWindow });
      Object.defineProperty(globalThis, 'acquireVsCodeApi', { configurable: true, value: originalAcquire });
    }
  });
});
