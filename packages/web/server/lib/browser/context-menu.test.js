import vm from 'node:vm';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { createBrowserContextMenu } from './context-menu.js';

const request = { type: 'contextMenu', tabId: 'sc:target', attachmentRequestId: 'attachment', requestId: 'request', x: 12.5, y: 34.5 };
const cleanups = [];
afterEach(() => { for (const cleanup of cleanups.splice(0)) cleanup(); vi.useRealTimers(); });
const parseString = (value) => String.prototype.valueOf.call(value);

function fixture() {
  const listeners = new Set();
  const events = new Set();
  const objects = new Map();
  const calls = [];
  const replies = [];
  const window = { document: {}, addEventListener: (_type, listener) => listeners.add(listener),
    removeEventListener: (_type, listener) => listeners.delete(listener), setTimeout, clearTimeout };
  window.top = window;
  objects.set('node', { ownerDocument: { defaultView: window } });
  const control = { current: true, observe: true, trusted: true, canceled: false, hook: async () => {} };
  const cdp = {
    getSessionId: () => 'cdp',
    onEvent(listener) { events.add(listener); return () => events.delete(listener); },
    async sendSession(sessionId, method, params) {
      calls.push({ sessionId, method, params });
      await control.hook(method, params);
      if (method === 'Page.getLayoutMetrics') return { cssLayoutViewport: { pageX: 100, pageY: 200, clientWidth: 800, clientHeight: 600 } };
      if (method === 'DOM.getNodeForLocation') return { backendNodeId: 42 };
      if (method === 'DOM.resolveNode') return { object: { objectId: 'node' } };
      if (method === 'Runtime.callFunctionOn') {
        const fn = vm.runInNewContext(`(${params.functionDeclaration})`);
        const value = fn.call(objects.get(params.objectId));
        if (params.returnByValue) return { result: { value } };
        if (!value) return { result: { subtype: 'null' } };
        objects.set('observer', value);
        return { result: { objectId: 'observer' } };
      }
      if (method === 'Input.dispatchMouseEvent' && params.type === 'mousePressed' && control.observe) {
        const event = { isTrusted: control.trusted, button: 2, defaultPrevented: false };
        for (const listener of listeners) listener(event);
        event.defaultPrevented = control.canceled;
      }
      return {};
    },
  };
  const viewer = { id: 'viewer', socket: { readyState: 1 }, attached: true, tabId: request.tabId,
    attachmentRequestId: request.attachmentRequestId, attachmentGeneration: 1, surfaceSession: { sessionId: 'surface', closed: false } };
  const menu = createBrowserContextMenu({
    parseString,
    browserSessionManager: { getLease: () => control.current ? { viewerId: viewer.id, generation: 1 } : null,
      onControlChange: () => () => {} },
    runViewerOperation: (_viewer, _target, operation) => operation({ cdp, isCurrent: () => control.current }),
    sendJson: (_socket, reply) => replies.push(reply),
  });
  cleanups.push(() => menu.dispose());
  const send = () => menu.handle(viewer, request, 'contextMenu');
  return { menu, viewer, send, calls, replies, control, listeners, events };
}

describe('remote context menu observation', () => {
  it('leaves unrelated surface messages unhandled without injecting input', () => {
    const f = fixture();

    expect(f.menu.handle(f.viewer, request, 'pointer')).toBe(false);
    expect(f.replies).toEqual([]);
    expect(f.calls).toEqual([]);
  });

  it.each([NaN, Infinity, -Infinity, -1])('rejects an invalid x coordinate before injecting input: %s', async (x) => {
    const f = fixture();

    expect(f.menu.handle(f.viewer, { ...request, x }, 'contextMenu')).toBe(true);
    await expect.poll(() => f.replies).toEqual([{ type: 'contextMenuResult', tabId: request.tabId,
      attachmentRequestId: request.attachmentRequestId, requestId: request.requestId, status: 'unavailable' }]);
    expect(f.calls).toEqual([]);
  });

  it('offers a menu only after an observed trusted right click and releases the page observer', async () => {
    const f = fixture();
    expect(f.send()).toBe(true);
    await expect.poll(() => f.replies).toEqual([{ type: 'contextMenuResult', tabId: request.tabId,
      attachmentRequestId: request.attachmentRequestId, requestId: request.requestId, status: 'menu' }]);
    expect(f.calls.filter((call) => call.method === 'Input.dispatchMouseEvent').map((call) => call.params)).toEqual([
      { type: 'mousePressed', x: 12.5, y: 34.5, button: 'right', clickCount: 1 },
      { type: 'mouseReleased', x: 12.5, y: 34.5, button: 'right', clickCount: 1 },
    ]);
    expect(f.calls.find((call) => call.method === 'DOM.getNodeForLocation').params).toMatchObject({ x: 112, y: 234 });
    await expect.poll(() => f.listeners.size).toBe(0);
    expect(f.calls.some((call) => call.method === 'Runtime.releaseObjectGroup')).toBe(true);
    expect(f.calls.filter((call) => call.method === 'Runtime.releaseObjectGroup')).toHaveLength(1);
  });

  it('still delivers the right click when observing the owning frame is unavailable', async () => {
    const f = fixture();
    f.control.hook = async (method) => { if (method === 'DOM.resolveNode') throw new Error('Inaccessible frame'); };
    f.send();
    await expect.poll(() => f.replies[0]?.status).toBe('unavailable');
    expect(f.calls.filter((call) => call.method === 'Input.dispatchMouseEvent').map((call) => call.params.type))
      .toEqual(['mousePressed', 'mouseReleased']);
  });

  it('reads cancellation on the original event after bubbling completes', async () => {
    const f = fixture();
    f.control.canceled = true;
    f.send();
    await expect.poll(() => f.replies[0]?.status).toBe('page-handled');
  });

  it.each(['observe', 'trusted'])('does not infer a menu from successful input when %s is false', async (field) => {
    const f = fixture();
    f.control[field] = false;
    f.send();
    await expect.poll(() => f.replies[0]?.status).toBe('unavailable');
    expect(f.calls.filter((call) => call.method === 'Input.dispatchMouseEvent')).toHaveLength(2);
  });

  it.each(['attachment', 'control', 'navigation', 'disconnect'])('cleans up and discards the reply after %s changes', async (change) => {
    const f = fixture();
    let release;
    const blocked = new Promise((resolve) => { release = resolve; });
    f.control.hook = async (method, params) => {
      if (method === 'Input.dispatchMouseEvent' && params.type === 'mousePressed') await blocked;
    };
    f.send();
    await expect.poll(() => f.calls.some((call) => call.method === 'Input.dispatchMouseEvent')).toBe(true);
    if (change === 'attachment') f.viewer.attachmentGeneration += 1;
    if (change === 'control') f.control.current = false;
    if (change === 'navigation') for (const listener of f.events) listener({ sessionId: 'cdp', method: 'Page.frameNavigated' });
    if (change === 'disconnect') { f.viewer.socket.readyState = 3; f.menu.detach(f.viewer); }
    release();
    await expect.poll(() => f.calls.some((call) => call.method === 'Runtime.releaseObjectGroup')).toBe(true);
    expect(f.listeners.size).toBe(0);
    expect(f.replies).toEqual([]);
    expect(f.calls.filter((call) => call.method === 'Input.dispatchMouseEvent').map((call) => call.params.type))
      .toEqual(['mousePressed']);
  });

  it('removes a late observer after the request deadline without sending delayed input', async () => {
    vi.useFakeTimers();
    const f = fixture();
    let release;
    const blocked = new Promise((resolve) => { release = resolve; });
    f.control.hook = async (method, params) => {
      if (method === 'Runtime.callFunctionOn' && params.objectId === 'node') await blocked;
    };
    f.send();
    await vi.advanceTimersByTimeAsync(5_000);
    expect(f.replies.map((reply) => reply.status)).toEqual(['unavailable']);
    release();
    await vi.advanceTimersByTimeAsync(0);
    expect(f.listeners.size).toBe(0);
    expect(f.calls.filter((call) => call.method === 'Input.dispatchMouseEvent')).toEqual([]);
    expect(f.calls.filter((call) => call.method === 'Runtime.releaseObjectGroup')).toHaveLength(2);
  });

  it('attempts the matching release once when a pressed-input command fails', async () => {
    const f = fixture();
    f.control.hook = async (method, params) => {
      if (method === 'Input.dispatchMouseEvent' && params.type === 'mousePressed') throw new Error('Input failed');
    };
    f.send();
    await expect.poll(() => f.replies[0]?.status).toBe('unavailable');
    expect(f.calls.filter((call) => call.method === 'Input.dispatchMouseEvent').map((call) => call.params.type))
      .toEqual(['mousePressed', 'mouseReleased']);
    expect(f.listeners.size).toBe(0);
  });

  it('keeps the target busy until canceled work settles without blocking a different tab', async () => {
    const f = fixture();
    let release;
    const blocked = new Promise((resolve) => { release = resolve; });
    let first = true;
    f.control.hook = async (method) => {
      if (method === 'Page.getLayoutMetrics' && first) { first = false; await blocked; }
    };
    f.send();
    await expect.poll(() => f.calls.some((call) => call.method === 'Page.getLayoutMetrics')).toBe(true);
    f.menu.detach(f.viewer);
    f.menu.handle(f.viewer, { ...request, requestId: 'busy' }, 'contextMenu');
    const second = { ...f.viewer, tabId: 'sc:second' };
    f.menu.handle(second, { ...request, tabId: second.tabId, requestId: 'other-tab' }, 'contextMenu');
    await expect.poll(() => f.replies.map((reply) => [reply.requestId, reply.status]))
      .toEqual([['busy', 'unavailable'], ['other-tab', 'menu']]);
    release();
    await expect.poll(() => f.calls.filter((call) => call.method === 'Runtime.releaseObjectGroup').length).toBe(3);
    expect(f.calls.filter((call) => call.method === 'Input.dispatchMouseEvent')).toHaveLength(2);
  });
});
