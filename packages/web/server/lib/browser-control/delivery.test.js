import { describe, expect, test } from 'bun:test';

import {
  createInventoryRecorder,
  deliverBrowserControlCancel,
  deliverBrowserControlRequest,
  hasConnectionAwaitingInventory,
  selectEligibleConnections,
} from './delivery.js';

const createDelivery = () => {
  const writes = [];
  const clients = new Set();
  const writeSseEvent = (client, payload) => {
    if (client.broken) throw new Error('client gone');
    writes.push({ client, payload });
  };
  return { writes, clients, writeSseEvent };
};

const connection = ({ id = 'win-1', capable = true, inventory = null, broken = false } = {}) => {
  const client = { openchamberBrowserCapable: capable, openchamberClientId: id };
  if (inventory) client.browserControlInventory = inventory;
  if (broken) client.broken = true;
  return client;
};

const inventory = (overrides = {}) => ({
  revision: 1,
  openableDirectory: null,
  controllers: [],
  activeTarget: null,
  hasFocus: false,
  ...overrides,
});

const identified = connection({
  id: 'win-1',
  inventory: inventory({
    openableDirectory: '/repo',
    controllers: [{ directory: '/repo', tabId: 'tab-1' }],
    activeTarget: { directory: '/repo', tabId: 'tab-1' },
  }),
});
const legacy = connection({ id: null });

describe('selectEligibleConnections', () => {
  test('routes a rich action only to the connection whose inventory has a matching controller', () => {
    const match = connection({
      id: 'win-match',
      inventory: inventory({ controllers: [{ directory: '/repo', tabId: 'tab-1' }] }),
    });
    const wrongDirectory = connection({
      id: 'win-other',
      inventory: inventory({ controllers: [{ directory: '/other', tabId: 'tab-2' }] }),
    });
    const wrongTab = connection({
      id: 'win-tab',
      inventory: inventory({ controllers: [{ directory: '/repo', tabId: 'tab-9' }] }),
    });

    const selected = selectEligibleConnections(
      new Set([wrongDirectory, match, wrongTab]),
      { action: 'browser.click', target: { directory: '/repo', tabId: 'tab-1' } },
    );

    expect(selected).toEqual([match]);
  });

  test('requires the active target directory for a tab-less rich action, even on a focused window', () => {
    const visibleBrowser = connection({
      id: 'win-visible',
      inventory: inventory({
        controllers: [{ directory: '/repo', tabId: 'tab-1' }],
        activeTarget: { directory: '/repo', tabId: 'tab-1' },
      }),
    });
    // Focused, and it has the tab registered — but the user is looking at a
    // non-browser tab, so a tab-less action must not land in a hidden pane.
    const focusedHiddenPanes = connection({
      id: 'win-hidden',
      inventory: inventory({
        controllers: [{ directory: '/repo', tabId: 'tab-1' }],
        activeTarget: null,
        hasFocus: true,
      }),
    });

    const selected = selectEligibleConnections(
      new Set([focusedHiddenPanes, visibleBrowser]),
      { action: 'browser.click', target: { directory: '/repo' } },
    );

    expect(selected).toEqual([visibleBrowser]);
  });

  test('prefers the window where an explicitly named tab is visible', () => {
    const visible = connection({
      id: 'win-visible',
      inventory: inventory({
        controllers: [{ directory: '/repo', tabId: 'tab-1' }],
        activeTarget: { directory: '/repo', tabId: 'tab-1' },
      }),
    });
    const registeredOnly = connection({
      id: 'win-background',
      inventory: inventory({
        controllers: [{ directory: '/repo', tabId: 'tab-1' }],
        activeTarget: { directory: '/repo', tabId: 'tab-2' },
      }),
    });

    const selected = selectEligibleConnections(
      new Set([registeredOnly, visible]),
      { action: 'browser.click', target: { directory: '/repo', tabId: 'tab-1' } },
    );

    expect(selected).toEqual([visible]);
  });

  test('falls back to registered-only matches when the named tab is visible nowhere', () => {
    const backgroundA = connection({
      id: 'win-a',
      inventory: inventory({
        controllers: [{ directory: '/repo', tabId: 'tab-1' }],
        activeTarget: { directory: '/repo', tabId: 'tab-2' },
      }),
    });
    const backgroundB = connection({
      id: 'win-b',
      inventory: inventory({
        controllers: [{ directory: '/repo', tabId: 'tab-1' }],
        activeTarget: null,
      }),
    });

    const selected = selectEligibleConnections(
      new Set([backgroundA, backgroundB]),
      { action: 'browser.click', target: { directory: '/repo', tabId: 'tab-1' } },
    );

    expect(selected).toEqual([backgroundA, backgroundB]);
  });

  test('matches browser.tabs on the controller directory alone', () => {
    const match = connection({
      id: 'win-match',
      inventory: inventory({ controllers: [{ directory: '/repo', tabId: 'tab-1' }] }),
    });
    const other = connection({
      id: 'win-other',
      inventory: inventory({ controllers: [{ directory: '/other', tabId: 'tab-2' }] }),
    });
    // A display-only client never registers controllers; a forged inventory
    // must not make one eligible for a listing either.
    const displayOnly = connection({
      id: 'win-web',
      capable: false,
      inventory: inventory({ controllers: [{ directory: '/repo', tabId: 'tab-3' }] }),
    });

    const selected = selectEligibleConnections(
      new Set([other, displayOnly, match]),
      { action: 'browser.tabs', target: { directory: '/repo' } },
    );

    expect(selected).toEqual([match]);
  });

  test('delivers a tab-less open to a display-only connection with a matching openableDirectory', () => {
    const web = connection({
      id: 'win-web',
      capable: false,
      inventory: inventory({ openableDirectory: '/repo' }),
    });
    const elsewhere = connection({
      id: 'win-desktop',
      inventory: inventory({ openableDirectory: '/other' }),
    });

    const selected = selectEligibleConnections(
      new Set([elsewhere, web]),
      { action: 'browser.open', target: { directory: '/repo' } },
    );

    expect(selected).toEqual([web]);
  });

  test('delivers an open naming a tab like a rich action: capability plus exact controller match', () => {
    const displayOnly = connection({
      id: 'win-web',
      capable: false,
      inventory: inventory({
        openableDirectory: '/repo',
        controllers: [{ directory: '/repo', tabId: 'tab-1' }],
      }),
    });
    const capable = connection({
      id: 'win-desktop',
      inventory: inventory({ controllers: [{ directory: '/repo', tabId: 'tab-1' }] }),
    });

    const selected = selectEligibleConnections(
      new Set([displayOnly, capable]),
      { action: 'browser.open', target: { directory: '/repo', tabId: 'tab-1' } },
    );

    expect(selected).toEqual([capable]);
  });

  test('never delivers a targeted request to a legacy or inventory-less connection', () => {
    const legacyClient = connection({ id: null });
    // Even a hand-forged inventory does not make a clientId-less connection eligible.
    legacyClient.browserControlInventory = inventory({ openableDirectory: '/repo' });
    const inventoryLess = connection({ id: 'win-new' });

    const open = selectEligibleConnections(
      new Set([legacyClient, inventoryLess]),
      { action: 'browser.open', target: { directory: '/repo' } },
    );
    const rich = selectEligibleConnections(
      new Set([legacyClient, inventoryLess]),
      { action: 'browser.click', target: { directory: '/repo' } },
    );

    expect(open).toEqual([]);
    expect(rich).toEqual([]);
  });

  test('prefers the focused window on a multi-match, and delivers to all on a tie or no focus', () => {
    const build = (id, hasFocus) => connection({
      id,
      inventory: inventory({
        controllers: [{ directory: '/repo', tabId: `tab-${id}` }],
        activeTarget: { directory: '/repo', tabId: `tab-${id}` },
        hasFocus,
      }),
    });
    const request = { action: 'browser.snapshot', target: { directory: '/repo' } };

    const focused = build('focused', true);
    const unfocused = build('unfocused', false);
    expect(selectEligibleConnections(new Set([unfocused, focused]), request)).toEqual([focused]);

    const tieA = build('tie-a', true);
    const tieB = build('tie-b', true);
    expect(selectEligibleConnections(new Set([tieA, tieB]), request)).toEqual([tieA, tieB]);

    const plainA = build('plain-a', false);
    const plainB = build('plain-b', false);
    expect(selectEligibleConnections(new Set([plainA, plainB]), request)).toEqual([plainA, plainB]);
  });

  test('keeps the untargeted broadcast: open reaches every connection, rich actions need capability', () => {
    const displayOnly = connection({ id: 'win-web', capable: false });
    const legacyClient = connection({ id: null });

    expect(selectEligibleConnections(
      new Set([displayOnly, legacyClient]),
      { action: 'browser.open' },
    )).toEqual([displayOnly, legacyClient]);
    expect(selectEligibleConnections(
      new Set([displayOnly, legacyClient]),
      { action: 'browser.click' },
    )).toEqual([legacyClient]);
  });
});

describe('deliverBrowserControlRequest', () => {
  test('includes the target in the emitted SSE properties and reports the reached client ids', () => {
    const { writes, clients, writeSseEvent } = createDelivery();
    clients.add(identified);
    const target = { directory: '/repo', tabId: 'tab-1' };

    const result = deliverBrowserControlRequest({
      request: { requestId: 'req-1', action: 'browser.snapshot', parameters: {}, target },
      clients,
      writeSseEvent,
    });

    expect(result).toEqual({ delivered: 1, eligibleClientIds: ['win-1'] });
    expect(writes[0].payload).toEqual({
      type: 'openchamber:browser-control-request',
      properties: { requestId: 'req-1', action: 'browser.snapshot', parameters: {}, target },
    });
  });

  test('skips a legacy connection for a targeted request but delivers to an identified one', () => {
    const { writes, clients, writeSseEvent } = createDelivery();
    clients.add(legacy);
    clients.add(identified);

    const result = deliverBrowserControlRequest({
      request: { requestId: 'req-2', action: 'browser.snapshot', parameters: {}, target: { directory: '/repo' } },
      clients,
      writeSseEvent,
    });

    expect(result.delivered).toBe(1);
    expect(writes).toHaveLength(1);
    expect(writes[0].client).toBe(identified);
  });

  test('still delivers an untargeted request to a legacy connection', () => {
    const { writes, clients, writeSseEvent } = createDelivery();
    clients.add(legacy);

    const result = deliverBrowserControlRequest({
      request: { requestId: 'req-3', action: 'browser.snapshot', parameters: {} },
      clients,
      writeSseEvent,
    });

    expect(result.delivered).toBe(1);
    expect(result.eligibleClientIds).toEqual([]);
    expect(writes[0].client).toBe(legacy);
  });

  test('keeps the capability split: rich actions need a driving client, opening only needs a panel', () => {
    const { writes, clients, writeSseEvent } = createDelivery();
    const displayOnly = connection({ id: 'win-2', capable: false });
    clients.add(displayOnly);

    const rich = deliverBrowserControlRequest({
      request: { requestId: 'req-4', action: 'browser.click', parameters: { selector: '#a' } },
      clients,
      writeSseEvent,
    });
    const open = deliverBrowserControlRequest({
      request: { requestId: 'req-5', action: 'browser.open', parameters: { url: 'http://a/' } },
      clients,
      writeSseEvent,
    });

    expect(rich.delivered).toBe(0);
    expect(open.delivered).toBe(1);
    expect(writes).toHaveLength(1);
  });

  test('drops a client whose write fails and does not count it', () => {
    const { writes, clients, writeSseEvent } = createDelivery();
    const broken = connection({ id: 'win-3', broken: true });
    clients.add(broken);
    clients.add(legacy);

    const result = deliverBrowserControlRequest({
      request: { requestId: 'req-6', action: 'browser.snapshot', parameters: {} },
      clients,
      writeSseEvent,
    });

    expect(result.delivered).toBe(1);
    expect(clients.has(broken)).toBe(false);
    expect(writes).toHaveLength(1);
  });
});

describe('inventory recorder', () => {
  test('stores only on a matching clientId with a newer revision, and fires only when recorded', () => {
    const clients = new Set([connection({ id: 'win-1' }), connection({ id: 'win-2' })]);
    const recorder = createInventoryRecorder();
    const events = [];
    recorder.onInventoryUpdated(() => events.push('updated'));

    expect(recorder.record(clients, 'win-nope', inventory({ revision: 1 }))).toBe(false);
    expect(events).toEqual([]);

    expect(recorder.record(clients, 'win-1', inventory({ revision: 2, openableDirectory: '/repo' }))).toBe(true);
    expect(events).toEqual(['updated']);
    const stored = [...clients].find((client) => client.openchamberClientId === 'win-1').browserControlInventory;
    expect(stored.openableDirectory).toBe('/repo');

    // A stale or repeated revision never overwrites a newer one.
    expect(recorder.record(clients, 'win-1', inventory({ revision: 2, openableDirectory: '/other' }))).toBe(false);
    expect(recorder.record(clients, 'win-1', inventory({ revision: 1 }))).toBe(false);
    expect(stored.openableDirectory).toBe('/repo');
    expect(events).toEqual(['updated']);

    expect(recorder.record(clients, 'win-1', inventory({ revision: 3, openableDirectory: '/other' }))).toBe(true);
    const updated = [...clients].find((client) => client.openchamberClientId === 'win-1').browserControlInventory;
    expect(updated.openableDirectory).toBe('/other');
    expect(events).toEqual(['updated', 'updated']);
  });

  test('stops firing when the listener unsubscribes', () => {
    const clients = new Set([connection({ id: 'win-1' })]);
    const recorder = createInventoryRecorder();
    const events = [];
    const unsubscribe = recorder.onInventoryUpdated(() => events.push('updated'));

    unsubscribe();
    recorder.record(clients, 'win-1', inventory({ revision: 1 }));
    expect(events).toEqual([]);
  });

  test('hasConnectionAwaitingInventory only counts identified connections without an inventory', () => {
    const pending = connection({ id: 'win-new' });
    const reported = connection({ id: 'win-old', inventory: inventory() });
    const legacyClient = connection({ id: null });

    expect(hasConnectionAwaitingInventory(new Set([pending]))).toBe(true);
    expect(hasConnectionAwaitingInventory(new Set([reported, legacyClient]))).toBe(false);
    expect(hasConnectionAwaitingInventory(new Set())).toBe(false);
  });
});


describe('deliverBrowserControlCancel', () => {
  test('writes the cancel only to connections in the eligible set, carrying only the request id', () => {
    const { writes, clients, writeSseEvent } = createDelivery();
    const eligibleOne = connection({ id: 'win-1' });
    const other = connection({ id: 'win-2' });
    const eligibleThree = connection({ id: 'win-3' });
    clients.add(eligibleOne);
    clients.add(other);
    clients.add(eligibleThree);

    deliverBrowserControlCancel({
      requestId: 'req-1',
      eligibleClientIds: ['win-1', 'win-3'],
      clients,
      writeSseEvent,
    });

    expect(writes.map((write) => write.client)).toEqual([eligibleOne, eligibleThree]);
    // The payload carries exactly the request id: the claim token never
    // travels over the broadcast.
    for (const write of writes) {
      expect(write.payload).toEqual({
        type: 'openchamber:browser-control-cancel',
        properties: { requestId: 'req-1' },
      });
    }
  });

  test('drops a connection whose cancel write fails', () => {
    const { clients, writeSseEvent } = createDelivery();
    const broken = connection({ id: 'win-1', broken: true });
    clients.add(broken);

    deliverBrowserControlCancel({
      requestId: 'req-1',
      eligibleClientIds: ['win-1'],
      clients,
      writeSseEvent,
    });

    expect(clients.has(broken)).toBe(false);
  });
});