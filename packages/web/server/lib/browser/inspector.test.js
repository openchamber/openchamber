import { afterEach, describe, expect, it, vi } from 'vitest';
import { createBrowserInspector } from './inspector.js';
import { surfaceInspectorMessageSchema } from '../../../../ui/src/lib/browser/remoteSurfaceInspectorProtocol.ts';

const settle = async () => { for (let index = 0; index < 16; index += 1) await Promise.resolve(); };

const setup = () => {
  const listeners = new Set();
  const commands = [];
  const hooks = new Map();
  let takeoverCount = 0;
  let leaseGeneration = 0;
  const cdp = {
    getSessionId: (targetId) => `cdp-${targetId}`,
    onEvent: (listener) => { listeners.add(listener); return () => listeners.delete(listener); },
    sendSession: async (sessionId, method, params = {}) => {
      commands.push({ sessionId, method, params });
      if (hooks.has(method)) return hooks.get(method)(params);
      if (method === 'Page.getFrameTree') return { frameTree: { frame: { id: 'main' } } };
      if (method === 'Runtime.evaluate') return { result: { type: 'number', value: 42 } };
      if (method === 'Network.getRequestPostData') return { postData: '{"name":"sample","password":"private"}' };
      if (method === 'Network.getResponseBody') return { body: '{"result":"ok","token":"private"}', base64Encoded: false };
      return {};
    },
  };
  const manager = {
    runReadOnlyOperation: async (_sessionId, options) => {
      if (!options.requireTargetOwnership) throw new Error('Target ownership must be checked');
      return options.operation({ cdp });
    },
  };
  const inspector = createBrowserInspector({ browserSessionManager: manager,
    parseString: (value) => String.prototype.valueOf.call(value),
    sendJson: (socket, message) => { surfaceInspectorMessageSchema.parse(message); socket.messages.push(message); return true; },
    runViewerOperation: async (viewer, targetId, operation) => {
      takeoverCount += 1;
      const generation = ++leaseGeneration;
      const attachmentGeneration = viewer.attachmentGeneration;
      const isCurrent = () => viewer.socket.readyState === 1 && viewer.attached && viewer.tabId === `sc:${targetId}`
        && viewer.attachmentGeneration === attachmentGeneration && generation === leaseGeneration;
      await cdp.sendSession(cdp.getSessionId(targetId), 'Page.bringToFront');
      if (!isCurrent()) return;
      return operation({ cdp, isCurrent });
    },
  });
  const viewer = { id: 'viewer-1', attached: true, tabId: 'sc:page-1', attachmentGeneration: 1,
    socket: { readyState: 1, bufferedAmount: 0, messages: [] }, surfaceSession: { sessionId: 'session-1', closed: false } };
  const send = (type, payload = {}, target = viewer) => inspector.handle(target, { type, tabId: target.tabId, requestId: `request-${type}`, ...payload }, type);
  const open = async (target = viewer) => {
    send('inspectorStart', {}, target);
    await settle();
    return target.socket.messages.findLast((message) => message.type === 'inspectorStarted').captureId;
  };
  const emit = (method, params, targetId = 'page-1') => {
    for (const listener of listeners) listener({ sessionId: `cdp-${targetId}`, method, params });
  };
  return { inspector, viewer, commands, hooks, listeners, send, open, emit,
    takeoverCount: () => takeoverCount, takeover: () => { leaseGeneration += 1; } };
};

const networkRequest = { requestId: 'network-1', timestamp: 20, wallTime: 1_750_000_000,
  type: 'Fetch', request: { url: 'https://example.test/?token=private', method: 'POST', hasPostData: true,
    headers: { Authorization: 'Bearer private', 'Content-Type': 'application/json' } } };

const captureNetwork = async (ctx) => {
  const captureId = await ctx.open();
  ctx.emit('Network.requestWillBeSent', networkRequest);
  ctx.emit('Network.responseReceived', { requestId: 'network-1', timestamp: 20.2,
    response: { status: 200, mimeType: 'application/json', headers: { 'Set-Cookie': 'private' } } });
  ctx.emit('Network.loadingFinished', { requestId: 'network-1', timestamp: 20.4, encodedDataLength: 80 });
  await vi.advanceTimersByTimeAsync(100);
  return { captureId, entryId: ctx.viewer.socket.messages.findLast((message) => message.type === 'inspectorEvents').network[0].id };
};

afterEach(() => vi.useRealTimers());

describe('browser inspector lifecycle and ownership', () => {
  it('starts passively, isolates target events, and shares Runtime enablement until the last viewer closes', async () => {
    vi.useFakeTimers();
    const ctx = setup();
    const captureId = await ctx.open();
    const observer = { ...ctx.viewer, id: 'viewer-2', socket: { readyState: 1, bufferedAmount: 0, messages: [] } };
    const observerCapture = await ctx.open(observer);
    expect(observerCapture).not.toBe(captureId);
    expect(ctx.takeoverCount()).toBe(0);
    expect(ctx.commands.filter((command) => command.method === 'Runtime.enable')).toHaveLength(1);
    ctx.emit('Runtime.consoleAPICalled', { type: 'log', timestamp: Date.now(), args: [{ type: 'string', value: 'foreign' }] }, 'foreign');
    ctx.emit('Runtime.consoleAPICalled', { type: 'log', timestamp: Date.now(), args: [{ type: 'string', value: 'visible' }] });
    await vi.advanceTimersByTimeAsync(100);
    expect(ctx.viewer.socket.messages[0].type).toBe('inspectorStarted');
    expect(ctx.viewer.socket.messages[1].console[0].text).toBe('visible');
    expect(observer.socket.messages[1].console[0].text).toBe('visible');
    ctx.send('inspectorStop', { captureId });
    await settle();
    expect(ctx.commands.some((command) => command.method === 'Runtime.disable')).toBe(false);
    ctx.send('inspectorStop', { captureId: observerCapture }, observer);
    await settle();
    expect(ctx.commands.filter((command) => command.method === 'Runtime.disable')).toHaveLength(1);
    expect(ctx.commands.some((command) => command.method === 'Network.disable')).toBe(false);
    expect(ctx.listeners.size).toBe(0);
    ctx.inspector.dispose();
    expect(vi.getTimerCount()).toBe(0);
  });

  it('cancels startup without captureId and never emits late started or event messages', async () => {
    vi.useFakeTimers();
    const ctx = setup();
    let release;
    ctx.hooks.set('Runtime.enable', () => new Promise((resolve) => { release = resolve; }));
    ctx.send('inspectorStart');
    await settle();
    ctx.send('inspectorStop');
    release({});
    await settle();
    expect(ctx.viewer.socket.messages).toEqual([]);
    expect(ctx.listeners.size).toBe(0);
    expect(ctx.commands.some((command) => command.method === 'Runtime.disable')).toBe(true);
    ctx.inspector.dispose();
  });

  it('serializes a reopen behind an in-flight Runtime disable', async () => {
    const ctx = setup();
    const first = await ctx.open();
    let release;
    ctx.hooks.set('Runtime.disable', () => new Promise((resolve) => { release = resolve; }));
    ctx.send('inspectorStop', { captureId: first });
    await settle();
    ctx.send('inspectorStart');
    await settle();
    expect(ctx.viewer.socket.messages.filter((message) => message.type === 'inspectorStarted')).toHaveLength(1);
    release({});
    await settle();
    expect(ctx.viewer.socket.messages.filter((message) => message.type === 'inspectorStarted')).toHaveLength(2);
    expect(ctx.commands.filter((command) => command.method === 'Runtime.enable')).toHaveLength(2);
    ctx.inspector.dispose();
  });

  it('rejects malformed, unattached and foreign capture requests without taking control', async () => {
    const ctx = setup();
    ctx.send('inspectorStart', { tabId: 'sc:foreign' });
    expect(ctx.viewer.socket.messages.at(-1)).toMatchObject({ type: 'inspectorError', code: 'UNAVAILABLE' });
    const captureId = await ctx.open();
    ctx.send('inspectorEvaluate', { captureId, expression: 'x'.repeat(16_001) });
    expect(ctx.viewer.socket.messages.at(-1).code).toBe('INVALID_REQUEST');
    ctx.send('inspectorRequest', { captureId, entryId: 'entry', includeBody: 'true' });
    expect(ctx.viewer.socket.messages.at(-1).code).toBe('INVALID_REQUEST');
    ctx.send('inspectorEvaluate', { captureId: 'foreign', expression: 'private expression' });
    expect(ctx.viewer.socket.messages.at(-1).code).toBe('CAPTURE_GONE');
    expect(JSON.stringify(ctx.viewer.socket.messages)).not.toContain('private expression');
    expect(ctx.takeoverCount()).toBe(0);
    ctx.inspector.dispose();
  });
});

describe('browser inspector evaluation and request details', () => {
  it('awaits the promise object returned by Chrome REPL mode before reporting its value', async () => {
    const ctx = setup();
    const captureId = await ctx.open();
    ctx.hooks.set('Runtime.evaluate', async () => ({ result: { type: 'object', subtype: 'promise', objectId: 'promise-1', description: 'Promise' } }));
    ctx.hooks.set('Runtime.awaitPromise', async () => ({ result: { type: 'number', value: 42 } }));
    ctx.send('inspectorEvaluate', { captureId, expression: 'Promise.resolve(42)' });
    await settle();
    expect(ctx.takeoverCount()).toBe(1);
    expect(ctx.commands.find((command) => command.method === 'Runtime.evaluate').params).toMatchObject({
      expression: 'Promise.resolve(42)', awaitPromise: true, generatePreview: true, timeout: 1_000, returnByValue: false, replMode: true,
    });
    expect(ctx.commands.find((command) => command.method === 'Runtime.awaitPromise')?.params).toEqual({
      promiseObjectId: 'promise-1', returnByValue: false, generatePreview: true,
    });
    expect(ctx.viewer.socket.messages.at(-1)).toMatchObject({ type: 'inspectorEvaluated', text: '42', isError: false, truncated: false });
    expect(ctx.commands.filter((command) => command.method === 'Runtime.releaseObjectGroup')).toHaveLength(1);
    ctx.inspector.dispose();
  });

  it('reports a rejected REPL promise as an exception rather than a successful preview', async () => {
    const ctx = setup();
    const captureId = await ctx.open();
    ctx.hooks.set('Runtime.evaluate', async () => ({ result: { type: 'object', subtype: 'promise', objectId: 'promise-1', description: 'Promise' } }));
    ctx.hooks.set('Runtime.awaitPromise', async () => ({ result: { type: 'string', value: 'rejected value' },
      exceptionDetails: { text: 'Uncaught (in promise)', exception: { type: 'string', value: 'rejected value' } } }));
    ctx.send('inspectorEvaluate', { captureId, expression: "Promise.reject('rejected value')" });
    await settle();
    expect(ctx.viewer.socket.messages.at(-1)).toMatchObject({ type: 'inspectorEvaluated', text: 'rejected value', isError: true });
    expect(ctx.commands.filter((command) => command.method === 'Runtime.releaseObjectGroup')).toHaveLength(1);
    ctx.inspector.dispose();
  });

  it('shows bounded exception results but sanitizes protocol errors', async () => {
    const ctx = setup();
    const captureId = await ctx.open();
    ctx.hooks.set('Runtime.evaluate', async () => ({ exceptionDetails: { exception: { type: 'object', subtype: 'error', description: 'Error: page exception' } } }));
    ctx.send('inspectorEvaluate', { captureId, expression: 'throw new Error()' });
    await settle();
    expect(ctx.viewer.socket.messages.at(-1)).toMatchObject({ type: 'inspectorEvaluated', isError: true, text: 'Error: page exception' });
    ctx.hooks.set('Runtime.evaluate', async () => { throw new Error('private protocol error'); });
    ctx.send('inspectorEvaluate', { captureId, expression: 'private expression' });
    await settle();
    expect(ctx.viewer.socket.messages.at(-1)).toMatchObject({ type: 'inspectorError', code: 'EVALUATION_FAILED' });
    expect(JSON.stringify(ctx.viewer.socket.messages)).not.toContain('private');
    ctx.inspector.dispose();
  });

  it.each(['timeout', 'close', 'navigation', 'same-document navigation', 'context cleared', 'takeover'])('suppresses stale evaluation after %s and releases late objects', async (invalidation) => {
    vi.useFakeTimers();
    const ctx = setup();
    const captureId = await ctx.open();
    let release;
    ctx.hooks.set('Runtime.evaluate', () => new Promise((resolve) => { release = resolve; }));
    ctx.send('inspectorEvaluate', { captureId, expression: 'new Promise(() => {})' });
    await settle();
    if (invalidation === 'timeout') await vi.advanceTimersByTimeAsync(5_000);
    else if (invalidation === 'close') ctx.send('inspectorStop', { captureId });
    else if (invalidation === 'navigation') ctx.emit('Page.frameNavigated', { frame: { id: 'main', url: 'https://example.test/new' } });
    else if (invalidation === 'same-document navigation') ctx.emit('Page.navigatedWithinDocument', { frameId: 'main' });
    else if (invalidation === 'context cleared') ctx.emit('Runtime.executionContextsCleared', {});
    else ctx.takeover();
    await settle();
    release({ result: { type: 'string', value: 'stale result', objectId: 'private-object-id' } });
    await settle();
    expect(ctx.viewer.socket.messages.some((message) => message.type === 'inspectorEvaluated')).toBe(false);
    if (invalidation === 'timeout') expect(ctx.viewer.socket.messages.at(-1).code).toBe('EVALUATION_TIMEOUT');
    expect(ctx.commands.some((command) => command.method === 'Runtime.releaseObjectGroup')).toBe(true);
    expect(JSON.stringify(ctx.viewer.socket.messages)).not.toContain('stale result');
    ctx.inspector.dispose();
    expect(vi.getTimerCount()).toBe(0);
  });

  it.each(['timeout', 'close', 'navigation', 'takeover'])('suppresses a pending REPL promise after %s and releases late objects', async (invalidation) => {
    vi.useFakeTimers();
    const ctx = setup();
    const captureId = await ctx.open();
    let release;
    ctx.hooks.set('Runtime.evaluate', async () => ({ result: { type: 'object', subtype: 'promise', objectId: 'promise-1', description: 'Promise' } }));
    ctx.hooks.set('Runtime.awaitPromise', () => new Promise((resolve) => { release = resolve; }));
    ctx.send('inspectorEvaluate', { captureId, expression: 'new Promise(() => {})' });
    await settle();
    if (invalidation === 'timeout') await vi.advanceTimersByTimeAsync(5_000);
    else if (invalidation === 'close') ctx.send('inspectorStop', { captureId });
    else if (invalidation === 'navigation') ctx.emit('Page.frameNavigated', { frame: { id: 'main', url: 'https://example.test/new' } });
    else ctx.takeover();
    await settle();
    expect(ctx.viewer.socket.messages.some((message) => message.type === 'inspectorEvaluated')).toBe(false);
    if (invalidation === 'timeout') expect(ctx.viewer.socket.messages.at(-1)).toMatchObject({ type: 'inspectorError', code: 'EVALUATION_TIMEOUT' });
    release({ result: { type: 'object', description: 'stale result', objectId: 'late-result' } });
    await settle();
    expect(ctx.viewer.socket.messages.some((message) => message.type === 'inspectorEvaluated')).toBe(false);
    expect(ctx.commands.some((command) => command.method === 'Runtime.releaseObjectGroup')).toBe(true);
    ctx.inspector.dispose();
    expect(vi.getTimerCount()).toBe(0);
  });

  it('reads metadata passively and fetches redacted textual bodies only by explicit request', async () => {
    vi.useFakeTimers();
    const ctx = setup();
    const request = await captureNetwork(ctx);
    ctx.send('inspectorRequest', { ...request, includeBody: false });
    await settle();
    expect(ctx.viewer.socket.messages.at(-1)).toMatchObject({ type: 'inspectorRequestResult', bodyState: 'not-requested', requestBody: null, responseBody: null });
    expect(ctx.commands.some((command) => command.method.startsWith('Network.get'))).toBe(false);
    ctx.send('inspectorRequest', { ...request, includeBody: true });
    await settle();
    const result = ctx.viewer.socket.messages.at(-1);
    expect(result).toMatchObject({ type: 'inspectorRequestResult', bodyState: 'available' });
    expect(result.requestBody).toContain('[REDACTED]');
    expect(result.responseBody).toContain('[REDACTED]');
    expect(JSON.stringify(result)).not.toContain('private');
    expect(ctx.takeoverCount()).toBe(0);
    ctx.inspector.dispose();
  });

  it('does not restore details after network clear or capture close', async () => {
    vi.useFakeTimers();
    const ctx = setup();
    const request = await captureNetwork(ctx);
    let release;
    ctx.hooks.set('Network.getResponseBody', () => new Promise((resolve) => { release = resolve; }));
    ctx.send('inspectorRequest', { ...request, includeBody: true });
    await settle();
    ctx.send('inspectorClear', { captureId: request.captureId, scope: 'network' });
    release({ body: 'old body', base64Encoded: false });
    await settle();
    expect(ctx.viewer.socket.messages.some((message) => message.type === 'inspectorRequestResult')).toBe(false);
    expect(ctx.viewer.socket.messages.at(-1).type).toBe('inspectorCleared');
    ctx.send('inspectorRequest', { ...request, includeBody: false });
    expect(ctx.viewer.socket.messages.at(-1).code).toBe('REQUEST_GONE');
    ctx.inspector.dispose();
  });

  it('accepts a later evaluation after control invalidates an earlier one', async () => {
    const ctx = setup();
    const captureId = await ctx.open();
    let release;
    ctx.hooks.set('Runtime.evaluate', () => new Promise((resolve) => { release = resolve; }));
    ctx.send('inspectorEvaluate', { captureId, expression: 'pending' });
    await settle();
    ctx.takeover();
    release({ result: { type: 'number', value: 1 } });
    await settle();
    ctx.hooks.delete('Runtime.evaluate');
    ctx.send('inspectorEvaluate', { captureId, expression: '42' });
    await settle();
    expect(ctx.viewer.socket.messages.at(-1)).toMatchObject({ type: 'inspectorEvaluated', text: '42' });
    ctx.inspector.dispose();
  });

  it('does not extend the five-second deadline while object-group cleanup is pending', async () => {
    vi.useFakeTimers();
    const ctx = setup();
    const captureId = await ctx.open();
    ctx.hooks.set('Runtime.evaluate', () => new Promise(() => {}));
    ctx.hooks.set('Runtime.releaseObjectGroup', () => new Promise(() => {}));
    ctx.send('inspectorEvaluate', { captureId, expression: 'new Promise(() => {})' });
    await settle();
    await vi.advanceTimersByTimeAsync(5_000);
    expect(ctx.viewer.socket.messages.at(-1)).toMatchObject({ type: 'inspectorError', code: 'EVALUATION_TIMEOUT' });
    ctx.inspector.dispose();
  });

  it('bounds the complete header and escaped-body detail reply', async () => {
    vi.useFakeTimers();
    const ctx = setup();
    const captureId = await ctx.open();
    const headers = Object.fromEntries(Array.from({ length: 63 }, (_, index) => [`Header-${index}`, '\u0000'.repeat(1_024)]));
    headers['Content-Type'] = 'text/plain';
    ctx.emit('Network.requestWillBeSent', { ...networkRequest, request: { ...networkRequest.request, headers } });
    ctx.emit('Network.responseReceived', { requestId: 'network-1', timestamp: 20.2, response: { status: 200, mimeType: 'text/plain', headers } });
    ctx.emit('Network.loadingFinished', { requestId: 'network-1', timestamp: 20.4, encodedDataLength: 80 });
    await vi.advanceTimersByTimeAsync(100);
    const entryId = ctx.viewer.socket.messages.at(-1).network[0].id;
    ctx.hooks.set('Network.getRequestPostData', async () => ({ postData: '\u0000'.repeat(8_000) }));
    ctx.hooks.set('Network.getResponseBody', async () => ({ body: '\u0000'.repeat(8_000), base64Encoded: false }));
    ctx.send('inspectorRequest', { captureId, entryId, includeBody: true });
    await settle();
    const response = ctx.viewer.socket.messages.at(-1);
    expect(response).toMatchObject({ type: 'inspectorRequestResult', truncated: true, bodyState: 'available' });
    expect(Buffer.byteLength(JSON.stringify(response))).toBeLessThan(64 * 1024);
    ctx.inspector.dispose();
  });

  it('does not fetch binary request or response bodies', async () => {
    vi.useFakeTimers();
    const ctx = setup();
    const captureId = await ctx.open();
    ctx.emit('Network.requestWillBeSent', { ...networkRequest, request: { ...networkRequest.request,
      headers: { 'Content-Type': 'application/octet-stream' } } });
    ctx.emit('Network.responseReceived', { requestId: 'network-1', timestamp: 20.2, response: { status: 200, mimeType: 'image/png', headers: {} } });
    ctx.emit('Network.loadingFinished', { requestId: 'network-1', timestamp: 20.4, encodedDataLength: 80 });
    await vi.advanceTimersByTimeAsync(100);
    const entryId = ctx.viewer.socket.messages.at(-1).network[0].id;
    ctx.send('inspectorRequest', { captureId, entryId, includeBody: true });
    await settle();
    expect(ctx.viewer.socket.messages.at(-1)).toMatchObject({ type: 'inspectorRequestResult', bodyState: 'unsupported', requestBody: null, responseBody: null });
    expect(ctx.commands.some((command) => command.method.startsWith('Network.get'))).toBe(false);
    ctx.inspector.dispose();
  });
});
