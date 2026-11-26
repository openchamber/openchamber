import { after, before, describe, test } from 'node:test';
import assert from 'node:assert/strict';

describe('VS Code webview bridge requests', () => {
  const originalWindow = globalThis.window;
  const originalAcquire = (globalThis as typeof globalThis & { acquireVsCodeApi?: unknown }).acquireVsCodeApi;
  const messages: unknown[] = [];
  const fakeWindow = new EventTarget();
  let bridgeModule: typeof import('./bridge');

  before(async () => {
    Object.defineProperty(globalThis, 'window', {
      configurable: true,
      value: fakeWindow,
    });
    Object.defineProperty(globalThis, 'acquireVsCodeApi', {
      configurable: true,
      value: () => ({
        postMessage: (message: unknown) => messages.push(message),
        getState: () => undefined,
        setState: () => undefined,
      }),
    });
    bridgeModule = await import('./bridge');
  });

  after(() => {
    Object.defineProperty(globalThis, 'window', { configurable: true, value: originalWindow });
    Object.defineProperty(globalThis, 'acquireVsCodeApi', { configurable: true, value: originalAcquire });
  });

  test('announces the document once before requests and skips already aborted requests', async () => {
    const { sendBridgeMessageWithOptions, startSseProxy, postBridgeNotification } = bridgeModule;
    const controller = new AbortController();
    controller.abort();

    const result = await Promise.race([
      sendBridgeMessageWithOptions('api:proxy', undefined, { signal: controller.signal }).then(
        () => 'resolved',
        (error: unknown) => error,
      ),
      new Promise((resolve) => setTimeout(() => resolve('timeout'), 20)),
    ]);

    assert.ok(result instanceof DOMException);
    assert.equal(result.name, 'AbortError');
    assert.equal(messages.length, 0);

    const startPromise = startSseProxy({ path: '/api/event', streamId: 'sse_webview_1_1' });
    assert.deepEqual(messages[0], { type: 'webview:ready' });
    const request = messages[1] as { id: string; payload?: { streamId?: string } };
    assert.equal(request.payload?.streamId, 'sse_webview_1_1');
    fakeWindow.dispatchEvent(new MessageEvent('message', {
      data: {
        id: request.id,
        type: 'api:sse:start',
        success: true,
        data: { status: 200, headers: {}, streamId: 'sse_webview_1_1' },
      },
    }));
    assert.equal((await startPromise).streamId, 'sse_webview_1_1');
    assert.equal(messages.length, 2);
    postBridgeNotification('test:notification', { value: 1 });
    assert.deepEqual(messages.slice(2), [{ type: 'test:notification', payload: { value: 1 } }]);
  });

  test('preserves HTTP 403 trust refusal metadata on BridgeRequestError and builds a real 403 JSON Response', async () => {
    const { BridgeRequestError, bridgeRequestErrorResponse, sendBridgeMessage } = bridgeModule;

    const trustPromise = sendBridgeMessage('api:small-model:get', { directory: '/untrusted/repo' });
    const trustRequest = messages.at(-1) as { id: string };
    fakeWindow.dispatchEvent(new MessageEvent('message', {
      data: {
        id: trustRequest.id,
        type: 'api:small-model:get',
        success: false,
        status: 403,
        code: 'opencode_trust_required',
        directory: '/untrusted/repo',
        error: 'OpenCode is paused for this folder until you trust the plugins and commands in its configuration',
      },
    }));

    let trustError: unknown;
    try {
      await trustPromise;
    } catch (error) {
      trustError = error;
    }

    assert.ok(trustError instanceof BridgeRequestError);
    assert.equal(trustError.status, 403);
    assert.equal(trustError.code, 'opencode_trust_required');
    assert.equal(trustError.directory, '/untrusted/repo');

    const response = bridgeRequestErrorResponse(trustError);
    assert.equal(response.status, 403);
    assert.equal(response.headers.get('content-type'), 'application/json');
    assert.deepEqual(await response.json(), {
      error: 'OpenCode is paused for this folder until you trust the plugins and commands in its configuration',
      code: 'opencode_trust_required',
      directory: '/untrusted/repo',
    });

    const genericError = new BridgeRequestError('OpenCode API unavailable', undefined);
    assert.equal(genericError.status, undefined);
    const genericResponse = bridgeRequestErrorResponse(genericError);
    assert.equal(genericResponse.status, 500);
    assert.deepEqual(await genericResponse.json(), { error: 'OpenCode API unavailable' });
  });
});
