import { afterEach, describe, expect, it, vi } from 'vitest';
import { BrowserViewportError, getBrowserViewportManager } from './viewport.js';

const metrics = (width = 1200, height = 800, scale = 1) => ({
  cssLayoutViewport: { clientWidth: width, clientHeight: height },
  cssVisualViewport: { clientWidth: width, clientHeight: height, scale },
});

const flush = async () => {
  for (let turn = 0; turn < 20; turn += 1) await Promise.resolve();
};

const harness = () => {
  const controlListeners = new Set();
  const lifecycleListeners = new Set();
  const calls = [];
  let currentMetrics = metrics();
  let control = { generation: 0, lease: null };
  let readGate = null;
  let writeGate = null;
  let connectionGate = null;
  const cdp = {
    getSessionId: () => 'cdp-page',
    async attach() { return 'cdp-page'; },
    async sendSession(sessionId, method, params) {
      calls.push({ sessionId, method, params });
      if (method === 'Page.getLayoutMetrics') {
        const captured = currentMetrics;
        if (readGate) {
          const gate = readGate;
          readGate = null;
          return gate.promise;
        }
        return captured;
      }
      if (writeGate) {
        const gate = writeGate;
        writeGate = null;
        await gate.promise;
      }
      currentMetrics = method === 'Emulation.clearDeviceMetricsOverride' ? metrics() : metrics(params.width, params.height);
      return {};
    },
  };
  const changeControl = (lease) => {
    control = { generation: control.generation + 1, lease };
    for (const listener of controlListeners) listener({ sessionId: 'session', ...control });
  };
  const manager = {
    takeoverCount: 0,
    getControlState: () => ({ ...control }),
    viewerTakeover(sessionId, viewerId) {
      this.takeoverCount += 1;
      changeControl(null);
      changeControl({ actor: 'user', viewerId });
    },
    async runReadOnlyOperation(sessionId, options) {
      expect(sessionId).toBe('session');
      expect(options.targetId).toBe('target');
      expect(options.requireTargetOwnership).toBe(true);
      expect(options.abortSignal).toBeUndefined();
      if (connectionGate) {
        const gate = connectionGate;
        connectionGate = null;
        await gate.promise;
      }
      return options.operation({ cdp });
    },
    onControlChange(listener) { controlListeners.add(listener); return () => controlListeners.delete(listener); },
    onLifecycle(listener) { lifecycleListeners.add(listener); return () => lifecycleListeners.delete(listener); },
  };
  const viewport = getBrowserViewportManager(manager);
  return {
    viewport, manager, cdp, calls, changeControl,
    read: (viewerId = 'viewer') => viewport.read('session', 'target', viewerId),
    snapshot: (viewerId = 'viewer') => viewport.snapshot('session', 'target', viewerId),
    resize: (options = {}) => viewport.setViewer({
      sessionId: 'session', targetId: 'target', viewerId: 'viewer', width: 800, height: 600,
      mode: 'auto', mobile: false, isCurrent: () => true, ...options,
    }),
    agent: (value = { width: 390, height: 844, mobile: true }, signal) => viewport.applyAgent({
      sessionId: 'session', targetId: 'target', cdp, cdpSessionId: 'cdp-page', viewport: value, signal,
    }),
    external: (type, options = {}) => viewport.external({
      sessionId: 'session', targetId: 'target', viewerId: 'viewer', devtoolsId: 'tools', type, ...options,
    }),
    setMetrics(value) { currentMetrics = value; },
    gateRead() { readGate = Promise.withResolvers(); return readGate; },
    gateWrite() { writeGate = Promise.withResolvers(); return writeGate; },
    gateConnection() { connectionGate = Promise.withResolvers(); return connectionGate; },
    end() { for (const listener of lifecycleListeners) listener({ type: 'ended', sessionId: 'session' }); },
  };
};

afterEach(() => vi.useRealTimers());

describe('browser viewport snapshots', () => {
  it('shares one coordinator and reads authoritative CSS once without inventing an emulation config', async () => {
    const h = harness();
    expect(getBrowserViewportManager(h.manager)).toBe(h.viewport);
    expect(h.snapshot()).toBeNull();
    h.setMetrics(metrics(4100.5, 900.25, 1.5));
    const snapshot = await h.read();
    expect(snapshot).toMatchObject({
      width: 4100.5, height: 900.25, mode: 'external', source: 'external', mobile: null,
      deviceScaleFactor: null, autoAllowed: true,
      observed: { layoutWidth: 4100.5, layoutHeight: 900.25, visualScale: 1.5 },
    });
    snapshot.observed.layoutWidth = 1;
    expect((await h.read()).observed.layoutWidth).toBe(4100.5);
    expect(h.calls).toHaveLength(1);
  });

  it('coalesces observations and publishes only when the confirmed metrics change', async () => {
    const h = harness();
    await h.read();
    const changes = [];
    const unsubscribe = h.viewport.onChange((event) => changes.push(event));
    const gate = h.gateRead();
    const first = h.viewport.observe('session', 'target');
    const second = h.viewport.observe('session', 'target');
    expect(first).toBe(second);
    gate.resolve(metrics());
    await first;
    expect(changes).toEqual([]);
    h.setMetrics(metrics(1300, 700));
    await h.viewport.observe('session', 'target');
    expect(changes).toEqual([{ sessionId: 'session', targetId: 'target' }]);
    unsubscribe();
  });

  it('keeps configured mobile dimensions when navigation changes the layout viewport', async () => {
    const h = harness();
    await h.resize({ width: 390, height: 844, mobile: true, mode: 'fixed', takeover: true });
    h.setMetrics(metrics(980, 2120, 0.398));
    await h.viewport.observe('session', 'target');
    expect(h.snapshot()).toMatchObject({
      width: 390, height: 844, mobile: true, mode: 'fixed', source: 'viewer',
      observed: { layoutWidth: 980, layoutHeight: 2120, visualScale: 0.398 },
    });
  });

  it('does not let an older observation overwrite a newly confirmed resize', async () => {
    const h = harness();
    await h.read();
    const gate = h.gateRead();
    const observation = h.viewport.observe('session', 'target');
    await flush();
    await h.resize({ width: 900 });
    gate.resolve(metrics(700, 500));
    await observation;
    expect(h.snapshot()).toMatchObject({ width: 900, observed: { layoutWidth: 900 }, source: 'viewer' });
  });

  it('reports read failures without committing fake metrics', async () => {
    const h = harness();
    h.setMetrics({});
    await expect(h.read()).rejects.toMatchObject({ code: 'RESIZE_FAILED' });
    expect(h.snapshot()).toBeNull();
  });
});

describe('viewer viewport control', () => {
  it('admits the first Auto owner without taking control and rejects a foreign passive viewer', async () => {
    const h = harness();
    expect((await h.resize()).status).toBe('applied');
    expect(h.manager.takeoverCount).toBe(0);
    expect(h.snapshot().autoAllowed).toBe(true);
    expect(h.snapshot('other').autoAllowed).toBe(false);
    expect((await h.resize({ viewerId: 'other', width: 900 })).status).toBe('not-owner');
    expect((await h.resize()).status).toBe('unchanged');
    expect(h.calls.filter((call) => call.method === 'Emulation.setDeviceMetricsOverride')).toHaveLength(1);
  });

  it('denies passive Auto under agent or foreign user control and publishes control changes', async () => {
    const h = harness();
    await h.read();
    const initialRevision = h.snapshot().revision;
    for (const lease of [{ actor: 'agent' }, { actor: 'user', viewerId: 'other' }]) {
      h.changeControl(lease);
      expect((await h.resize()).status).toBe('not-owner');
      expect(h.snapshot().autoAllowed).toBe(false);
    }
    expect(h.snapshot().revision).toBeGreaterThan(initialRevision);
    expect(h.manager.takeoverCount).toBe(0);
  });

  it('takes control at admission before a slow connection and tolerates its own control callbacks', async () => {
    const h = harness();
    const connection = h.gateConnection();
    const resize = h.resize({ takeover: true });
    expect(h.manager.takeoverCount).toBe(1);
    expect(h.calls).toEqual([]);
    connection.resolve();
    await expect(resize).resolves.toMatchObject({ status: 'applied' });
  });

  it('checks attachment identity before takeover, after connection waits, and after the physical write', async () => {
    const stale = harness();
    await expect(stale.resize({ takeover: true, isCurrent: () => false })).rejects.toMatchObject({ code: 'STALE_ATTACHMENT' });
    expect(stale.manager.takeoverCount).toBe(0);

    const connecting = harness();
    let current = true;
    const connection = connecting.gateConnection();
    const request = connecting.resize({ isCurrent: () => current });
    current = false;
    connection.resolve();
    await expect(request).rejects.toMatchObject({ code: 'STALE_ATTACHMENT' });
    expect(connecting.calls).toEqual([]);

    const writing = harness();
    await writing.read();
    current = true;
    const write = writing.gateWrite();
    const late = writing.resize({ isCurrent: () => current });
    await flush();
    current = false;
    write.resolve();
    await expect(late).rejects.toMatchObject({ code: 'STALE_ATTACHMENT' });
    expect(writing.snapshot()).toMatchObject({ width: 1200, source: 'external' });
  });

  it('keeps only the latest pending resize while one physical write runs', async () => {
    const h = harness();
    const gate = h.gateWrite();
    const first = h.resize({ width: 700 });
    await flush();
    const middle = h.resize({ width: 800 });
    const middleResult = expect(middle).rejects.toMatchObject({ code: 'SUPERSEDED' });
    const last = h.resize({ width: 900 });
    await middleResult;
    expect(h.calls).toHaveLength(1);
    gate.resolve();
    await expect(first).resolves.toMatchObject({ status: 'applied' });
    await expect(last).resolves.toMatchObject({ status: 'applied', viewport: { width: 900 } });
    expect(h.calls.filter((call) => call.method === 'Emulation.setDeviceMetricsOverride').map((call) => call.params.width)).toEqual([700, 900]);
  });

  it('rejects failures without committing requested dimensions', async () => {
    const h = harness();
    await h.resize();
    const gate = h.gateWrite();
    const failed = h.resize({ width: 1000 });
    gate.reject(new Error('CDP failed'));
    await expect(failed).rejects.toMatchObject({ code: 'RESIZE_FAILED' });
    expect(h.snapshot()).toMatchObject({ width: 800, source: 'viewer' });
  });

  it('restores the confirmed configuration after a successful write with failed confirmation', async () => {
    const h = harness();
    await h.resize();
    const gate = h.gateRead();
    const failed = h.resize({ width: 1000 });
    await flush();
    gate.reject(new Error('Metrics failed after set'));
    await expect(failed).rejects.toMatchObject({ code: 'RESIZE_FAILED' });
    await expect(h.resize()).resolves.toMatchObject({ status: 'applied', viewport: { width: 800 } });
    expect(h.calls.filter((call) => call.method === 'Emulation.setDeviceMetricsOverride').map((call) => call.params.width)).toEqual([800, 1000, 800]);
  });

  it('retains the active Auto reservation when a newer pending resize is aborted', async () => {
    const h = harness();
    const gate = h.gateWrite();
    const first = h.resize();
    await flush();
    const controller = new AbortController();
    const pending = h.resize({ width: 900, signal: controller.signal });
    controller.abort();
    await expect(pending).rejects.toMatchObject({ code: 'STALE_ATTACHMENT' });
    const foreign = h.resize({ viewerId: 'other', width: 1000 });
    gate.resolve();
    await first;
    await expect(foreign).resolves.toMatchObject({ status: 'not-owner' });
    expect(h.snapshot('other').autoAllowed).toBe(false);
    expect(h.calls.filter((call) => call.method === 'Emulation.setDeviceMetricsOverride')).toHaveLength(1);
  });

  it('rejects invalid managed dimensions before takeover or Chrome access', async () => {
    const h = harness();
    for (const width of [0, 3841, 1.5, Infinity, '800']) {
      await expect(h.resize({ width, takeover: true })).rejects.toBeInstanceOf(BrowserViewportError);
    }
    expect(h.manager.takeoverCount).toBe(0);
    expect(h.calls).toEqual([]);
  });
});

describe('physical resize lifetime', () => {
  it('holds the writer after its deadline and starts the next writer only after raw completion', async () => {
    vi.useFakeTimers();
    const h = harness();
    await h.read();
    const gate = h.gateWrite();
    const first = h.resize({ width: 700 });
    const timedOut = expect(first).rejects.toMatchObject({ code: 'RESIZE_TIMEOUT' });
    await flush();
    await vi.advanceTimersByTimeAsync(5000);
    await timedOut;
    const second = h.resize({ width: 900 });
    await flush();
    expect(h.calls.filter((call) => call.method === 'Emulation.setDeviceMetricsOverride')).toHaveLength(1);
    expect(h.snapshot().width).toBe(1200);
    gate.resolve();
    await expect(second).resolves.toMatchObject({ viewport: { width: 900 } });
    expect(h.snapshot().width).toBe(900);
  });

  it('counts queue wait against the deadline and never sends an expired pending request', async () => {
    vi.useFakeTimers();
    const h = harness();
    const gate = h.gateWrite();
    const first = h.resize({ width: 700 });
    const expiredFirst = expect(first).rejects.toMatchObject({ code: 'RESIZE_TIMEOUT' });
    await flush();
    const second = h.resize({ width: 900 });
    const expiredSecond = expect(second).rejects.toMatchObject({ code: 'RESIZE_TIMEOUT' });
    await vi.advanceTimersByTimeAsync(5000);
    await Promise.all([expiredFirst, expiredSecond]);
    gate.resolve();
    await flush();
    expect(h.calls.filter((call) => call.method === 'Emulation.setDeviceMetricsOverride')).toHaveLength(1);
  });

  it('uses the same physical queue for agents and viewers', async () => {
    const h = harness();
    const gate = h.gateWrite();
    const viewer = h.resize();
    const superseded = expect(viewer).rejects.toMatchObject({ code: 'SUPERSEDED' });
    await flush();
    h.changeControl({ actor: 'agent' });
    const agent = h.agent();
    await flush();
    expect(h.calls).toHaveLength(1);
    gate.resolve();
    await superseded;
    await expect(agent).resolves.toMatchObject({ width: 390, source: 'agent', mode: 'fixed', mobile: true });
  });

  it('does not send a confirmation read after an aborted raw write completes', async () => {
    const h = harness();
    h.changeControl({ actor: 'agent' });
    const gate = h.gateWrite();
    const controller = new AbortController();
    const request = h.agent(undefined, controller.signal);
    await flush();
    controller.abort();
    await expect(request).rejects.toMatchObject({ code: 'STALE_ATTACHMENT' });
    const viewer = h.resize({ takeover: true, width: 900 });
    await flush();
    expect(h.calls).toHaveLength(1);
    gate.resolve();
    await expect(viewer).resolves.toMatchObject({ viewport: { width: 900 } });
    expect(h.calls.map((call) => call.method)).toEqual([
      'Emulation.setDeviceMetricsOverride',
      'Emulation.setDeviceMetricsOverride',
      'Page.getLayoutMetrics',
    ]);
  });

  it('cancels detached viewers without resurrecting ownership when their write completes', async () => {
    const h = harness();
    await h.resize();
    const gate = h.gateWrite();
    const request = h.resize({ width: 900 });
    await flush();
    h.viewport.detachViewer('session', 'viewer', 'target');
    await expect(request).rejects.toMatchObject({ code: 'STALE_ATTACHMENT' });
    gate.resolve();
    await flush();
    expect(h.snapshot('other')).toMatchObject({ width: 800, autoAllowed: true });
  });

  it.each(['target', 'session'])('drops %s state without accepting a late write', async (kind) => {
    const h = harness();
    const gate = h.gateWrite();
    const request = h.resize();
    await flush();
    if (kind === 'target') h.viewport.dropTarget('session', 'target');
    else h.end();
    await expect(request).rejects.toMatchObject({ code: 'STALE_ATTACHMENT' });
    gate.resolve();
    await flush();
    expect(h.snapshot()).toBeNull();
  });
});

describe('agent and DevTools viewport authority', () => {
  it.each([null, { width: 390, height: 844, mobile: true }])('keeps agent authority after lease expiry for %j', async (value) => {
    const h = harness();
    h.changeControl({ actor: 'agent' });
    await h.agent(value);
    h.changeControl(null);
    expect((await h.resize()).status).toBe('not-owner');
    await expect(h.resize({ takeover: true })).resolves.toMatchObject({ status: 'applied', viewport: { mode: 'auto', source: 'viewer' } });
  });

  it('does not pause Auto merely because the same viewer opens DevTools', async () => {
    const h = harness();
    await h.resize();
    h.changeControl({ actor: 'user', viewerId: 'viewer' });
    const before = h.snapshot();
    await h.external('open');
    expect(h.snapshot()).toEqual(before);
    await expect(h.resize({ width: 900 })).resolves.toMatchObject({ status: 'applied' });
  });

  it('marks actual DevTools changes immediately even if its read fails or still returns old metrics', async () => {
    const h = harness();
    await h.resize();
    await h.external('open');
    const gate = h.gateRead();
    const changed = h.external('changed');
    expect(h.snapshot()).toMatchObject({ source: 'external', mode: 'external', mobile: null, autoAllowed: false });
    gate.reject(new Error('Chrome unavailable'));
    await expect(changed).rejects.toMatchObject({ code: 'RESIZE_FAILED' });
    expect((await h.resize({ width: 900 })).status).toBe('not-owner');
    await h.external('changed');
    expect(h.snapshot().autoAllowed).toBe(false);
  });

  it('allows explicit Auto with DevTools open and recognizes the next change from that same connection', async () => {
    const h = harness();
    await h.resize();
    await h.external('open');
    await h.external('changed');
    await h.resize({ takeover: true, width: 900 });
    expect(h.snapshot()).toMatchObject({ autoAllowed: true, source: 'viewer', mode: 'auto' });
    await h.external('changed');
    expect(h.snapshot().autoAllowed).toBe(false);
    await h.resize({ takeover: true, width: 1000 });
    const beforeClose = h.snapshot();
    await h.external('close');
    expect(h.snapshot()).toEqual(beforeClose);
    await h.external('changed');
    expect(h.snapshot()).toEqual(beforeClose);
  });

  it('serializes a raw DevTools override between an older Auto write and a newer explicit selection', async () => {
    const h = harness();
    const write = h.gateWrite();
    const first = h.resize();
    await flush();
    await h.external('open');
    const ack = Promise.withResolvers();
    let sent = false;
    const external = h.external('changed', {
      apply: async () => {
        sent = true;
        await ack.promise;
        h.setMetrics(metrics(390, 844));
      },
    });
    await expect(first).rejects.toMatchObject({ code: 'SUPERSEDED' });
    await flush();
    expect(sent).toBe(false);
    write.resolve();
    await flush();
    expect(sent).toBe(true);
    const newer = h.resize({ width: 900, takeover: true });
    await flush();
    expect(h.calls.filter((call) => call.method === 'Emulation.setDeviceMetricsOverride')).toHaveLength(1);
    const superseded = expect(external).rejects.toMatchObject({ code: 'SUPERSEDED' });
    ack.resolve();
    await superseded;
    await expect(newer).resolves.toMatchObject({ viewport: { width: 900, mode: 'auto' } });
    expect(h.calls.map((call) => call.method)).toEqual([
      'Emulation.setDeviceMetricsOverride', 'Emulation.setDeviceMetricsOverride', 'Page.getLayoutMetrics',
    ]);
  });

  it('confirms DevTools metrics only after its physical response and retains external authority', async () => {
    const h = harness();
    await h.resize();
    await h.external('open');
    const ack = Promise.withResolvers();
    const external = h.external('changed', {
      apply: async () => { await ack.promise; h.setMetrics(metrics(390, 844)); },
    });
    await flush();
    expect(h.snapshot()).toMatchObject({ source: 'external', autoAllowed: false, width: 800 });
    expect(h.calls.filter((call) => call.method === 'Page.getLayoutMetrics')).toHaveLength(1);
    ack.resolve();
    await expect(external).resolves.toMatchObject({ source: 'external', width: 390, height: 844, mobile: null });
    expect((await h.resize()).status).toBe('not-owner');
  });

  it('keeps a timed-out DevTools physical operation locked until its raw response arrives', async () => {
    vi.useFakeTimers();
    const h = harness();
    await h.resize();
    await h.external('open');
    const ack = Promise.withResolvers();
    const external = h.external('changed', { apply: () => ack.promise });
    const timeout = expect(external).rejects.toMatchObject({ code: 'RESIZE_TIMEOUT' });
    await flush();
    await vi.advanceTimersByTimeAsync(5000);
    await timeout;
    const newer = h.resize({ takeover: true, width: 900 });
    await flush();
    expect(h.calls.filter((call) => call.method === 'Emulation.setDeviceMetricsOverride')).toHaveLength(1);
    ack.resolve();
    await expect(newer).resolves.toMatchObject({ viewport: { width: 900 } });
  });

  it('ignores unknown DevTools connections and preserves fixed configuration on viewer detach', async () => {
    const h = harness();
    await h.resize({ mode: 'fixed', takeover: true });
    await h.external('open');
    await h.external('changed', { devtoolsId: 'stale' });
    await h.external('close', { devtoolsId: 'stale' });
    h.viewport.detachViewer('session', 'viewer', 'target');
    h.changeControl(null);
    expect(h.snapshot('other')).toMatchObject({ mode: 'fixed', width: 800, autoAllowed: false });
  });
});
