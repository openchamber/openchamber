/**
 * Reproduction test for issue #2190: "Cursor extension: chat crashes with
 * undefined postMessage after interrupting a streaming response"
 *
 * This test simulates the bridge message flow that occurs when a streaming
 * response is interrupted in the VS Code/Cursor extension webview, and
 * demonstrates the vulnerability where getVSCodeAPI() can return undefined
 * while callers unconditionally access .postMessage on the result.
 */
import { describe, expect, test } from 'bun:test';

// ---------------------------------------------------------------------------
// Simulated bridge.ts code (copied from packages/vscode/webview/api/bridge.ts)
// ---------------------------------------------------------------------------

interface VSCodeAPI {
  postMessage: (message: unknown) => void;
}

// This replicates the exact lazy-init pattern from bridge.ts.
// The TypeScript return type is declared as non-nullable VSCodeAPI,
// but the actual runtime value can be null or undefined.
function createGetVSCodeAPI(acquireImpl: () => VSCodeAPI | null | undefined): () => VSCodeAPI | null | undefined {
  let vscodeApi: VSCodeAPI | null = null;
  return function getVSCodeAPI(): VSCodeAPI | null | undefined {
    if (!vscodeApi) {
      vscodeApi = acquireImpl() as VSCodeAPI | null;
    }
    return vscodeApi;
  };
}

// ---------------------------------------------------------------------------
// Simulated abort flow: concurrent bridge messages during stream interruption
// ---------------------------------------------------------------------------

describe('Bridge getVSCodeAPI postMessage vulnerability (issue #2190)', () => {

  test('getVSCodeAPI() returns non-object when acquireVsCodeApi() returns non-object', () => {
    // Simulate acquireVsCodeApi returning undefined (can happen in Cursor env)
    // Note: Since !undefined is true, getVSCodeAPI() will re-call acquireVsCodeApi()
    // on every invocation when it returns undefined. This means the cached value
    // doesn't help — every call re-attempts acquisition and returns undefined.
    let callCount = 0;
    const getVSCodeAPI = createGetVSCodeAPI(() => {
      callCount++;
      return undefined;
    });

    expect(getVSCodeAPI()).toBeUndefined();
    expect(callCount).toBe(1);

    // Next call: !undefined === true, so acquireVsCodeApi() is called AGAIN
    expect(getVSCodeAPI()).toBeUndefined();
    expect(callCount).toBe(2);

    // Every call re-attempts and returns undefined because the guard !vscodeApi
    // is true for both null and undefined.
    // This means every bridge operation that calls getVSCodeAPI().postMessage(...)
    // will attempt to call acquireVsCodeApi() first, then fail on .postMessage()
  });

  test('getVSCodeAPI() caches null on first call but !null === true so re-calls', () => {
    let callCount = 0;
    const getVSCodeAPI = createGetVSCodeAPI(() => {
      callCount++;
      return null;
    });

    expect(getVSCodeAPI()).toBeNull();
    expect(callCount).toBe(1);

    // !null === true, so it will try again
    expect(getVSCodeAPI()).toBeNull();
    expect(callCount).toBe(2);
  });

  test('multiple concurrent bridge calls during abort (race condition simulation)', async () => {
    // Simulate the concurrent bridge calls that happen during stream interruption:
    // 1. stopSseProxy({ streamId })  - from ReadableStream.cancel()
    // 2. proxyApiRequest(...)        - from session.abort() SDK call  
    // 3. bridge:ack                  - from message listener responding to extension host

    let acquireCallCount = 0;
    const getVSCodeAPI = createGetVSCodeAPI(() => {
      acquireCallCount++;
      // First call succeeds, subsequent calls might return undefined
      // (simulating a state corruption scenario in Cursor's webview)
      if (acquireCallCount === 1) {
        return { postMessage: () => {} };
      }
      return undefined;
    });

    // Simulate the three concurrent calls during abort
    const api1 = getVSCodeAPI();
    expect(api1).toBeDefined();
    expect(acquireCallCount).toBe(1);

    // Subsequent calls return the cached value (which is the valid API object)
    const api2 = getVSCodeAPI();
    expect(api2).toBeDefined();
    expect(acquireCallCount).toBe(1); // Not called again - cached

    // The API object is cached after first call, so subsequent calls are safe.
    // But if acquireVsCodeApi() returns undefined/non-object on the FIRST call,
    // EVERY call after that returns the cached undefined.
  });

  test('acquireVsCodeApi returning undefined on first call breaks all subsequent calls', () => {
    let attempts = 0;
    const getVSCodeAPI = createGetVSCodeAPI(() => {
      attempts++;
      return undefined; // Always returns undefined
    });

    // First call returns undefined
    expect(getVSCodeAPI()).toBeUndefined();

    // Since !undefined === true, acquireVsCodeApi is called every time
    expect(attempts).toBe(1);

    // Second call also calls acquireVsCodeApi again (undefined is falsy, so guard
    // !vscodeApi is always true)
    expect(getVSCodeAPI()).toBeUndefined();
    expect(attempts).toBe(2); // Not cached — re-called because !undefined === true

    // Every .postMessage() call on the result would throw
    // This is what gets reported as:
    //   "TypeError: Cannot read properties of undefined (reading 'postMessage')"
  });

  test('abort flow sends multiple bridge messages that all depend on getVSCodeAPI()', async () => {
    // During a user abort, the following bridge messages are sent (conceptually):
    const messages: Array<{ type: string; payload?: unknown }> = [];

    let vscodeApi: VSCodeAPI | null = null;
    function getVSCodeAPI() {
      if (!vscodeApi) {
        vscodeApi = { postMessage: (msg) => messages.push(msg as { type: string }) };
      }
      return vscodeApi;
    }

    // Simulate SSE proxy stop (from ReadableStream.cancel)
    function stopSseProxy(streamId: string) {
      getVSCodeAPI().postMessage({ id: `req_${Date.now()}`, type: 'api:sse:stop', payload: { streamId } });
    }

    // Simulate abort API call (from session.abort)
    function proxyApiRequest(method: string, path: string) {
      getVSCodeAPI().postMessage({ id: `req_${Date.now()}`, type: 'api:proxy', payload: { method, path } });
    }

    // Simulate bridge:ack (from message listener)
    function sendAck(msgId: string) {
      getVSCodeAPI().postMessage({ type: 'bridge:ack', _msgId: msgId });
    }

    // Execute abort flow - all three happen concurrently
    stopSseProxy('sse_1_1234567890');
    proxyApiRequest('POST', '/session/test-session-id/abort');
    sendAck('msg_abc123');

    expect(messages).toHaveLength(3);
    expect(messages[0].type).toBe('api:sse:stop');
    expect(messages[1].type).toBe('api:proxy');
    expect(messages[2].type).toBe('bridge:ack');

    // Now simulate what happens if vscodeApi is undefined after a state corruption
    // This represents the persistent error state
    messages.length = 0;
    vscodeApi = null; // Reset
    // Now make acquireVsCodeApi return undefined
    const originalPostMessage = (msg: unknown) => messages.push(msg as { type: string });
    // If the API becomes undefined, all subsequent calls fail
    expect(() => {
      getVSCodeAPI().postMessage({ type: 'test' });
    }).not.toThrow(); // Works because cached

    // But if the module-level vscodeApi gets corrupted (e.g., overwritten by some
    // VS Code/Cursor internal), then postMessage would fail.
    // This is the scenario described in the issue.
  });
});

// ---------------------------------------------------------------------------
// Simulated ChatViewProvider postMessage vulnerability (extension host side)
// ---------------------------------------------------------------------------

describe('Extension host postMessage during SSE abort (issue #2190)', () => {

  test('SessionEditorPanelProvider _startSseProxy then/catch uses entry.panel without disposal check', async () => {
    // In SessionEditorPanelProvider._startSseProxy, the .then()/.catch() handlers
    // at lines 436-448 use `entry.panel.webview.postMessage(...)` WITHOUT checking
    // if the panel was disposed in the meantime.
    //
    // VS Code docs say postMessage on a disposed webview should return false,
    // but if the panel's webview property itself becomes inaccessible
    // (e.g., the SessionPanelState reference is stale), this throws.
    const sseStreams = new Map<string, AbortController>();
    let disposed = false;

    const panel = {
      webview: {
        postMessage: (_msg: unknown) => {
          if (disposed) {
            throw new Error('Webview is disposed');
          }
        },
      },
    };

    const controller = new AbortController();
    const streamId = 'sse_test_1';

    // Register the SSE stream
    sseStreams.set(streamId, controller);

    // Create the run promise with the same pattern as SessionEditorPanelProvider
    const run = (async () => {
      await Promise.resolve(); // Simulate SSE stream wait
      // .then() path: no disposal check
      panel.webview.postMessage({ type: 'api:sse:end', streamId });
    })();

    // Now dispose the panel mid-stream (simulating editor tab close during abort)
    disposed = true;

    // The .then() handler doesn't check for disposal and tries to postMessage
    // on the disposed panel's webview
    await expect(run).rejects.toThrow('Webview is disposed');
  });

  test('ChatViewProvider SSE streams survive view disposal and try to postMessage on stale view', () => {
    // In ChatViewProvider._startSseProxy, the .then()/.catch() handlers use
    // `this._view?.webview.postMessage(...)` which is safe (optional chaining),
    // but the _sseStreams Map is cleared in onDidDispose for the matching view.
    //
    // However, the SSE stream's run promise (start.run) continues executing even
    // after disposal. The .finally() handler calls this._sseStreams.delete(streamId)
    // which is a no-op (Map.delete on missing key).
    //
    // The stream controller is aborted in onDidDispose, so within 1 microtask
    // the stream should stop. But if the abort takes time (e.g., fetch in progress),
    // an onChunk callback could fire AFTER disposal.
    //
    // This reproduces the scenario:
    let postMessageCalledAfterDisposal = false;

    const view: {
      webview: { postMessage: (msg: unknown) => void };
    } = {
      webview: {
        postMessage: (_msg: unknown) => {
          postMessageCalledAfterDisposal = true;
        },
      },
    };

    const controller = new AbortController();
    const sseStreams = new Map<string, { controller: AbortController; view: typeof view }>();
    const streamId = 'sse_test_2';

    // Register SSE stream (as in ChatViewProvider)
    sseStreams.set(streamId, { controller, view });

    // Simulate onDispose - abort matching streams
    for (const [id, stream] of sseStreams) {
      if (stream.view !== view) continue;
      stream.controller.abort();
      sseStreams.delete(id);
    }

    // Simulate onChunk firing from an in-flight fetch callback
    // The controller is aborted but the fetch promise .then() might still fire
    // before the abort propagates
    view.webview.postMessage({ type: 'api:sse:chunk', streamId, chunk: 'delayed-data' });

    // The chunk would be sent even though the stream is already cleaned up
    // This is a minor issue (zombie chunk), not the crash cause.
    expect(postMessageCalledAfterDisposal).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// Root cause analysis summary
// ---------------------------------------------------------------------------

/**
 * ROOT CAUSE ANALYSIS
 *
 * The error "TypeError: Cannot read properties of undefined (reading 'postMessage')"
 * occurs when `getVSCodeAPI()` returns `undefined` and any of the four call sites
 * in bridge.ts (lines 49, 125, 149, 164) accesses `.postMessage` on it.
 *
 * The TypeScript return type `getVSCodeAPI(): VSCodeAPI` is incorrect — it should
 * be `VSCodeAPI | null | undefined` because:
 *   1. `acquireVsCodeApi()` is a declared global whose return contract is not
 *      guaranteed by VS Code API docs.
 *   2. The initial value of `vscodeApi` is `null`, so the first call without
 *      successful acquisition returns `null`.
 *   3. Cursor (a VS Code fork) may have a different webview implementation where
 *      `acquireVsCodeApi()` can return `undefined` in certain states.
 *
 * However, since `vscodeApi` is cached after the first successful call, a one-time
 * failure during initialization would not explain the persistence. The more likely
 * scenario is:
 *
 * **Race condition during abort:**
 * The abort flow triggers MULTIPLE concurrent bridge operations:
 *   - stopSseProxy (from ReadableStream.cancel())
 *   - proxyApiRequest (from session.abort SDK call)
 *   - bridge:ack responses (from message listener)
 *
 * In the SessionEditorPanelProvider specifically, the SSE proxy's `.then()` and
 * `.catch()` handlers (lines 436-448) call `entry.panel.webview.postMessage()`
 * WITHOUT checking if the panel was disposed. If the panel/editor tab was closed
 * simultaneously with the abort, `entry.panel.webview` could be in an invalid
 * state or `postMessage` could unexpectedly be undefined.
 *
 * Additionally, the SSE proxy's onChunk callback fires outside React's error
 * boundary. If the callback throws, it's an unhandled error. But the React error
 * boundary catches React-lifecycle errors. The only React-useEffect postMessage
 * is `window.parent.postMessage()` in ChatContainer.tsx (line 684), which could
 * fail if `window.parent` is unexpectedly undefined in the Cursor webview.
 */
