import { describe, test } from 'node:test';
import assert from 'node:assert/strict';

type BridgeRequest = { id: string; type: string };
type BridgeMessage = { type: string; id?: string };

describe('VS Code webview settings API', () => {
  test('propagates a failed bridge read and retries successfully', async () => {
    const originalWindow = globalThis.window;
    // SAFETY: acquireVsCodeApi is an optional webview global and is restored to this exact value below.
    const originalAcquire = (globalThis as typeof globalThis & { acquireVsCodeApi?: unknown }).acquireVsCodeApi;
    const messages: BridgeMessage[] = [];
    // getVSCodeAPI() posts { type: 'webview:ready' } before the first request,
    // so the first captured message has no request id and must be skipped.
    const takeRequest = (): BridgeRequest | undefined => {
      for (let index = 0; index < messages.length; index += 1) {
        const { id, type } = messages[index];
        if (id !== undefined) {
          messages.splice(index, 1);
          return { id, type };
        }
      }
      return undefined;
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
          postMessage: (message: BridgeMessage) => messages.push(message),
          getState: () => undefined,
          setState: () => undefined,
        }),
      });

      const { createVSCodeSettingsAPI } = await import(`./settings?settings-failure-${Date.now()}`);
      const api = createVSCodeSettingsAPI();

      const failedLoad = api.load();
      const failedRequest = takeRequest();
      assert.ok(failedRequest);
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
      assert.ok(successfulRequest);
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
