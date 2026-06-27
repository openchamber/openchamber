import { afterEach, describe, expect, mock, test } from 'bun:test';
import { SseFanIn } from './sse-fan-in.js';

function createServerManager(overrides = {}) {
  const servers = [];
  const clients = {};
  const status = {};

  return {
    listServers: overrides.listServers || mock(() => servers.map((s) => ({
      id: s.id,
      status: status[s.id] || s.status || 'connecting',
    }))),
    getServer: overrides.getServer || mock((id) => {
      const s = servers.find((s) => s.id === id);
      if (s) return { id: s.id, client: clients[id] || null, status: status[id] || s.status || 'connecting' };
      if (status[id] !== undefined) return { id, client: clients[id] || null, status: status[id] };
      return null;
    }),
    getClient: overrides.getClient || mock((id) => clients[id] || null),
    updateStatus: overrides.updateStatus || mock((id, newStatus) => {
      status[id] = newStatus;
    }),
    _servers: servers,
    _clients: clients,
  };
}

function createMockSubscription() {
  const sub = { unsubscribe: mock() };
  return sub;
}

describe('SseFanIn', () => {
  let fanIn;
  let serverManager;

  afterEach(() => {
    if (fanIn && typeof fanIn._stopHeartbeat === 'function') {
      fanIn._stopHeartbeat();
    }
  });

  describe('subscribeServer', () => {
    test('emits server.status connecting then connected on subscribe + first event', () => {
      const sub = createMockSubscription();
      let eventHandler = null;
      serverManager = createServerManager({
        getServer: mock((id) => ({ id, client: { events: {} }, status: 'connecting' })),
        getClient: mock(() => ({
          events: { subscribe: mock((handler) => { eventHandler = handler; return sub; }) },
        })),
        updateStatus: mock(() => {}),
      });
      fanIn = new SseFanIn(serverManager);

      const events = [];
      fanIn.onEvent((batch) => events.push(...batch));

      fanIn.subscribeServer('s1');

      const statusEventsAfterSubscribe = events.filter((e) => e.type === 'server.status' && e.serverId === 's1');
      expect(statusEventsAfterSubscribe).toHaveLength(1);
      expect(statusEventsAfterSubscribe[0].status).toBe('connecting');

      eventHandler({ type: 'session.status', sessionID: 'abc', status: 'active' });

      const statusEventsAfterEvent = events.filter((e) => e.type === 'server.status' && e.serverId === 's1');
      expect(statusEventsAfterEvent).toHaveLength(2);
      expect(statusEventsAfterEvent[1].status).toBe('connected');
    });

    test('is idempotent — second call cleans up first subscription', () => {
      const sub1 = createMockSubscription();
      const sub2 = createMockSubscription();
      let subscribeCalls = 0;
      const subscribeFn = mock(() => {
        subscribeCalls++;
        return subscribeCalls === 1 ? sub1 : sub2;
      });

      serverManager = createServerManager({
        getClient: mock(() => ({
          events: { subscribe: subscribeFn },
        })),
        updateStatus: mock(() => {}),
      });
      fanIn = new SseFanIn(serverManager);

      fanIn.subscribeServer('s1');
      expect(sub1.unsubscribe).not.toHaveBeenCalled();

      fanIn.subscribeServer('s1');
      expect(sub1.unsubscribe).toHaveBeenCalledTimes(1);
      expect(fanIn.subscriptions.has('s1')).toBe(true);
    });

    test('no-ops when client is null', () => {
      serverManager = createServerManager({
        getClient: mock(() => null),
        updateStatus: mock(() => {}),
      });
      fanIn = new SseFanIn(serverManager);

      fanIn.subscribeServer('s1');
      expect(fanIn.subscriptions.has('s1')).toBe(false);
    });
  });

  describe('unsubscribeServer', () => {
    test('emits server.status synthetic event on unsubscribe', () => {
      const sub = createMockSubscription();
      serverManager = createServerManager({
        getClient: mock(() => ({
          events: { subscribe: mock(() => sub) },
        })),
        updateStatus: mock(() => {}),
      });
      fanIn = new SseFanIn(serverManager);
      fanIn.subscribeServer('s1');

      const events = [];
      fanIn.onEvent((batch) => events.push(...batch));

      fanIn.unsubscribeServer('s1');

      expect(sub.unsubscribe).toHaveBeenCalled();
      expect(serverManager.updateStatus).toHaveBeenCalledWith('s1', 'disconnected');

      const lastEvent = events[events.length - 1];
      expect(lastEvent.type).toBe('server.status');
      expect(lastEvent.status).toBe('disconnected');
    });

    test('is idempotent — second call no-ops', () => {
      const sub = createMockSubscription();
      serverManager = createServerManager({
        getClient: mock(() => ({
          events: { subscribe: mock(() => sub) },
        })),
        updateStatus: mock(() => {}),
      });
      fanIn = new SseFanIn(serverManager);
      fanIn.subscribeServer('s1');

      fanIn.unsubscribeServer('s1');
      expect(sub.unsubscribe).toHaveBeenCalledTimes(1);

      fanIn.unsubscribeServer('s1');
      expect(sub.unsubscribe).toHaveBeenCalledTimes(1);
    });

    test('no-ops when server was never subscribed', () => {
      serverManager = createServerManager({
        updateStatus: mock(() => {}),
      });
      fanIn = new SseFanIn(serverManager);

      expect(() => fanIn.unsubscribeServer('s1')).not.toThrow();
    });
  });

  describe('startAll', () => {
    test('subscribes connecting/connected servers', () => {
      const sub1 = createMockSubscription();
      const sub2 = createMockSubscription();
      let callIndex = 0;
      const subscribeFn = mock(() => {
        callIndex++;
        return callIndex === 1 ? sub1 : sub2;
      });

      serverManager = createServerManager({
        listServers: mock(() => [
          { id: 's1', status: 'connecting' },
          { id: 's2', status: 'connected' },
          { id: 's3', status: 'disconnected' },
          { id: 's4', status: 'error' },
        ]),
        getClient: mock((id) => (id === 's1' || id === 's2')
          ? { events: { subscribe: subscribeFn } }
          : null),
        updateStatus: mock(() => {}),
      });
      fanIn = new SseFanIn(serverManager);

      fanIn.startAll();

      expect(serverManager.getClient).toHaveBeenCalledWith('s1');
      expect(serverManager.getClient).toHaveBeenCalledWith('s2');
      expect(serverManager.getClient).not.toHaveBeenCalledWith('s3');
      expect(serverManager.getClient).not.toHaveBeenCalledWith('s4');
      expect(fanIn.subscriptions.size).toBe(2);
    });

    test('skips servers without a client', () => {
      serverManager = createServerManager({
        listServers: mock(() => [
          { id: 's1', status: 'connecting' },
          { id: 's2', status: 'connected' },
        ]),
        getClient: mock(() => null),
        updateStatus: mock(() => {}),
      });
      fanIn = new SseFanIn(serverManager);

      fanIn.startAll();
      expect(fanIn.subscriptions.size).toBe(0);
    });

    test('handles subscribeServer errors gracefully', () => {
      serverManager = createServerManager({
        listServers: mock(() => [
          { id: 's1', status: 'connecting' },
        ]),
        getClient: mock(() => ({
          events: {
            subscribe: mock(() => { throw new Error('subscribe failed'); }),
          },
        })),
        updateStatus: mock(() => {}),
      });
      fanIn = new SseFanIn(serverManager);
      expect(() => fanIn.startAll()).not.toThrow();
      expect(fanIn.subscriptions.size).toBe(0);
    });
  });

  describe('event coalescing', () => {
    test('same key overwrites in pending map', async () => {
      const sub = {
        unsubscribe: mock(),
      };
      let eventHandler = null;
      serverManager = createServerManager({
        getClient: mock(() => ({
          events: {
            subscribe: mock((handler) => {
              eventHandler = handler;
              return sub;
            }),
          },
        })),
        updateStatus: mock(() => {}),
      });
      fanIn = new SseFanIn(serverManager, { batchInterval: 1 });

      fanIn.subscribeServer('s1');

      const events = [];
      fanIn.onEvent((batch) => events.push(...batch));

      eventHandler({ type: 'session.status', sessionID: 'abc', status: 'active' });
      eventHandler({ type: 'session.status', sessionID: 'abc', status: 'idle' });

      await new Promise((r) => setTimeout(r, 20));

      const statusEvents = events.filter((e) => e.type === 'session.status' && e.sessionID === 'abc');
      expect(statusEvents).toHaveLength(1);
      expect(statusEvents[0].status).toBe('idle');
    });
  });

  describe('16ms batch', () => {
    test('multiple events merged into one dispatch', async () => {
      const sub = {
        unsubscribe: mock(),
      };
      let eventHandler = null;
      serverManager = createServerManager({
        getClient: mock(() => ({
          events: {
            subscribe: mock((handler) => {
              eventHandler = handler;
              return sub;
            }),
          },
        })),
        updateStatus: mock(() => {}),
      });
      fanIn = new SseFanIn(serverManager, { batchInterval: 1 });

      fanIn.subscribeServer('s1');

      const batches = [];
      fanIn.onEvent((batch) => batches.push(batch));

      eventHandler({ type: 'session.status', sessionID: 'a', status: 'active' });
      eventHandler({ type: 'session.status', sessionID: 'b', status: 'idle' });

      await new Promise((r) => setTimeout(r, 20));

      const sessionBatches = batches.filter((b) => b.some((e) => e.type === 'session.status'));
      expect(sessionBatches).toHaveLength(1);
      const sessionEvents = sessionBatches[0].filter((e) => e.type === 'session.status');
      expect(sessionEvents).toHaveLength(2);
    });
  });

  describe('dispatch', () => {
    test('events tagged with serverId', async () => {
      const sub = {
        unsubscribe: mock(),
      };
      let eventHandler = null;
      serverManager = createServerManager({
        getClient: mock(() => ({
          events: {
            subscribe: mock((handler) => {
              eventHandler = handler;
              return sub;
            }),
          },
        })),
        updateStatus: mock(() => {}),
      });
      fanIn = new SseFanIn(serverManager, { batchInterval: 1 });

      fanIn.subscribeServer('s1');

      const events = [];
      fanIn.onEvent((batch) => events.push(...batch));

      eventHandler({ type: 'session.status', sessionID: 'abc', status: 'active' });
      await new Promise((r) => setTimeout(r, 20));

      const sessionEvent = events.find((e) => e.type === 'session.status');
      expect(sessionEvent).toBeDefined();
      expect(sessionEvent.serverId).toBe('s1');
      expect(sessionEvent.type).toBe('session.status');
    });

    test('multiple listeners all receive events', async () => {
      const sub = {
        unsubscribe: mock(),
      };
      let eventHandler = null;
      serverManager = createServerManager({
        getClient: mock(() => ({
          events: {
            subscribe: mock((handler) => {
              eventHandler = handler;
              return sub;
            }),
          },
        })),
        updateStatus: mock(() => {}),
      });
      fanIn = new SseFanIn(serverManager, { batchInterval: 1 });

      fanIn.subscribeServer('s1');

      const events1 = [];
      const events2 = [];
      fanIn.onEvent((batch) => events1.push(...batch));
      fanIn.onEvent((batch) => events2.push(...batch));

      eventHandler({ type: 'session.status', sessionID: 'abc', status: 'active' });
      await new Promise((r) => setTimeout(r, 20));

      const sessionEvents1 = events1.filter((e) => e.type !== 'server.status');
      const sessionEvents2 = events2.filter((e) => e.type !== 'server.status');
      expect(sessionEvents1).toHaveLength(1);
      expect(sessionEvents2).toHaveLength(1);
    });

    test('onEvent returns unsubscribe function', async () => {
      const sub = {
        unsubscribe: mock(),
      };
      let eventHandler = null;
      serverManager = createServerManager({
        getClient: mock(() => ({
          events: {
            subscribe: mock((handler) => {
              eventHandler = handler;
              return sub;
            }),
          },
        })),
        updateStatus: mock(() => {}),
      });
      fanIn = new SseFanIn(serverManager, { batchInterval: 1 });

      fanIn.subscribeServer('s1');

      const events = [];
      const unsub = fanIn.onEvent((batch) => events.push(...batch));
      eventHandler({ type: 'test.event' });
      await new Promise((r) => setTimeout(r, 5));
      const testCount = events.filter((e) => e.type === 'test.event').length;
      expect(testCount).toBe(1);

      unsub();
      events.length = 0;

      eventHandler({ type: 'session.status', sessionID: 'def', status: 'active' });
      await new Promise((r) => setTimeout(r, 20));
      expect(events).toHaveLength(0);
    });

    test('listener errors do not break other listeners', async () => {
      const sub = {
        unsubscribe: mock(),
      };
      let eventHandler = null;
      serverManager = createServerManager({
        getClient: mock(() => ({
          events: {
            subscribe: mock((handler) => {
              eventHandler = handler;
              return sub;
            }),
          },
        })),
        updateStatus: mock(() => {}),
      });
      fanIn = new SseFanIn(serverManager, { batchInterval: 1 });

      fanIn.subscribeServer('s1');

      const goodEvents = [];
      fanIn.onEvent(() => { throw new Error('listener crash'); });
      fanIn.onEvent((batch) => goodEvents.push(...batch));
      eventHandler({ type: 'test.event' });
      await new Promise((r) => setTimeout(r, 5));
      const testEvents = goodEvents.filter((e) => e.type === 'test.event');
      expect(testEvents).toHaveLength(1);
    });
  });

  describe('feedLocal', () => {
    test('events processed through same pipeline', async () => {
      serverManager = createServerManager({
        updateStatus: mock(() => {}),
      });
      fanIn = new SseFanIn(serverManager, { batchInterval: 1 });

      const events = [];
      fanIn.onEvent((batch) => events.push(...batch));

      fanIn.feedLocal('local', { type: 'session.status', sessionID: 'abc', status: 'active' });
      await new Promise((r) => setTimeout(r, 20));

      expect(events).toHaveLength(1);
      expect(events[0].serverId).toBe('local');
      expect(events[0].type).toBe('session.status');
    });

    test('feedLocal coalesces same-key events', async () => {
      serverManager = createServerManager({
        updateStatus: mock(() => {}),
      });
      fanIn = new SseFanIn(serverManager, { batchInterval: 1 });

      const events = [];
      fanIn.onEvent((batch) => events.push(...batch));

      fanIn.feedLocal('local', { type: 'session.status', sessionID: 'abc', status: 'active' });
      fanIn.feedLocal('local', { type: 'session.status', sessionID: 'abc', status: 'idle' });
      await new Promise((r) => setTimeout(r, 20));

      const statusEvents = events.filter((e) => e.type === 'session.status' && e.sessionID === 'abc');
      expect(statusEvents).toHaveLength(1);
      expect(statusEvents[0].status).toBe('idle');
    });

    test('feedLocal dispatches immediately for non-coalescable events', () => {
      serverManager = createServerManager({
        updateStatus: mock(() => {}),
      });
      fanIn = new SseFanIn(serverManager);

      const events = [];
      fanIn.onEvent((batch) => events.push(...batch));

      fanIn.feedLocal('local', { type: 'custom.event' });
      expect(events).toHaveLength(1);
      expect(events[0].type).toBe('custom.event');
      expect(events[0].serverId).toBe('local');
    });

    test('feedLocal ignores nullish events', () => {
      serverManager = createServerManager({
        updateStatus: mock(() => {}),
      });
      fanIn = new SseFanIn(serverManager);

      const events = [];
      fanIn.onEvent((batch) => events.push(...batch));

      expect(() => fanIn.feedLocal('local', null)).not.toThrow();
      expect(() => fanIn.feedLocal('local', undefined)).not.toThrow();
      expect(events).toHaveLength(0);
    });
  });

  describe('coalesce keys', () => {
    test('session.status and message.part.delta get special keys', async () => {
      const sub = {
        unsubscribe: mock(),
      };
      let eventHandler = null;
      serverManager = createServerManager({
        getClient: mock(() => ({
          events: {
            subscribe: mock((handler) => {
              eventHandler = handler;
              return sub;
            }),
          },
        })),
        updateStatus: mock(() => {}),
      });
      fanIn = new SseFanIn(serverManager, { batchInterval: 1 });

      fanIn.subscribeServer('s1');

      const events = [];
      fanIn.onEvent((batch) => events.push(...batch));

      eventHandler({ type: 'session.status', sessionID: 'abc', status: 'active' });
      eventHandler({ type: 'session.status', sessionID: 'abc', status: 'idle' });
      eventHandler({ type: 'message.part.delta', sessionID: 'abc', messageID: 'msg1', partID: 'p1', delta: 'a' });
      eventHandler({ type: 'message.part.delta', sessionID: 'abc', messageID: 'msg1', partID: 'p1', delta: 'b' });
      eventHandler({ type: 'message.part.delta', sessionID: 'abc', messageID: 'msg2', partID: 'p1', delta: 'c' });
      eventHandler({ type: 'other.event', sessionID: 'abc' });
      eventHandler({ type: 'other.event', sessionID: 'abc' });

      await new Promise((r) => setTimeout(r, 20));

      const statuses = events.filter((e) => e.type === 'session.status' && e.sessionID === 'abc');
      const deltas = events.filter((e) => e.type === 'message.part.delta');
      const others = events.filter((e) => e.type === 'other.event' && e.sessionID === 'abc');

      expect(statuses).toHaveLength(1);
      expect(statuses[0].status).toBe('idle');
      expect(deltas).toHaveLength(2);
      expect(deltas.find((d) => d.messageID === 'msg1').delta).toBe('b');
      expect(deltas.find((d) => d.messageID === 'msg2').delta).toBe('c');
      expect(others).toHaveLength(2);
    });

    test('events without sessionID are not coalesced', () => {
      serverManager = createServerManager({
        updateStatus: mock(() => {}),
      });
      fanIn = new SseFanIn(serverManager);

      const events = [];
      fanIn.onEvent((batch) => events.push(...batch));

      fanIn.feedLocal('local', { type: 'no-session.event' });
      fanIn.feedLocal('local', { type: 'no-session.event' });

      expect(events).toHaveLength(2);
    });

    test('events with session_id field are coalesced', async () => {
      serverManager = createServerManager({
        updateStatus: mock(() => {}),
      });
      fanIn = new SseFanIn(serverManager, { batchInterval: 1 });

      const events = [];
      fanIn.onEvent((batch) => events.push(...batch));

      fanIn.feedLocal('local', { type: 'session.status', session_id: 'abc', status: 'a' });
      fanIn.feedLocal('local', { type: 'session.status', session_id: 'abc', status: 'b' });
      await new Promise((r) => setTimeout(r, 20));

      const statusEvents = events.filter((e) => e.session_id === 'abc');
      expect(statusEvents).toHaveLength(1);
    });
    test('coalesces events with sessionID in properties', async () => {
      serverManager = createServerManager({
        updateStatus: mock(() => {}),
      });
      fanIn = new SseFanIn(serverManager, { batchInterval: 1 });

      const events = [];
      fanIn.onEvent((batch) => events.push(...batch));

      fanIn.feedLocal('local', { type: 'session.status', properties: { sessionID: 'abc' }, status: 'active' });
      fanIn.feedLocal('local', { type: 'session.status', properties: { sessionID: 'abc' }, status: 'idle' });
      await new Promise((r) => setTimeout(r, 20));

      const statusEvents = events.filter((e) => e.type === 'session.status');
      expect(statusEvents).toHaveLength(1);
      expect(statusEvents[0].status).toBe('idle');
    });

    test('coalesces delta events by messageID + partID + field', async () => {
      serverManager = createServerManager({
        updateStatus: mock(() => {}),
      });
      fanIn = new SseFanIn(serverManager, { batchInterval: 1 });

      const events = [];
      fanIn.onEvent((batch) => events.push(...batch));

      fanIn.feedLocal('local', { type: 'message.part.delta', sessionID: 'abc', messageID: 'm1', partID: 'p1', field: 'delta', delta: 'x' });
      fanIn.feedLocal('local', { type: 'message.part.delta', sessionID: 'abc', messageID: 'm1', partID: 'p1', field: 'delta', delta: 'y' });
      fanIn.feedLocal('local', { type: 'message.part.delta', sessionID: 'abc', messageID: 'm1', partID: 'p2', delta: 'z' });
      await new Promise((r) => setTimeout(r, 20));

      expect(events.filter((e) => e.type === 'message.part.delta')).toHaveLength(2);
    });

    test('delta events without messageID or partID are not coalesced', async () => {
      serverManager = createServerManager({
        updateStatus: mock(() => {}),
      });
      fanIn = new SseFanIn(serverManager, { batchInterval: 1 });

      const events = [];
      fanIn.onEvent((batch) => events.push(...batch));

      fanIn.feedLocal('local', { type: 'message.part.delta', sessionID: 'abc', delta: 'a' });
      fanIn.feedLocal('local', { type: 'message.part.delta', sessionID: 'abc', delta: 'b' });
      await new Promise((r) => setTimeout(r, 20));

      expect(events.filter((e) => e.type === 'message.part.delta')).toHaveLength(2);
    });

    test('non-status events are not coalesced', async () => {
      serverManager = createServerManager({
        updateStatus: mock(() => {}),
      });
      fanIn = new SseFanIn(serverManager, { batchInterval: 1 });

      const events = [];
      fanIn.onEvent((batch) => events.push(...batch));

      fanIn.feedLocal('local', { type: 'permission.asked', sessionID: 'abc', requestID: 'r1' });
      fanIn.feedLocal('local', { type: 'permission.asked', sessionID: 'abc', requestID: 'r2' });
      await new Promise((r) => setTimeout(r, 20));

      expect(events.filter((e) => e.type === 'permission.asked')).toHaveLength(2);
    });
  });
});
