import { afterEach, describe, expect, it, vi } from 'vitest';
import { createSurfaceViewport } from './surface-viewport.js';
import { surfaceViewportMessageSchema } from '../../../../ui/src/lib/browser/remoteSurfaceViewportProtocol.ts';

const settle = async () => { for (let index = 0; index < 32; index += 1) await Promise.resolve(); };
const contexts = new Set();

const setup = ({ onApplied } = {}) => {
  const commands = [];
  const hooks = new Map();
  const controlListeners = new Set();
  const lifecycleListeners = new Set();
  const sizes = new Map();
  let generation = 0;
  let lease = null;
  let takeovers = 0;
  const cdp = {
    getSessionId: (targetId) => `cdp-${targetId}`,
    attach: async (targetId) => `cdp-${targetId}`,
    sendSession: async (sessionId, method, params = {}) => {
      commands.push({ sessionId, method, params });
      if (hooks.has(method)) return hooks.get(method)(params);
      if (method === 'Emulation.setDeviceMetricsOverride') sizes.set(sessionId, params);
      if (method === 'Emulation.clearDeviceMetricsOverride') sizes.delete(sessionId);
      if (method === 'Page.getLayoutMetrics') {
        const size = sizes.get(sessionId) ?? { width: 800, height: 600, mobile: false };
        const layoutWidth = size.mobile ? 980 : size.width;
        return { cssLayoutViewport: { clientWidth: layoutWidth, clientHeight: size.height },
          cssVisualViewport: { clientWidth: layoutWidth, clientHeight: size.height, scale: 1 } };
      }
      return {};
    },
  };
  const manager = {
    getSession: () => ({ id: 'session-1' }),
    getLease: () => lease,
    getControlState: () => ({ generation, lease }),
    viewerTakeover: (_sessionId, viewerId) => {
      takeovers += 1;
      generation += 1;
      lease = { actor: 'user', viewerId, generation };
      for (const listener of controlListeners) listener({ sessionId: 'session-1', generation, lease });
      return lease;
    },
    runReadOnlyOperation: async (_sessionId, options) => {
      if (!options.requireTargetOwnership) throw new Error('Target ownership is required');
      return options.operation({ cdp });
    },
    onControlChange: (listener) => { controlListeners.add(listener); return () => controlListeners.delete(listener); },
    onLifecycle: (listener) => { lifecycleListeners.add(listener); return () => lifecycleListeners.delete(listener); },
  };
  const controller = createSurfaceViewport({ browserSessionManager: manager,
    parseString: (value) => String.prototype.valueOf.call(value),
    sendJson: (socket, message) => { surfaceViewportMessageSchema.parse(message); socket.messages.push(message); return true; },
    onApplied });
  const viewer = { id: 'viewer-1', attached: true, tabId: 'sc:page-1', attachmentGeneration: 1,
    attachmentRequestId: 'attachment-1', surfaceSession: { sessionId: 'session-1', closed: false },
    socket: { readyState: 1, messages: [] } };
  const send = (payload = {}) => controller.handle(viewer, { type: 'viewportSet', requestId: 'resize-1',
    tabId: viewer.tabId, attachmentRequestId: viewer.attachmentRequestId, width: 640, height: 480,
    mode: 'auto', mobile: false, takeover: false, ...payload }, 'viewportSet');
  const open = async () => { controller.attach(viewer); await settle(); };
  const dispose = () => {
    controller.dispose();
    for (const listener of lifecycleListeners) listener({ type: 'ended', sessionId: 'session-1' });
  };
  const context = { controller, viewer, commands, hooks, manager, send, open, dispose, takeovers: () => takeovers };
  contexts.add(context);
  return context;
};

afterEach(() => {
  for (const context of contexts) context.dispose();
  contexts.clear();
  vi.useRealTimers();
});

describe('surface viewport boundary', () => {
  it('confirms the configured and observed viewport through the production client schema', async () => {
    const ctx = setup();
    await ctx.open();
    expect(ctx.viewer.socket.messages.at(-1)).toMatchObject({ type: 'viewportState',
      tabId: 'sc:page-1', attachmentRequestId: 'attachment-1', viewport: { autoAllowed: true } });
    ctx.send();
    await settle();
    expect(ctx.viewer.socket.messages.findLast((message) => message.type === 'viewportResult')).toMatchObject({
      requestId: 'resize-1', attachmentRequestId: 'attachment-1', status: 'applied',
      viewport: { width: 640, height: 480, mode: 'auto', source: 'viewer', mobile: false, deviceScaleFactor: 1,
        observed: { layoutWidth: 640, layoutHeight: 480 } },
    });
    expect(ctx.takeovers()).toBe(0);
  });

  it('reports only a current applied viewer viewport to its owner', async () => {
    const applied = [];
    const ctx = setup({ onApplied: (viewer, viewport) => applied.push({ viewer, viewport }) });
    await ctx.open();
    ctx.send();
    await settle();
    expect(applied).toEqual([{ viewer: ctx.viewer, viewport: expect.objectContaining({
      width: 640, height: 480, mobile: false,
    }) }]);

    ctx.send({ requestId: 'resize-unchanged' });
    await settle();
    expect(ctx.viewer.socket.messages.findLast((message) => message.type === 'viewportResult')).toMatchObject({
      requestId: 'resize-unchanged', status: 'unchanged',
    });
    expect(applied).toHaveLength(1);
  });

  it('keeps configured device width distinct from mobile CSS layout width', async () => {
    const ctx = setup();
    await ctx.open();
    ctx.send({ width: 390, height: 844, mode: 'fixed', mobile: true, takeover: true });
    await settle();
    expect(ctx.viewer.socket.messages.findLast((message) => message.type === 'viewportResult')).toMatchObject({
      viewport: { width: 390, height: 844, mobile: true, observed: { layoutWidth: 980 } },
    });
    expect(ctx.takeovers()).toBe(1);
  });

  it.each([
    { width: 0 }, { width: 3841 }, { height: 12.5 }, { mobile: 'yes' }, { takeover: 1 }, { mode: 'mobile' },
  ])('rejects malformed viewport settings before applying or taking control', async (invalid) => {
    const ctx = setup();
    await ctx.open();
    ctx.send(invalid);
    expect(ctx.viewer.socket.messages.at(-1)).toMatchObject({ type: 'viewportError', code: 'INVALID_REQUEST' });
    expect(ctx.takeovers()).toBe(0);
    expect(ctx.commands.some((command) => command.method.startsWith('Emulation.'))).toBe(false);
  });

  it.each([{ tabId: 'sc:other' }, { attachmentRequestId: 'old-attachment' }])('rejects a stale attachment identity', async (identity) => {
    const ctx = setup();
    await ctx.open();
    ctx.send(identity);
    expect(ctx.viewer.socket.messages.at(-1)).toMatchObject({ type: 'viewportError', code: 'STALE_ATTACHMENT' });
    expect(ctx.takeovers()).toBe(0);
  });

  it('drops the reply after the requesting tab detaches during a resize', async () => {
    const ctx = setup();
    await ctx.open();
    let finishWrite;
    ctx.hooks.set('Emulation.setDeviceMetricsOverride', () => new Promise((resolve) => { finishWrite = resolve; }));
    ctx.send();
    await settle();
    ctx.controller.detach(ctx.viewer);
    ctx.viewer.attachmentGeneration += 1;
    ctx.viewer.attachmentRequestId = 'attachment-2';
    finishWrite({});
    await settle();
    expect(ctx.viewer.socket.messages.some((message) => message.type === 'viewportResult')).toBe(false);
  });

  it('reports a failed metrics read without publishing an empty viewport', async () => {
    const ctx = setup();
    ctx.hooks.set('Page.getLayoutMetrics', async () => { throw new Error('private CDP details'); });
    await ctx.open();
    ctx.send();
    await settle();
    expect(ctx.viewer.socket.messages).toEqual([expect.objectContaining({ type: 'viewportError', code: 'RESIZE_FAILED' })]);
    expect(JSON.stringify(ctx.viewer.socket.messages)).not.toContain('private');
  });

  it('keeps the DevTools bridge promise pending until its physical write completes', async () => {
    const ctx = setup();
    await ctx.open();
    const change = { sessionId: 'session-1', tabId: ctx.viewer.tabId, devtoolsId: 'devtools-1' };
    await ctx.controller.external(ctx.viewer, { ...change, type: 'open' });
    const rawWrite = Promise.withResolvers();
    let started = false;
    let finished = false;
    const operation = ctx.controller.external(ctx.viewer, { ...change, type: 'changed', apply: async () => {
      started = true;
      await rawWrite.promise;
    } }).then(() => { finished = true; });
    await settle();
    expect(started).toBe(true);
    expect(finished).toBe(false);
    rawWrite.resolve();
    await operation;
    expect(finished).toBe(true);
    expect(ctx.viewer.socket.messages.at(-1)).toMatchObject({ type: 'viewportState',
      viewport: { source: 'external', mode: 'external', autoAllowed: false } });
  });
});
