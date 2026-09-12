import { describe, expect, test, vi } from 'bun:test';

import { BrowserControlError, createBrowserControlBroker } from './broker.js';

const createBroker = (options = {}) => {
  const emitted = [];
  let sequence = 0;
  const broker = createBrowserControlBroker({
    emitRequest: (payload) => {
      emitted.push(payload);
      return { delivered: options.listeners ?? 1, eligibleClientIds: options.eligible ?? ['win-1'] };
    },
    createId: () => {
      sequence += 1;
      return `req-${sequence}`;
    },
    ...options.overrides,
  });
  return { broker, emitted };
};

/**
 * Claims through the eligibility contract, returning the token results are
 * bound to. Null when the grant was refused.
 */
const claimFor = (broker, requestId, clientId = 'win-1') => {
  const grant = broker.claim(requestId, clientId);
  return typeof grant === 'object' && grant !== null && grant.granted === true ? grant.claimToken : null;
};

describe('browser control broker', () => {
  test('resolves with the data the client posted back', async () => {
    const { broker, emitted } = createBroker();
    const inflight = broker.request('browser.snapshot', {});
    expect(emitted[0]?.action).toBe('browser.snapshot');

    const claimToken = claimFor(broker, emitted[0].requestId);
    broker.resolve(emitted[0].requestId, { ok: true, data: { url: 'http://localhost:5173/' } }, claimToken);
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

  test('names the target directory when a targeted request reaches nobody', async () => {
    const { broker } = createBroker({ listeners: 0 });
    try {
      await broker.request('browser.snapshot', {}, { target: { directory: '/repo' } });
      throw new Error('expected rejection');
    } catch (error) {
      expect(error.status).toBe(503);
      expect(error.message).toContain('/repo');
      expect(error.target).toEqual({ directory: '/repo' });
}
  });

  test('uses the injected no-client copy when provided, tagged as a no-client failure', async () => {
    const { broker } = createBroker({
      listeners: 0,
      overrides: { getNoClientMessage: () => 'The server browser is enabled but did not answer this request.' },
    });

    try {
      await broker.request('browser.snapshot', {}, { target: { directory: '/repo' } });
      throw new Error('expected rejection');
    } catch (error) {
      expect(error.status).toBe(503);
      expect(error.message).toBe('The server browser is enabled but did not answer this request.');
      expect(error.code).toBe('no-client');
      expect(error.target).toEqual({ directory: '/repo' });
    }
  });

  test('keeps the default no-client copy when the injection answers a non-string', async () => {
    const { broker } = createBroker({
      listeners: 0,
      overrides: { getNoClientMessage: () => null },
    });

    try {
      await broker.request('browser.snapshot', {}, { target: { directory: '/repo' } });
      throw new Error('expected rejection');
    } catch (error) {
      expect(error.status).toBe(503);
      expect(error.message).toContain('No connected OpenChamber window can serve the browser panel for /repo');
      expect(error.code).toBe('no-client');
    }
  });

  test('stores the eligible client ids on the pending entry', async () => {
    const emitted = [];
    const broker = createBrowserControlBroker({
      emitRequest: (payload) => {
        emitted.push(payload);
        return { delivered: 2, eligibleClientIds: ['win-1', 'win-2'] };
      },
      createId: () => 'req-1',
    });

    const inflight = broker.request('browser.click', { selector: 'button' });
    expect(broker.getEligibleClientIds('req-1')).toEqual(['win-1', 'win-2']);

    broker.resolve('req-1', { ok: true, data: null }, claimFor(broker, 'req-1', 'win-1'));
    await inflight;
    expect(broker.getEligibleClientIds('req-1')).toBe(undefined);
  });

  test('surfaces a client-reported failure with its message and the request target', async () => {
    const { broker, emitted } = createBroker();
    const target = { directory: '/repo', tabId: 'tab-1' };
    const inflight = broker.request('browser.click', { selector: '#missing' }, { target });
    broker.resolve(emitted[0].requestId, { ok: false, error: 'No element matches #missing' }, claimFor(broker, emitted[0].requestId));
    try {
      await inflight;
      throw new Error('expected rejection');
    } catch (error) {
      expect(error).toBeInstanceOf(BrowserControlError);
      expect(error.message).toBe('No element matches #missing');
      expect(error.target).toEqual(target);
    }
  });

  test('times out when the client accepted the request and never answered', async () => {
    vi.useFakeTimers();
    try {
      const { broker } = createBroker();
      const outcome = broker.request('browser.snapshot', {}, { timeoutMs: 5_000 }).then(
        () => null,
        (error) => error,
      );
      // Claimed inside the window, so only the execution timeout remains.
      claimFor(broker, 'req-1');
      await vi.advanceTimersByTimeAsync(5_000);
      const error = await outcome;
      expect(error.message).toContain('did not respond within 5s');
    } finally {
      vi.useRealTimers();
    }
  });

  test('ignores a late response that lost the race with the timeout', async () => {
    vi.useFakeTimers();
    try {
      const { broker, emitted } = createBroker();
      const outcome = broker.request('browser.snapshot', {}).then(
        () => null,
        (error) => error,
      );
      const claimToken = claimFor(broker, 'req-1');
      await vi.advanceTimersByTimeAsync(20_000);
      const error = await outcome;
      expect(error).toBeInstanceOf(BrowserControlError);
      expect(broker.resolve(emitted[0].requestId, { ok: true, data: {} }, claimToken)).toBe(false);
    } finally {
      vi.useRealTimers();
    }
  });

  test('rejects an unknown request id without throwing', () => {
    const { broker } = createBroker();
    expect(broker.resolve('nope', { ok: true }, 'any-token')).toBe(false);
    expect(broker.resolve('', { ok: true }, 'any-token')).toBe(false);
  });

  test('clears pending state once a request settles', async () => {
    const { broker, emitted } = createBroker();
    const inflight = broker.request('browser.snapshot', {});
    expect(broker.pendingCount).toBe(1);
    broker.resolve(emitted[0].requestId, { ok: true, data: null }, claimFor(broker, emitted[0].requestId));
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
        return { delivered: capableFor(payload.action), eligibleClientIds: ['win-1'] };
      },
      createId: () => { sequence += 1; return `req-${sequence}`; },
    });
    return { broker, emitted };
  };

  test('opening a page works with a client that cannot drive one', async () => {
    // A browser tab can display a page even though it cannot be controlled.
    const { broker, emitted } = createCapabilityBroker((action) => (action === 'browser.open' ? 1 : 0));
    const inflight = broker.request('browser.open', { url: 'http://localhost:3000/' });
    broker.resolve(emitted[0].requestId, { ok: true, data: { opened: true } }, claimFor(broker, emitted[0].requestId));
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
    broker.resolve(emitted[0].requestId, { ok: true, data: { url: 'http://localhost:3000/' } }, claimFor(broker, emitted[0].requestId));
    expect(await inflight).toEqual({ url: 'http://localhost:3000/' });
  });
});

describe('one request, one performer', () => {
  test('grants the request to the first eligible claimant with a token and refuses the rest', async () => {
    const broker = createBrowserControlBroker({
      emitRequest: () => ({ delivered: 2, eligibleClientIds: ['win-1', 'win-2'] }),
      createId: () => 'req-1',
    });
    const pending = broker.request('browser.click', { selector: 'button' });

    const grant = broker.claim('req-1', 'win-1');
    expect(grant.granted).toBe(true);
    expect(typeof grant.claimToken).toBe('string');
    // A second eligible client is told no, so it never clicks.
    expect(broker.claim('req-1', 'win-2')).toEqual({ granted: false });

    broker.resolve('req-1', { ok: true, data: { clicked: true } }, grant.claimToken);
    await expect(pending).resolves.toEqual({ clicked: true });
  });

  test('refuses a claim from a client the request was never delivered to, even while unclaimed', async () => {
    const broker = createBrowserControlBroker({
      emitRequest: () => ({ delivered: 1, eligibleClientIds: ['win-1'] }),
      createId: () => 'req-1',
    });
    const pending = broker.request('browser.click', { selector: 'button' });
    void pending.catch(() => undefined);

    // Never in the delivered set: refused exactly like a losing race, and the
    // refusal must not consume the grant.
    expect(broker.claim('req-1', 'win-elsewhere')).toEqual({ granted: false });
    const grant = broker.claim('req-1', 'win-1');
    expect(grant.granted).toBe(true);

    broker.resolve('req-1', { ok: true, data: null }, grant.claimToken);
    await pending;
  });

  test('refuses a claim without a client identity', async () => {
    const broker = createBrowserControlBroker({
      emitRequest: () => ({ delivered: 1, eligibleClientIds: ['win-1'] }),
      createId: () => 'req-1',
    });
    const pending = broker.request('browser.click', {});
    void pending.catch(() => undefined);

    expect(broker.claim('req-1')).toEqual({ granted: false });
    expect(broker.claim('req-1', '')).toEqual({ granted: false });

    broker.resolve('req-1', { ok: true, data: null }, claimFor(broker, 'req-1'));
    await pending;
  });

  test('refuses a claim for a request that is already over', () => {
    const broker = createBrowserControlBroker({
      emitRequest: () => ({ delivered: 1, eligibleClientIds: ['win-1'] }),
      createId: () => 'req-1',
    });
    const pending = broker.request('browser.click', {});
    broker.resolve('req-1', { ok: true, data: null }, claimFor(broker, 'req-1'));
    void pending.catch(() => undefined);

    // Acting now would change a page nobody is waiting on.
    expect(broker.claim('req-1', 'win-1')).toEqual({ granted: false });
    expect(broker.claim('unknown', 'win-1')).toEqual({ granted: false });
  });
});

describe('claim token binding', () => {
  test('settles a result only when the claim token matches', async () => {
    const { broker, emitted } = createBroker();
    const inflight = broker.request('browser.snapshot', {});
    const claimToken = claimFor(broker, 'req-1');

    // A result from the losing race has no token; a forged one does not match.
    expect(broker.resolve('req-1', { ok: true, data: { url: 'http://wrong/' } })).toBe(false);
    expect(broker.resolve('req-1', { ok: true, data: { url: 'http://wrong/' } }, 'not-the-token')).toBe(false);
    expect(broker.pendingCount).toBe(1);

    expect(broker.resolve(emitted[0].requestId, { ok: true, data: { url: 'http://right/' } }, claimToken)).toBe(true);
    expect(await inflight).toEqual({ url: 'http://right/' });
  });

  test('does not settle a result for a request that was never claimed', () => {
    const { broker } = createBroker();
    const inflight = broker.request('browser.snapshot', {});
    void inflight.catch(() => undefined);

    expect(broker.resolve('req-1', { ok: true, data: {} }, 'any-token')).toBe(false);
    expect(broker.pendingCount).toBe(1);
    broker.rejectAll('done');
  });
});

describe('claim window', () => {
  test('settles an unclaimed delivered request as a 503 naming the directory after 3s', async () => {
    vi.useFakeTimers();
    try {
      const { broker } = createBroker({ eligible: ['win-1'] });
      let settled = null;
      const inflight = broker.request('browser.click', { selector: 'button' }, { target: { directory: '/repo' } }).then(
        () => { settled = 'resolved'; },
        (error) => { settled = error; },
      );

      // Just inside the window nothing has happened yet.
      await vi.advanceTimersByTimeAsync(2_999);
      expect(settled).toBe(null);

      await vi.advanceTimersByTimeAsync(1);
      expect(settled).toBeInstanceOf(BrowserControlError);
      expect(settled.status).toBe(503);
      expect(settled.message).toContain('/repo');
      expect(settled.target).toEqual({ directory: '/repo' });
      expect(broker.pendingCount).toBe(0);
      await inflight;
    } finally {
      vi.useRealTimers();
    }
  });

  test('does not settle at the claim window once the request is claimed', async () => {
    vi.useFakeTimers();
    try {
      const { broker } = createBroker();
      let settled = null;
      const inflight = broker.request('browser.snapshot', {}).then(
        (data) => { settled = data; },
        (error) => { settled = error; },
      );
      const grant = broker.claim('req-1', 'win-1');
      expect(grant.granted).toBe(true);

      await vi.advanceTimersByTimeAsync(3_000);
      expect(settled).toBe(null);
      expect(broker.pendingCount).toBe(1);

      broker.resolve('req-1', { ok: true, data: { done: true } }, grant.claimToken);
      await inflight;
      expect(settled).toEqual({ done: true });
    } finally {
      vi.useRealTimers();
    }
  });
});

describe('cancel propagation', () => {
  const createCancelBroker = () => {
    const cancels = [];
    const broker = createBrowserControlBroker({
      emitRequest: () => ({ delivered: 2, eligibleClientIds: ['win-1', 'win-2'] }),
      createId: () => 'req-1',
      emitCancel: (payload) => { cancels.push(payload); },
    });
    return { broker, cancels };
  };

  test('emits the cancel to the eligible set when a claimed request is aborted', async () => {
    const { broker, cancels } = createCancelBroker();
    const controller = new AbortController();
    const inflight = broker.request('browser.click', {}, { signal: controller.signal });
    void inflight.catch(() => undefined);
    claimFor(broker, 'req-1', 'win-1');

    controller.abort();
    await inflight.catch(() => undefined);

    // Exactly the eligible set and the request id — the claim token never
    // leaves the claim/result channel.
    expect(cancels).toEqual([{ requestId: 'req-1', eligibleClientIds: ['win-1', 'win-2'] }]);
  });

  test('emits nothing when an unclaimed request is aborted', async () => {
    const { broker, cancels } = createCancelBroker();
    const controller = new AbortController();
    const inflight = broker.request('browser.click', {}, { signal: controller.signal });
    void inflight.catch(() => undefined);

    controller.abort();
    await inflight.catch(() => undefined);

    expect(cancels).toEqual([]);
  });

  test('emits the cancel when a claimed request times out', async () => {
    vi.useFakeTimers();
    try {
      const { broker, cancels } = createCancelBroker();
      const outcome = broker.request('browser.click', {}, { timeoutMs: 5_000 }).then(
        () => null,
        (error) => error,
      );
      claimFor(broker, 'req-1', 'win-1');

      await vi.advanceTimersByTimeAsync(5_000);
      const error = await outcome;
      expect(error.status).toBe(504);
      expect(cancels).toEqual([{ requestId: 'req-1', eligibleClientIds: ['win-1', 'win-2'] }]);
    } finally {
      vi.useRealTimers();
    }
  });

  test('emits nothing when the client settles the request with a result', async () => {
    const { broker, cancels } = createCancelBroker();
    const inflight = broker.request('browser.click', {});
    broker.resolve('req-1', { ok: false, error: 'No element' }, claimFor(broker, 'req-1', 'win-1'));
    await inflight.catch(() => undefined);

    expect(cancels).toEqual([]);
  });
});

describe('request target scope', () => {
  const target = { directory: '/repo', tabId: 'tab-1' };

  test('carries the target on the emitted request', async () => {
    const { broker, emitted } = createBroker();
    const inflight = broker.request('browser.snapshot', {}, { target });
    expect(emitted[0]?.target).toEqual(target);
    broker.resolve(emitted[0].requestId, { ok: true, data: null }, claimFor(broker, emitted[0].requestId));
    await inflight;
  });

  test('attaches the target to the no-listener rejection', async () => {
    const { broker } = createBroker({ listeners: 0 });
    try {
      await broker.request('browser.snapshot', {}, { target });
      throw new Error('expected rejection');
    } catch (error) {
      expect(error).toBeInstanceOf(BrowserControlError);
      expect(error.status).toBe(503);
      expect(error.target).toEqual(target);
    }
  });

  test('attaches the target to a timeout rejection', async () => {
    vi.useFakeTimers();
    try {
      const { broker } = createBroker();
      const outcome = broker.request('browser.snapshot', {}, { timeoutMs: 5_000, target }).then(
        () => null,
        (error) => error,
      );
      claimFor(broker, 'req-1');
      await vi.advanceTimersByTimeAsync(5_000);
      const error = await outcome;
      expect(error.target).toEqual(target);
    } finally {
      vi.useRealTimers();
    }
  });

  test('attaches the target to a cancellation', async () => {
    const { broker } = createBroker();
    const controller = new AbortController();
    const inflight = broker.request('browser.snapshot', {}, { signal: controller.signal, target });
    controller.abort();
    try {
      await inflight;
      throw new Error('expected rejection');
    } catch (error) {
      expect(error.target).toEqual(target);
    }
  });

  test('rejects an already-cancelled targeted request with the target attached', async () => {
    const { broker } = createBroker();
    const controller = new AbortController();
    controller.abort();
    try {
      await broker.request('browser.snapshot', {}, { signal: controller.signal, target });
      throw new Error('expected rejection');
    } catch (error) {
      expect(error.target).toEqual(target);
    }
  });

  test('a client-reported failure names the resolved tab, not just the request scope', async () => {
    const { broker, emitted } = createBroker();
    const outcome = broker.request('browser.click', { selector: '#x' }, { target: { directory: '/repo' } })
      .then(() => null, (error) => error);
    const claimToken = claimFor(broker, emitted[0].requestId);

    broker.resolve(emitted[0].requestId, {
      ok: false,
      error: 'The user interacted with this tab while the action ran; retry the action',
      data: { target: { directory: '/repo', tabId: 'tab-b' } },
    }, claimToken);

    const error = await outcome;
    expect(error).toBeInstanceOf(BrowserControlError);
    expect(error.message).toContain('retry the action');
    expect(error.target).toEqual({ directory: '/repo', tabId: 'tab-b' });
  });

  test('a client failure without a reported target keeps the request target', async () => {
    const { broker, emitted } = createBroker();
    const outcome = broker.request('browser.click', {}, { target })
      .then(() => null, (error) => error);
    const claimToken = claimFor(broker, emitted[0].requestId);

    broker.resolve(emitted[0].requestId, { ok: false, error: 'boom' }, claimToken);

    expect((await outcome).target).toEqual(target);
  });

  test('a malformed reported target is dropped, keeping the request target', async () => {
    const { broker, emitted } = createBroker();
    const outcome = broker.request('browser.click', {}, { target })
      .then(() => null, (error) => error);
    const claimToken = claimFor(broker, emitted[0].requestId);

    broker.resolve(emitted[0].requestId, { ok: false, error: 'boom', data: { target: { tabId: 42 } } }, claimToken);

    expect((await outcome).target).toEqual(target);
  });
});

/**
 * A request can arrive before the window that would serve it has posted its
 * first inventory (fresh connect, reconnect). Instead of failing immediately,
 * the broker waits for inventory updates and re-matches, until the inventory
 * arrives, everyone has posted, or a short deadline passes.
 */
describe('first-inventory wait', () => {
  const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

  const createWaitingBroker = ({ emitResults, pendingInventory = [] }) => {
    const emitted = [];
    const updateListeners = new Set();
    let emitCall = 0;
    let pendingCall = 0;
    const broker = createBrowserControlBroker({
      emitRequest: (payload) => {
        emitted.push(payload);
        const result = emitResults[Math.min(emitCall, emitResults.length - 1)];
        emitCall += 1;
        return result;
      },
      createId: () => 'req-1',
      onInventoryUpdated: (listener) => {
        updateListeners.add(listener);
        return () => updateListeners.delete(listener);
      },
      hasPendingInventory: () => {
        const pending = pendingInventory.length > 0
          ? pendingInventory[Math.min(pendingCall, pendingInventory.length - 1)]
          : true;
        pendingCall += 1;
        return pending;
      },
      inventoryWaitMs: 60,
    });
    return {
      broker,
      emitted,
      emitCallCount: () => emitCall,
      fireInventoryUpdate: () => { for (const listener of [...updateListeners]) listener(); },
    };
  };

  const noMatch = { delivered: 0, eligibleClientIds: [] };
  const target = { directory: '/repo' };

  test('delivers a request whose matching connection posts its inventory late', async () => {
    const { broker, emitted, fireInventoryUpdate } = createWaitingBroker({
      emitResults: [noMatch, { delivered: 1, eligibleClientIds: ['win-1'] }],
      pendingInventory: [true],
    });

    const inflight = broker.request('browser.snapshot', {}, { target });
    await sleep(10);
    expect(emitted).toHaveLength(1);

    fireInventoryUpdate();
    await sleep(10);
    expect(emitted).toHaveLength(2);
    expect(broker.getEligibleClientIds('req-1')).toEqual(['win-1']);

    broker.resolve('req-1', { ok: true, data: { url: 'http://localhost:5173/' } }, claimFor(broker, 'req-1', 'win-1'));
    expect(await inflight).toEqual({ url: 'http://localhost:5173/' });
  });

  test('keeps waiting when an unrelated connection posts first', async () => {
    const { broker, emitted, fireInventoryUpdate } = createWaitingBroker({
      emitResults: [noMatch, noMatch, { delivered: 1, eligibleClientIds: ['win-2'] }],
      pendingInventory: [true],
    });

    const inflight = broker.request('browser.snapshot', {}, { target });
    await sleep(10);

    // An inventory that matches nothing must not end the wait: a single wait
    // would settle as a 503 here while the serving window is still connecting.
    fireInventoryUpdate();
    await sleep(10);
    expect(emitted).toHaveLength(2);
    expect(broker.pendingCount).toBe(1);

    fireInventoryUpdate();
    await sleep(10);
    expect(emitted).toHaveLength(3);
    expect(broker.getEligibleClientIds('req-1')).toEqual(['win-2']);

    broker.resolve('req-1', { ok: true, data: null }, claimFor(broker, 'req-1', 'win-2'));
    await inflight;
  });

  test('stops waiting once every identified connection has posted, then 503s naming the directory', async () => {
    const { broker, emitted, fireInventoryUpdate } = createWaitingBroker({
      emitResults: [noMatch],
      pendingInventory: [true, false],
    });

    const outcome = broker.request('browser.snapshot', {}, { target }).then(
      () => null,
      (error) => error,
    );
    await sleep(10);
    fireInventoryUpdate();

    const error = await outcome;
    expect(error).toBeInstanceOf(BrowserControlError);
    expect(error.status).toBe(503);
    expect(error.message).toContain('/repo');
    expect(emitted).toHaveLength(2);
  });

  test('503s naming the directory when the deadline passes without a match', async () => {
    const { broker } = createWaitingBroker({
      emitResults: [noMatch],
      pendingInventory: [true],
    });

    const outcome = broker.request('browser.snapshot', {}, { target }).then(
      () => null,
      (error) => error,
    );

    const error = await outcome;
    expect(error).toBeInstanceOf(BrowserControlError);
    expect(error.status).toBe(503);
    expect(error.message).toContain('/repo');
    expect(error.target).toEqual(target);
  });

  test('does not wait when no identified connection is missing an inventory', async () => {
    const { broker, emitted } = createWaitingBroker({
      emitResults: [noMatch],
      pendingInventory: [false],
    });

    await expect(broker.request('browser.snapshot', {}, { target })).rejects.toThrow(BrowserControlError);
    expect(emitted).toHaveLength(1);
  });

  test('a cancellation during the wait rejects the request as cancelled, not unmatched', async () => {
    const { broker } = createWaitingBroker({
      emitResults: [noMatch],
      pendingInventory: [true],
    });

    const controller = new AbortController();
    const outcome = broker.request('browser.snapshot', {}, { signal: controller.signal, target }).then(
      () => null,
      (error) => error,
    );
    await sleep(10);
    controller.abort();

    const error = await outcome;
    expect(error.status).toBe(499);
    expect(error.message).toContain('cancelled');
    expect(broker.pendingCount).toBe(0);
  });
});
