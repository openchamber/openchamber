import { describe, expect, test } from 'bun:test';

import { BrowserControlError, createBrowserControlBroker } from './broker.js';

const createBroker = (options = {}) => {
  const emitted = [];
  let sequence = 0;
  const broker = createBrowserControlBroker({
    emitRequest: (payload) => {
      emitted.push(payload);
      return options.listeners ?? 1;
    },
    createId: () => {
      sequence += 1;
      return `req-${sequence}`;
    },
    ...options.overrides,
  });
  return { broker, emitted };
};

describe('browser control broker', () => {
  test('resolves with the data the client posted back', async () => {
    const { broker, emitted } = createBroker();
    const inflight = broker.request('browser.snapshot', {});
    expect(emitted[0]?.action).toBe('browser.snapshot');

    broker.resolve(emitted[0].requestId, { ok: true, data: { url: 'http://localhost:5173/' } });
    expect(await inflight).toEqual({ url: 'http://localhost:5173/' });
  });

  test('fails fast when no client is connected instead of blocking', async () => {
    const { broker } = createBroker({ listeners: 0 });
    await expect(broker.request('browser.open', { url: 'http://a/' })).rejects.toThrow(BrowserControlError);
  });

  test('describes the environment rather than telling the agent what to do', async () => {
    const { broker } = createBroker({ listeners: 0 });
    try {
      await broker.request('browser.snapshot', {});
      throw new Error('expected rejection');
    } catch (error) {
      expect(error.status).toBe(503);
      // The agent reads this, not the user: it must state the limitation and
      // where the capability exists, without issuing an instruction the agent
      // cannot carry out.
      expect(error.message).toContain('desktop application');
      expect(error.message).toContain('Nothing was changed');
      expect(error.message).not.toContain('Ask the user to open');
    }
  });

  test('surfaces a client-reported failure with its message', async () => {
    const { broker, emitted } = createBroker();
    const inflight = broker.request('browser.click', { selector: '#missing' });
    broker.resolve(emitted[0].requestId, { ok: false, error: 'No element matches #missing' });
    await expect(inflight).rejects.toThrow('No element matches #missing');
  });

  test('times out when the client accepted the request and never answered', async () => {
    let fire = null;
    const { broker } = createBroker({
      overrides: {
        setTimer: (callback) => { fire = callback; return 1; },
        clearTimer: () => {},
      },
    });
    const inflight = broker.request('browser.snapshot', {}, { timeoutMs: 5_000 });
    fire();
    await expect(inflight).rejects.toThrow('did not respond within 5s');
  });

  test('ignores a late response that lost the race with the timeout', async () => {
    let fire = null;
    const { broker, emitted } = createBroker({
      overrides: {
        setTimer: (callback) => { fire = callback; return 1; },
        clearTimer: () => {},
      },
    });
    const inflight = broker.request('browser.snapshot', {});
    fire();
    await expect(inflight).rejects.toThrow();
    expect(broker.resolve(emitted[0].requestId, { ok: true, data: {} })).toBe(false);
  });

  test('rejects an unknown request id without throwing', () => {
    const { broker } = createBroker();
    expect(broker.resolve('nope', { ok: true })).toBe(false);
    expect(broker.resolve('', { ok: true })).toBe(false);
  });

  test('clears pending state once a request settles', async () => {
    const { broker, emitted } = createBroker();
    const inflight = broker.request('browser.snapshot', {});
    expect(broker.pendingCount).toBe(1);
    broker.resolve(emitted[0].requestId, { ok: true, data: null });
    await inflight;
    expect(broker.pendingCount).toBe(0);
  });

  test('fails everything in flight when the owning client disconnects', async () => {
    const { broker } = createBroker();
    const inflight = broker.request('browser.snapshot', {});
    broker.rejectAll('The OpenChamber client disconnected');
    await expect(inflight).rejects.toThrow('disconnected');
    expect(broker.pendingCount).toBe(0);
  });

  test('propagates cancellation from the caller', async () => {
    const { broker } = createBroker();
    const controller = new AbortController();
    const inflight = broker.request('browser.snapshot', {}, { signal: controller.signal });
    controller.abort();
    await expect(inflight).rejects.toThrow('cancelled');
  });

  test('rejects immediately when the caller is already cancelled', async () => {
    const { broker } = createBroker();
    const controller = new AbortController();
    controller.abort();
    await expect(broker.request('browser.snapshot', {}, { signal: controller.signal })).rejects.toThrow('cancelled');
  });
});

/**
 * Whether a page can be driven depends on which client is connected, not on the
 * server: a desktop shell and a browser tab can be attached to one server at
 * once, and either may arrive or leave at any moment. The broker is told how
 * many clients could actually perform each action.
 */
describe('client capability', () => {
  const createCapabilityBroker = (capableFor) => {
    const emitted = [];
    let sequence = 0;
    const broker = createBrowserControlBroker({
      emitRequest: (payload) => {
        emitted.push(payload);
        return capableFor(payload.action);
      },
      createId: () => { sequence += 1; return `req-${sequence}`; },
    });
    return { broker, emitted };
  };

  test('opening a page works with a client that cannot drive one', async () => {
    // A browser tab can display a page even though it cannot be controlled.
    const { broker, emitted } = createCapabilityBroker((action) => (action === 'browser.open' ? 1 : 0));
    const inflight = broker.request('browser.open', { url: 'http://localhost:3000/' });
    broker.resolve(emitted[0].requestId, { ok: true, data: { opened: true } });
    expect(await inflight).toEqual({ opened: true });
  });

  test('driving a page fails immediately when no client can', async () => {
    const { broker } = createCapabilityBroker((action) => (action === 'browser.open' ? 1 : 0));
    await expect(broker.request('browser.click', { selector: '#a' })).rejects.toThrow('desktop application');
  });

  test('driving a page works as soon as a capable client is connected', async () => {
    // No restart, no setting: a desktop client attaching is enough.
    const { broker, emitted } = createCapabilityBroker(() => 1);
    const inflight = broker.request('browser.snapshot', {});
    broker.resolve(emitted[0].requestId, { ok: true, data: { url: 'http://localhost:3000/' } });
    expect(await inflight).toEqual({ url: 'http://localhost:3000/' });
  });
});

describe('one request, one performer', () => {
  test('grants the request to the first claimant and refuses the rest', async () => {
    const broker = createBrowserControlBroker({ emitRequest: () => 2, createId: () => 'req-1' });
    const pending = broker.request('browser.click', { selector: 'button' });

    expect(broker.claim('req-1')).toBe(true);
    // A second desktop client is told no, so it never clicks.
    expect(broker.claim('req-1')).toBe(false);

    broker.resolve('req-1', { ok: true, data: { clicked: true } });
    await expect(pending).resolves.toEqual({ clicked: true });
  });

  test('refuses a claim for a request that is already over', () => {
    const broker = createBrowserControlBroker({ emitRequest: () => 1, createId: () => 'req-1' });
    const pending = broker.request('browser.click', {});
    broker.resolve('req-1', { ok: true, data: null });
    void pending.catch(() => undefined);

    // Acting now would change a page nobody is waiting on.
    expect(broker.claim('req-1')).toBe(false);
    expect(broker.claim('unknown')).toBe(false);
  });
});
