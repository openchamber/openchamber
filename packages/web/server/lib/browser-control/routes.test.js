import { describe, expect, it } from 'vitest';
import express from 'express';
import request from 'supertest';

import { createBrowserControlBroker } from './broker.js';
import { createInventoryRecorder } from './delivery.js';
import { registerBrowserControlRoutes } from './routes.js';

/**
 * These run against a real Express app on purpose. This server attaches body
 * parsing per route, so a route that forgets it still *registers* fine and only
 * fails when a client posts to it — which surfaces to the agent as an
 * unexplained timeout, nowhere near the cause.
 */
const createApp = ({ listeners = 1 } = {}) => {
  const emitted = [];
  const clients = new Set();
  let sequence = 0;
  const broker = createBrowserControlBroker({
    emitRequest: (payload) => {
      emitted.push(payload);
      return { delivered: listeners, eligibleClientIds: ['win-1'] };
    },
    createId: () => {
      sequence += 1;
      return `req-${sequence}`;
    },
  });
  const inventoryRecorder = createInventoryRecorder();

  const app = express();
  registerBrowserControlRoutes(app, {
    express,
    broker,
    getOpenChamberEventClients: () => clients,
    inventoryRecorder,
  });
  return { app, broker, emitted, clients, inventoryRecorder };
};

const sseConnection = (clientId) => ({
  openchamberBrowserCapable: true,
  openchamberClientId: clientId,
});

/** Claims through the real route, the way the client does, and returns the token. */
const claimViaRoute = async (app, requestId, clientId = 'win-1') => {
  const response = await request(app)
    .post('/api/browser-control/claim')
    .send({ requestId, clientId })
    .expect(200);
  return response.body.claimToken;
};

const validInventory = (overrides = {}) => ({
  clientId: 'win-1',
  revision: 1,
  openableDirectory: '/repo',
  controllers: [{ directory: '/repo', tabId: 'tab-1' }],
  activeTarget: { directory: '/repo', tabId: 'tab-1' },
  hasFocus: true,
  ...overrides,
});

describe('browser control result route', () => {
  it('parses a posted JSON body and resolves the waiting request', async () => {
    const { app, broker, emitted } = createApp();
    const inflight = broker.request('browser.snapshot', {});
    const claimToken = await claimViaRoute(app, emitted[0].requestId);

    await request(app)
      .post('/api/browser-control/result')
      .send({ requestId: emitted[0].requestId, claimToken, ok: true, data: { url: 'http://localhost:3000/' } })
      .expect(200, { matched: true });

    expect(await inflight).toEqual({ url: 'http://localhost:3000/' });
  });

  it('accepts a snapshot large enough to carry a real page', async () => {
    const { app, broker, emitted } = createApp();
    const inflight = broker.request('browser.snapshot', {});
    const claimToken = await claimViaRoute(app, emitted[0].requestId);

    const data = {
      url: 'http://localhost:3000/',
      text: 'x'.repeat(200_000),
      elements: Array.from({ length: 120 }, (_, index) => ({
        selector: `div:nth-of-type(${index})`,
        label: 'y'.repeat(100),
      })),
    };

    await request(app)
      .post('/api/browser-control/result')
      .send({ requestId: emitted[0].requestId, claimToken, ok: true, data })
      .expect(200, { matched: true });

    const result = await inflight;
    expect(result.text).toHaveLength(200_000);
    expect(result.elements).toHaveLength(120);
  });

  it('propagates a client-reported failure', async () => {
    const { app, broker, emitted } = createApp();
    // Capture the outcome before posting: the rejection lands while the POST is
    // still in flight, and an unattached handler surfaces as an unhandled one.
    const outcome = broker.request('browser.click', { selector: '#nope' })
      .then(() => null, (error) => error);
    const claimToken = await claimViaRoute(app, emitted[0].requestId);

    await request(app)
      .post('/api/browser-control/result')
      .send({ requestId: emitted[0].requestId, claimToken, ok: false, error: 'No element matches #nope' })
      .expect(200, { matched: true });

    expect((await outcome)?.message).toBe('No element matches #nope');
  });

  it('rejects the waiting request with the resolved tab the client reported', async () => {
    const { app, broker, emitted } = createApp();
    // A tab-less request failed while running against the resolved active tab:
    // the rejection must name that tab, not just the request's scope.
    const outcome = broker.request('browser.click', { selector: '#nope' }, { target: { directory: '/repo' } })
      .then(() => null, (error) => error);
    const claimToken = await claimViaRoute(app, emitted[0].requestId);

    await request(app)
      .post('/api/browser-control/result')
      .send({
        requestId: emitted[0].requestId,
        claimToken,
        ok: false,
        error: 'No element matches #nope',
        data: { target: { directory: '/repo', tabId: 'tab-b' } },
      })
      .expect(200, { matched: true });

    const error = await outcome;
    expect(error?.message).toBe('No element matches #nope');
    expect(error?.target).toEqual({ directory: '/repo', tabId: 'tab-b' });
  });

  it('reports matched: false for a response that arrived after the timeout', async () => {
    const { app } = createApp();
    await request(app)
      .post('/api/browser-control/result')
      .send({ requestId: 'expired', claimToken: 'stale-token', ok: true, data: {} })
      .expect(200, { matched: false });
  });

  it('rejects a result that carries no claim token', async () => {
    const { app } = createApp();
    await request(app)
      .post('/api/browser-control/result')
      .send({ requestId: 'req-1', ok: true, data: {} })
      .expect(400);
  });

  it('reports matched: false for a result whose token does not match the claim', async () => {
    const { app, broker, emitted } = createApp();
    const inflight = broker.request('browser.snapshot', {});
    void inflight.catch(() => undefined);
    await claimViaRoute(app, emitted[0].requestId);

    await request(app)
      .post('/api/browser-control/result')
      .send({ requestId: emitted[0].requestId, claimToken: 'forged', ok: true, data: {} })
      .expect(200, { matched: false });

    expect(broker.pendingCount).toBe(1);
    broker.rejectAll('done');
  });

  it('rejects a body with no request id', async () => {
    const { app } = createApp();
    await request(app)
      .post('/api/browser-control/result')
      .send({ ok: true })
      .expect(400);
  });

  it('rejects a body that is not an object', async () => {
    const { app } = createApp();
    await request(app)
      .post('/api/browser-control/result')
      .set('Content-Type', 'application/json')
      .send('"just-a-string"')
      .expect(400);
  });
});

describe('browser control claim route', () => {
  it('grants a delivered client with a one-time token, and refuses the second claim', async () => {
    const { app, broker, emitted } = createApp();
    const inflight = broker.request('browser.click', { selector: 'button' });
    void inflight.catch(() => undefined);

    const first = await request(app)
      .post('/api/browser-control/claim')
      .send({ requestId: emitted[0].requestId, clientId: 'win-1' })
      .expect(200);
    expect(first.body.granted).toBe(true);
    expect(typeof first.body.claimToken).toBe('string');

    const second = await request(app)
      .post('/api/browser-control/claim')
      .send({ requestId: emitted[0].requestId, clientId: 'win-1' })
      .expect(200);
    expect(second.body).toEqual({ granted: false });

    broker.rejectAll('done');
  });

  it('refuses a client the request was never delivered to', async () => {
    const { app, broker, emitted } = createApp();
    const inflight = broker.request('browser.click', { selector: 'button' });
    void inflight.catch(() => undefined);

    const response = await request(app)
      .post('/api/browser-control/claim')
      .send({ requestId: emitted[0].requestId, clientId: 'win-elsewhere' })
      .expect(200);
    expect(response.body).toEqual({ granted: false });

    broker.rejectAll('done');
  });

  it('refuses a claim that names no client at all', async () => {
    const { app, broker, emitted } = createApp();
    const inflight = broker.request('browser.click', { selector: 'button' });
    void inflight.catch(() => undefined);

    const response = await request(app)
      .post('/api/browser-control/claim')
      .send({ requestId: emitted[0].requestId })
      .expect(200);
    expect(response.body).toEqual({ granted: false });

    broker.rejectAll('done');
  });

  it('rejects a claim with no request id', async () => {
    const { app } = createApp();
    await request(app)
      .post('/api/browser-control/claim')
      .send({ clientId: 'win-1' })
      .expect(400);
  });
});

describe('browser control inventory route', () => {
  it('stores the inventory on the matching connection and fires the update event', async () => {
    const { app, clients, inventoryRecorder } = createApp();
    const connection = sseConnection('win-1');
    clients.add(connection);
    const events = [];
    inventoryRecorder.onInventoryUpdated(() => events.push('updated'));

    await request(app)
      .post('/api/browser-control/inventory')
      .send(validInventory())
      .expect(200, { recorded: true });

    expect(connection.browserControlInventory).toEqual({
      revision: 1,
      openableDirectory: '/repo',
      controllers: [{ directory: '/repo', tabId: 'tab-1' }],
      activeTarget: { directory: '/repo', tabId: 'tab-1' },
      hasFocus: true,
    });
    expect(events).toEqual(['updated']);
  });

  it('accepts a URL-derived tab id longer than 2KB', async () => {
    const { app, clients } = createApp();
    const connection = sseConnection('win-1');
    clients.add(connection);
    const longTabId = `browser:${'x'.repeat(3_000)}`;

    await request(app)
      .post('/api/browser-control/inventory')
      .send(validInventory({ controllers: [{ directory: '/repo', tabId: longTabId }] }))
      .expect(200, { recorded: true });

    expect(connection.browserControlInventory.controllers[0].tabId).toBe(longTabId);
  });

  it('rejects a stale revision without overwriting the stored inventory', async () => {
    const { app, clients } = createApp();
    const connection = sseConnection('win-1');
    clients.add(connection);

    await request(app)
      .post('/api/browser-control/inventory')
      .send(validInventory({ revision: 5, openableDirectory: '/new' }))
      .expect(200, { recorded: true });

    await request(app)
      .post('/api/browser-control/inventory')
      .send(validInventory({ revision: 4, openableDirectory: '/old' }))
      .expect(200, { recorded: false });

    await request(app)
      .post('/api/browser-control/inventory')
      .send(validInventory({ revision: 5, openableDirectory: '/old' }))
      .expect(200, { recorded: false });

    expect(connection.browserControlInventory.openableDirectory).toBe('/new');
  });

  it('reports recorded: false for an unknown clientId without throwing', async () => {
    const { app, clients } = createApp();
    clients.add(sseConnection('win-1'));

    await request(app)
      .post('/api/browser-control/inventory')
      .send(validInventory({ clientId: 'win-elsewhere' }))
      .expect(200, { recorded: false });
  });

  it('rejects malformed bodies without throwing', async () => {
    const { app, clients } = createApp();
    const connection = sseConnection('win-1');
    clients.add(connection);

    const bodies = [
      { ...validInventory(), clientId: '' },
      { ...validInventory(), clientId: 'x'.repeat(65) },
      { ...validInventory(), clientId: 42 },
      { ...validInventory(), revision: '3' },
      { ...validInventory(), revision: Number.NaN },
      { ...validInventory(), openableDirectory: 'x'.repeat(1_025) },
      { ...validInventory(), openableDirectory: 7 },
      { ...validInventory(), controllers: 'nope' },
      {
        ...validInventory(),
        controllers: Array.from({ length: 65 }, (_, index) => ({ directory: '/repo', tabId: `tab-${index}` })),
      },
      { ...validInventory(), controllers: [{ directory: 'x'.repeat(1_025), tabId: 'tab-1' }] },
      { ...validInventory(), controllers: [{ directory: '/repo' }] },
      { ...validInventory(), controllers: [{ directory: '/repo', tabId: 9 }] },
      { ...validInventory(), activeTarget: { directory: '/repo' } },
      { ...validInventory(), activeTarget: 'tab-1' },
    ];

    for (const body of bodies) {
      await request(app)
        .post('/api/browser-control/inventory')
        .send(body)
        .expect(400);
    }

    expect(connection.browserControlInventory).toBe(undefined);
  });

  it('rejects a body that is not an object', async () => {
    const { app } = createApp();
    await request(app)
      .post('/api/browser-control/inventory')
      .set('Content-Type', 'application/json')
      .send('"just-a-string"')
      .expect(400);
  });

  it('refuses a body beyond the 256kb limit', async () => {
    const { app } = createApp();
    await request(app)
      .post('/api/browser-control/inventory')
      .send(validInventory({ controllers: [{ directory: '/repo', tabId: 'x'.repeat(300_000) }] }))
      .expect(413);
  });
});
