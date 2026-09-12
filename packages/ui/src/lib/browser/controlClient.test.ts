import { afterEach, beforeEach, describe, expect, mock, test } from 'bun:test';

type RequestTarget = {
  directory?: unknown;
  tabId?: unknown;
  openCodeSessionId?: unknown;
};

type Listener = (event: {
  type: string;
  requestId: string;
  action?: string;
  parameters?: Record<string, unknown>;
  target?: RequestTarget;
}) => void;

const posted: Array<{ requestId: string; ok: boolean; data?: unknown; error?: string }> = [];
const claims: string[] = [];
const claimBodies: Array<{ requestId?: string; clientId?: string }> = [];
/** Flipped to false to play the client that lost the race for a request. */
let grantClaims = true;
/** Holds the claim response back so a cancel can land while the claim is on the wire. */
let claimBlocker: Promise<void> | null = null;
let listener: Listener | null = null;

mock.module('@/lib/runtime-fetch', () => ({
  runtimeFetch: mock(async (path: string, init?: { body?: string }) => {
    const body = JSON.parse(init?.body ?? '{}');
    if (path.endsWith('/claim')) {
      claims.push(body.requestId);
      claimBodies.push(body);
      if (claimBlocker) await claimBlocker;
      return {
        ok: true,
        status: 200,
        json: async () => (grantClaims
          ? { granted: true, claimToken: `tok-${body.requestId}` }
          : { granted: false }),
      };
    }
    // The inventory publisher shares this transport; its posts are not results.
    if (path.endsWith('/inventory')) {
      return { ok: true, status: 200, json: async () => ({ recorded: true }) };
    }
    posted.push(body);
    return { ok: true, status: 200 };
  }),
}));
mock.module('@/lib/openchamberEvents', () => ({
  subscribeOpenchamberEvents: (handler: Listener) => {
    listener = handler;
    return () => { listener = null; };
  },
  getBrowserControlClientId: () => 'win-test',
  subscribeEventStreamReady: () => () => undefined,
  isEventStreamConnected: () => false,
}));

const {
  getActiveBrowserTarget,
  registerBrowserController,
  registerBrowserOpener,
  setActiveBrowserTarget,
  serializeBrowserControllerKey,
  subscribeBrowserControlState,
} = await import('./controlClient');

/** Registrations are module-global, so every test unwinds its own. */
const cleanups: Array<() => void> = [];

const keyA = { runtimeKey: 'runtime', directory: '/proj', tabId: 'tab-a' };
const keyB = { runtimeKey: 'runtime', directory: '/proj', tabId: 'tab-b' };

const emitOpen = (parameters: Record<string, unknown>, target?: RequestTarget): void => {
  listener?.({
    type: 'browser-control-request',
    requestId: 'req-1',
    action: 'browser.open',
    parameters,
    ...(target ? { target } : {}),
  });
};

const emitRequest = (event: {
  requestId?: string;
  action?: string;
  parameters?: Record<string, unknown>;
  target?: RequestTarget;
}): void => {
  listener?.({
    type: 'browser-control-request',
    requestId: event.requestId ?? 'req-1',
    action: event.action ?? 'browser.click',
    parameters: event.parameters ?? {},
    ...(event.target ? { target: event.target } : {}),
  });
};

const wait = (ms: number): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms));

const emitCancel = (requestId: string): void => {
  listener?.({ type: 'browser-control-cancel', requestId });
};

describe('opening a page before any view exists', () => {
  beforeEach(() => {
    posted.length = 0;
    claims.length = 0;
    claimBodies.length = 0;
    grantClaims = true;
    claims.length = 0;
    grantClaims = true;
  });

  afterEach(() => {
    setActiveBrowserTarget(null);
    while (cleanups.length > 0) cleanups.pop()?.();
  });

  test('lets the view that the open created apply the layout that was asked for', async () => {
    const opened: string[] = [];
    const ran: Array<{ action: string; parameters: Record<string, unknown> }> = [];

    cleanups.push(registerBrowserOpener('/proj', (url) => {
      opened.push(url);
      // The pane mounts a moment after the tab is created, as it does in the app.
      setTimeout(() => {
        cleanups.push(registerBrowserController(keyA, {
          run: async (action, parameters) => {
            ran.push({ action, parameters });
            return { viewport: { mode: 'mobile', width: 390, height: 844 } };
          },
        }));
      }, 120);
      return { tabId: keyA.tabId };
    }));

    emitOpen({ url: 'https://example.test', viewport: 'mobile' }, { directory: '/proj' });
    await wait(400);

    expect(opened).toEqual(['https://example.test']);
    expect(ran).toEqual([{ action: 'browser.resize', parameters: { viewport: 'mobile' } }]);
    expect(posted[0]?.data).toEqual({
      url: 'https://example.test',
      opened: true,
      tabId: 'tab-a',
      viewportApplied: true,
      viewport: { mode: 'mobile', width: 390, height: 844 },
      target: { directory: '/proj', tabId: 'tab-a' },
      richControl: true,
    });
  });

  test('does nothing at all when another client was granted the request', async () => {
    grantClaims = false;
    const opened: string[] = [];
    const ran: string[] = [];
    cleanups.push(registerBrowserOpener('/proj', (url) => { opened.push(url); return { tabId: 'tab-new' }; }));
    cleanups.push(registerBrowserController(keyA, {
      run: async (action) => { ran.push(action); return {}; },
    }));

    emitOpen({ url: 'https://example.test' }, { directory: '/proj' });
    await wait(50);

    expect(claims).toEqual(['req-1']);
    // The losing client must not act: a late result cannot undo a click.
    expect(ran).toEqual([]);
    expect(opened).toEqual([]);
    expect(posted).toEqual([]);
  });

  test('claims the request before touching a page', async () => {
    const ran: string[] = [];
    cleanups.push(registerBrowserController(keyA, {
      run: async (action) => { ran.push(action); return {}; },
    }));
    setActiveBrowserTarget(keyA);

    emitRequest({ action: 'browser.click', parameters: { selector: 'button' } });
    await wait(50);

    expect(claims).toEqual(['req-1']);
    expect(ran).toEqual(['browser.click']);
  });

  test('does not wait for a view when no layout was requested', async () => {
    cleanups.push(registerBrowserOpener('/proj', () => ({ tabId: 'tab-new' })));

    emitOpen({ url: 'https://example.test' }, { directory: '/proj' });
    await wait(20);

    expect(posted[0]?.data).toEqual({
      url: 'https://example.test',
      opened: true,
      tabId: 'tab-new',
      target: { directory: '/proj', tabId: 'tab-new' },
      richControl: false,
    });
  });

  test('says the layout was not applied when no view ever appears', async () => {
    cleanups.push(registerBrowserOpener('/proj', () => ({ tabId: 'tab-missing' })));

    emitOpen({ url: 'https://example.test', viewport: 'mobile' }, { directory: '/proj' });
    // Past the client's own attach deadline.
    await wait(2_400);

    const data = posted[0]?.data as { tabId?: string; viewportApplied?: boolean; note?: string; richControl?: boolean; target?: unknown };
    expect(data.tabId).toBe('tab-missing');
    expect(data.viewportApplied).toBe(false);
    expect(typeof data.note).toBe('string');
    expect(data.richControl).toBe(false);
    expect(data.target).toEqual({ directory: '/proj', tabId: 'tab-missing' });
  });
});

describe('routing requests through the keyed registry', () => {
  beforeEach(() => {
    posted.length = 0;
    claims.length = 0;
    claimBodies.length = 0;
    grantClaims = true;
    claims.length = 0;
    grantClaims = true;
  });

  afterEach(() => {
    setActiveBrowserTarget(null);
    while (cleanups.length > 0) cleanups.pop()?.();
  });

  /** Registers a pane that records the actions it ran. */
  const registerPane = (key: typeof keyA, ran: string[]): (() => void) => (
    registerBrowserController(key, {
      run: async (action) => { ran.push(action); return { ok: true }; },
    })
  );

  test('routes an event-stream request to the controller its target names, not the latest registration', async () => {
    const ranA: string[] = [];
    const ranB: string[] = [];
    cleanups.push(registerPane(keyA, ranA));
    cleanups.push(registerPane(keyB, ranB));
    setActiveBrowserTarget(keyA);

    // B registered last, so the old singleton would have run this against A's
    // replacement. The target on the request must win over registration order.
    emitRequest({ requestId: 'req-b', target: { directory: '/proj', tabId: 'tab-b' } });
    await wait(50);

    expect(ranB).toEqual(['browser.click']);
    expect(ranA).toEqual([]);
    expect(claims).toEqual(['req-b']);
    expect(posted[0]?.ok).toBe(true);
  });

  test('does not claim or run a request whose target names an unknown tab', async () => {
    const ranA: string[] = [];
    const ranB: string[] = [];
    cleanups.push(registerPane(keyA, ranA));
    cleanups.push(registerPane(keyB, ranB));
    setActiveBrowserTarget(keyA);

    emitRequest({ requestId: 'req-c', target: { directory: '/proj', tabId: 'tab-unknown' } });
    await wait(50);

    expect(ranA).toEqual([]);
    expect(ranB).toEqual([]);
    // Acting without a grant is prevented by never asking for one here.
    expect(claims).toEqual([]);
    expect(posted).toEqual([]);
  });

  test('routes a tab-less request through the active target, never registration order', async () => {
    const ranA: string[] = [];
    const ranB: string[] = [];
    cleanups.push(registerPane(keyA, ranA));
    cleanups.push(registerPane(keyB, ranB));
    setActiveBrowserTarget(keyA);

    emitRequest({ requestId: 'req-active' });
    await wait(50);

    expect(ranA).toEqual(['browser.click']);
    expect(ranB).toEqual([]);
    expect(claims).toEqual(['req-active']);
  });

  test('re-routes when the active target changes, without remounting', async () => {
    const ranA: string[] = [];
    const ranB: string[] = [];
    cleanups.push(registerPane(keyA, ranA));
    cleanups.push(registerPane(keyB, ranB));
    setActiveBrowserTarget(keyA);

    emitRequest({ requestId: 'req-1' });
    await wait(50);
    setActiveBrowserTarget(keyB);
    emitRequest({ requestId: 'req-2' });
    await wait(50);

    expect(ranA).toEqual(['browser.click']);
    expect(ranB).toEqual(['browser.click']);
    expect(getActiveBrowserTarget()).toEqual(keyB);
  });

  test('does not claim a tab-less request when no active target is set', async () => {
    // The interim last-registered fallback is gone: with no explicit active
    // target, a tab-less request matches nothing and is never claimed.
    const ranA: string[] = [];
    const ranB: string[] = [];
    cleanups.push(registerPane(keyA, ranA));
    cleanups.push(registerPane(keyB, ranB));
    setActiveBrowserTarget(keyA);
    setActiveBrowserTarget(null);

    emitRequest({ requestId: 'req-no-target' });
    await wait(50);

    expect(ranA).toEqual([]);
    expect(ranB).toEqual([]);
    expect(claims).toEqual([]);
    expect(posted).toEqual([]);
  });

  test('clears the active target when its controller unregisters, without silently retargeting', async () => {
    const ranA: string[] = [];
    const ranB: string[] = [];
    const unregisterA = registerPane(keyA, ranA);
    cleanups.push(registerPane(keyB, ranB));
    setActiveBrowserTarget(keyA);

    unregisterA();
    expect(getActiveBrowserTarget()).toBe(null);

    emitRequest({ requestId: 'req-after-unregister' });
    await wait(50);

    // No silent fall-through to the remaining registration.
    expect(ranA).toEqual([]);
    expect(ranB).toEqual([]);
    expect(claims).toEqual([]);

    setActiveBrowserTarget(keyB);
    emitRequest({ requestId: 'req-new-target' });
    await wait(50);

    expect(ranB).toEqual(['browser.click']);
    expect(claims).toEqual(['req-new-target']);
  });

  test('treats a malformed request target as absent instead of throwing', async () => {
    const ranA: string[] = [];
    cleanups.push(registerPane(keyA, ranA));
    setActiveBrowserTarget(keyA);

    // A non-string directory is dropped, leaving a target-less request that
    // resolves through the active target like any other.
    emitRequest({ requestId: 'req-malformed', target: { directory: 42 } });
    await wait(50);

    expect(ranA).toEqual(['browser.click']);
    expect(posted[0]?.ok).toBe(true);
  });

  test('a stale unmount does not detach a newer registration for the same key', async () => {
    const ranFirst: string[] = [];
    const ranSecond: string[] = [];
    const unregisterFirst = registerBrowserController(keyA, {
      run: async (action) => { ranFirst.push(action); return {}; },
    });
    cleanups.push(registerBrowserController(keyA, {
      run: async (action) => { ranSecond.push(action); return {}; },
    }));
    setActiveBrowserTarget(keyA);

    // The first effect's cleanup arrives late, after the pane re-registered.
    unregisterFirst();
    emitRequest({ requestId: 'req-stale' });
    await wait(50);

    expect(ranSecond).toEqual(['browser.click']);
    expect(ranFirst).toEqual([]);
  });

  test('notifies state subscribers on register, opener, unregister, and active-target changes', () => {
    let notifications = 0;
    const unsubscribeState = subscribeBrowserControlState(() => { notifications += 1; });

    const unregisterPane = registerBrowserController(keyA, { run: async () => ({}) });
    expect(notifications).toBe(1);
    const unregisterOpener = registerBrowserOpener('/proj', () => ({ tabId: 'tab-x' }));
    expect(notifications).toBe(2);
    setActiveBrowserTarget(keyA);
    expect(notifications).toBe(3);
    // Re-setting the same target is not a mutation.
    setActiveBrowserTarget(keyA);
    expect(notifications).toBe(3);

    unregisterPane();
    expect(notifications).toBe(4);
    unregisterOpener();
    expect(notifications).toBe(5);
    unsubscribeState();
  });
});

describe('enforcing request scope', () => {
  beforeEach(() => {
    posted.length = 0;
    claims.length = 0;
    claimBodies.length = 0;
    grantClaims = true;
    claims.length = 0;
    grantClaims = true;
  });

  afterEach(() => {
    setActiveBrowserTarget(null);
    while (cleanups.length > 0) cleanups.pop()?.();
  });

  /** Registers a pane that records the actions it ran. */
  const registerPane = (key: typeof keyA, ran: string[]): (() => void) => (
    registerBrowserController(key, {
      run: async (action) => { ran.push(action); return { ok: true }; },
    })
  );

  test('claims a tab-less open for the opener\'s directory and reports the tab it opened', async () => {
    const opened: string[] = [];
    cleanups.push(registerBrowserOpener('/proj', (url) => { opened.push(url); return { tabId: 'tab-new' }; }));

    emitOpen({ url: 'https://example.test' }, { directory: '/proj' });
    await wait(50);

    expect(claims).toEqual(['req-1']);
    expect(opened).toEqual(['https://example.test']);
    expect(posted[0]?.data).toEqual({
      url: 'https://example.test',
      opened: true,
      tabId: 'tab-new',
      target: { directory: '/proj', tabId: 'tab-new' },
      richControl: false,
    });
  });

  test('reports an honest failure when the opener cannot open the tab', async () => {
    cleanups.push(registerBrowserOpener('/proj', () => null));

    emitOpen({ url: 'https://example.test' }, { directory: '/proj' });
    await wait(50);

    // The claim was legitimate — the opener matched the scope — but no tab
    // exists, so the result must say so instead of inventing a tab id.
    expect(claims).toEqual(['req-1']);
    expect(posted[0]?.ok).toBe(false);
    expect(typeof posted[0]?.error).toBe('string');
    // No tab exists to name: the scope is reported, and no tab id is invented.
    expect(posted[0]?.data).toEqual({ target: { directory: '/proj' } });
  });

  test('an open naming a tab runs through its controller and never touches the opener', async () => {
    const opened: string[] = [];
    const ranA: string[] = [];
    cleanups.push(registerBrowserOpener('/proj', (url) => { opened.push(url); return { tabId: 'tab-new' }; }));
    cleanups.push(registerPane(keyA, ranA));

    emitOpen({ url: 'https://example.test' }, { directory: '/proj', tabId: 'tab-a' });
    await wait(50);

    expect(ranA).toEqual(['browser.open']);
    expect(opened).toEqual([]);
    expect(claims).toEqual(['req-1']);
    expect(posted[0]?.ok).toBe(true);
    // Served by the tab's own controller: rich control is available.
    const data = posted[0]?.data as { target?: unknown; richControl?: boolean };
    expect(data.target).toEqual({ directory: '/proj', tabId: 'tab-a' });
    expect(data.richControl).toBe(true);
  });

  test('a tab-less open with a controller already in scope navigates it instead of opening a new tab', async () => {
    const opened: string[] = [];
    const ranA: string[] = [];
    cleanups.push(registerBrowserOpener('/proj', (url) => { opened.push(url); return { tabId: 'tab-new' }; }));
    cleanups.push(registerPane(keyA, ranA));
    setActiveBrowserTarget(keyA);

    emitOpen({ url: 'https://example.test' }, { directory: '/proj' });
    await wait(50);

    expect(ranA).toEqual(['browser.open']);
    expect(opened).toEqual([]);
  });

  test('does not claim an open for a directory with no opener and no controller', async () => {
    const opened: string[] = [];
    const ranA: string[] = [];
    cleanups.push(registerBrowserOpener('/proj', (url) => { opened.push(url); return { tabId: 'tab-new' }; }));
    cleanups.push(registerPane(keyA, ranA));

    emitOpen({ url: 'https://example.test' }, { directory: '/elsewhere' });
    await wait(50);

    expect(claims).toEqual([]);
    expect(opened).toEqual([]);
    expect(ranA).toEqual([]);
    expect(posted).toEqual([]);
  });

  test('does not claim a rich action for a directory with no controller in scope', async () => {
    const ranA: string[] = [];
    cleanups.push(registerPane(keyA, ranA));
    setActiveBrowserTarget(keyA);

    emitRequest({ requestId: 'req-scope', action: 'browser.click', target: { directory: '/elsewhere' } });
    await wait(50);

    // The active target is in '/proj'; a request scoped elsewhere must not
    // reach it, and acting without a grant is prevented by never asking.
    expect(ranA).toEqual([]);
    expect(claims).toEqual([]);
    expect(posted).toEqual([]);
  });

  test('does not claim a directory-scoped tab-less request with no active target', async () => {
    const ranA: string[] = [];
    const ranOther: string[] = [];
    cleanups.push(registerPane(keyA, ranA));
    cleanups.push(registerPane({ runtimeKey: 'runtime', directory: '/other', tabId: 'tab-c' }, ranOther));

    emitRequest({ requestId: 'req-scoped-no-target', action: 'browser.click', target: { directory: '/proj' } });
    await wait(50);

    // The fallback is gone: an active target is the only way a tab-less
    // request resolves, and none is set here.
    expect(ranA).toEqual([]);
    expect(ranOther).toEqual([]);
    expect(claims).toEqual([]);
  });

  test('matches directories canonically: duplicate separators, trailing slashes, backslashes', async () => {
    const opened: string[] = [];
    const ranDup: string[] = [];
    const ranWin: string[] = [];
    // The opener registers a messy directory; requests arrive canonicalized.
    cleanups.push(registerBrowserOpener('/proj//sub/', (url) => { opened.push(url); return { tabId: 'tab-sub' }; }));
    cleanups.push(registerPane({ runtimeKey: 'runtime', directory: '/proj/dup', tabId: 'tab-dup' }, ranDup));
    // A Windows-style registration matches the server's canonical form.
    cleanups.push(registerPane({ runtimeKey: 'runtime', directory: 'C:\\proj\\', tabId: 'tab-win' }, ranWin));

    emitOpen({ url: 'https://example.test' }, { directory: '/proj/sub' });
    // Duplicate separators and a trailing slash on the request collapse to the
    // registration's key.
    emitRequest({ requestId: 'req-dup', action: 'browser.click', target: { directory: '/proj//dup/', tabId: 'tab-dup' } });
    emitRequest({ requestId: 'req-win', action: 'browser.click', target: { directory: 'C:/proj', tabId: 'tab-win' } });
    await wait(50);

    expect(opened).toEqual(['https://example.test']);
    expect(ranDup).toEqual(['browser.click']);
    expect(ranWin).toEqual(['browser.click']);
    expect(claims).toEqual(['req-1', 'req-dup', 'req-win']);
  });

  test('re-registering the opener for another directory leaves no stale entry behind', async () => {
    const openedA: string[] = [];
    const openedB: string[] = [];
    const unregisterA = registerBrowserOpener('/a', (url) => { openedA.push(url); return { tabId: 'tab-a1' }; });
    // The panel effect re-runs when the directory changes: cleanup of A, then B.
    unregisterA();
    cleanups.push(registerBrowserOpener('/b', (url) => { openedB.push(url); return { tabId: 'tab-b1' }; }));

    emitOpen({ url: 'https://a.test' }, { directory: '/a' });
    await wait(20);
    emitRequest({ requestId: 'req-b', action: 'browser.open', parameters: { url: 'https://b.test' }, target: { directory: '/b' } });
    await wait(50);

    expect(openedA).toEqual([]);
    expect(claims).toEqual(['req-b']);
    expect(openedB).toEqual(['https://b.test']);
  });

  test('does not claim an open naming an unknown tab, even with an opener for the directory', async () => {
    const opened: string[] = [];
    cleanups.push(registerBrowserOpener('/proj', (url) => { opened.push(url); return { tabId: 'tab-new' }; }));

    emitOpen({ url: 'https://example.test' }, { directory: '/proj', tabId: 'tab-unknown' });
    await wait(50);

    // Opening WITH a tab id navigates an existing tab; the opener creates one,
    // so it must never serve this path.
    expect(claims).toEqual([]);
    expect(opened).toEqual([]);
    expect(posted).toEqual([]);
  });

  test('does not claim a tab-less open that names no directory', async () => {
    const opened: string[] = [];
    cleanups.push(registerBrowserOpener('/proj', (url) => { opened.push(url); return { tabId: 'tab-new' }; }));

    // The server scopes every request; one without a directory matches no
    // opener, by contract.
    emitOpen({ url: 'https://example.test' });
    await wait(50);

    expect(claims).toEqual([]);
    expect(opened).toEqual([]);
    expect(posted).toEqual([]);
  });
});

describe('coordinating agent operations at dispatch', () => {
  beforeEach(() => {
    posted.length = 0;
    claims.length = 0;
    claimBodies.length = 0;
    grantClaims = true;
    claims.length = 0;
    grantClaims = true;
  });

  afterEach(() => {
    setActiveBrowserTarget(null);
    while (cleanups.length > 0) cleanups.pop()?.();
  });

  test('serializes two mutating requests on one tab, never running them concurrently', async () => {
    const order: string[] = [];
    let active = 0;
    let maxActive = 0;
    cleanups.push(registerBrowserController(keyA, {
      run: async (_action, parameters) => {
        active += 1;
        maxActive = Math.max(maxActive, active);
        const selector = String(parameters.selector ?? '');
        order.push(`start-${selector}`);
        await wait(30);
        order.push(`end-${selector}`);
        active -= 1;
        return {};
      },
    }));

    // If the coordinator were applied twice at dispatch, the inner entry
    // would queue behind the outer one forever and this test would time out.
    emitRequest({ requestId: 'req-1', action: 'browser.click', parameters: { selector: 'one' }, target: { directory: '/proj', tabId: 'tab-a' } });
    emitRequest({ requestId: 'req-2', action: 'browser.click', parameters: { selector: 'two' }, target: { directory: '/proj', tabId: 'tab-a' } });
    await wait(150);

    expect(maxActive).toBe(1);
    expect(order).toEqual(['start-one', 'end-one', 'start-two', 'end-two']);
    expect(posted.map((entry) => entry.requestId)).toEqual(['req-1', 'req-2']);
  });

  test('lets a read-only snapshot through while a mutating op holds the tab', async () => {
    let releaseClick!: () => void;
    const clickGate = new Promise<void>((resolve) => { releaseClick = resolve; });
    cleanups.push(registerBrowserController(keyA, {
      run: async (action) => {
        if (action === 'browser.click') await clickGate;
        return { action };
      },
    }));

    emitRequest({ requestId: 'req-click', action: 'browser.click', target: { directory: '/proj', tabId: 'tab-a' } });
    await wait(20);
    emitRequest({ requestId: 'req-snapshot', action: 'browser.snapshot', target: { directory: '/proj', tabId: 'tab-a' } });
    await wait(30);

    // The snapshot answered while the click still holds the tab's queue.
    expect(posted.some((entry) => entry.requestId === 'req-snapshot' && entry.ok)).toBe(true);
    expect(posted.some((entry) => entry.requestId === 'req-click')).toBe(false);

    releaseClick();
    await wait(30);
    expect(posted.some((entry) => entry.requestId === 'req-click' && entry.ok)).toBe(true);
  });

  test('runs mutating ops on different tabs in parallel', async () => {
    let releaseA!: () => void;
    const gateA = new Promise<void>((resolve) => { releaseA = resolve; });
    cleanups.push(registerBrowserController(keyA, {
      run: async () => { await gateA; return {}; },
    }));
    cleanups.push(registerBrowserController(keyB, {
      run: async () => ({}),
    }));

    emitRequest({ requestId: 'req-a', action: 'browser.click', target: { directory: '/proj', tabId: 'tab-a' } });
    emitRequest({ requestId: 'req-b', action: 'browser.click', target: { directory: '/proj', tabId: 'tab-b' } });
    await wait(50);

    expect(posted.some((entry) => entry.requestId === 'req-b' && entry.ok)).toBe(true);
    expect(posted.some((entry) => entry.requestId === 'req-a')).toBe(false);

    releaseA();
    await wait(30);
    expect(posted.some((entry) => entry.requestId === 'req-a' && entry.ok)).toBe(true);
  });

  test('serializes two concurrent no-tab opens for one directory under the opener key', async () => {
    const opened: string[] = [];
    cleanups.push(registerBrowserOpener('/proj', (url) => {
      opened.push(url);
      return { tabId: `tab-${opened.length}` };
    }));

    emitRequest({ requestId: 'req-1', action: 'browser.open', parameters: { url: 'https://a.test' }, target: { directory: '/proj' } });
    emitRequest({ requestId: 'req-2', action: 'browser.open', parameters: { url: 'https://b.test' }, target: { directory: '/proj' } });
    await wait(50);

    expect(opened).toEqual(['https://a.test', 'https://b.test']);
    expect(posted.map((entry) => entry.requestId)).toEqual(['req-1', 'req-2']);
  });

  test('surfaces the conflict error when a user action lands while a mutating op runs', async () => {
    const { noteUserAction } = await import('./controlCoordinator');
    let releaseClick!: () => void;
    const clickGate = new Promise<string>((resolve) => { releaseClick = () => resolve('clicked'); });
    cleanups.push(registerBrowserController(keyA, {
      run: async () => clickGate,
    }));

    emitRequest({ requestId: 'req-click', action: 'browser.click', target: { directory: '/proj', tabId: 'tab-a' } });
    await wait(20);
    noteUserAction(serializeBrowserControllerKey(keyA));
    releaseClick();
    await wait(30);

    expect(posted[0]?.requestId).toBe('req-click');
    expect(posted[0]?.ok).toBe(false);
    expect(posted[0]?.error).toBe('The user interacted with this tab while the action ran; retry the action');
  });
});


describe('server-cancelled requests', () => {
  beforeEach(() => {
    posted.length = 0;
    claims.length = 0;
    claimBodies.length = 0;
    grantClaims = true;
    claimBlocker = null;
  });

  afterEach(() => {
    setActiveBrowserTarget(null);
    while (cleanups.length > 0) cleanups.pop()?.();
  });

  test('claims with this client\'s id and binds the result to the returned claim token', async () => {
    cleanups.push(registerBrowserController(keyA, {
      run: async () => ({ done: true }),
    }));
    setActiveBrowserTarget(keyA);

    emitRequest({ requestId: 'req-1', action: 'browser.snapshot' });
    await wait(50);

    expect(claimBodies).toEqual([{ requestId: 'req-1', clientId: 'win-test' }]);
    expect(posted[0]?.requestId).toBe('req-1');
    expect((posted[0] as { claimToken?: string }).claimToken).toBe('tok-req-1');
  });

  test('drops queued work and clears the controlling flag when a claimed request is cancelled', async () => {
    const { isAgentControlling } = await import('./controlCoordinator');
    const ran: string[] = [];
    let releaseClick!: () => void;
    const clickGate = new Promise<void>((resolve) => { releaseClick = resolve; });
    cleanups.push(registerBrowserController(keyA, {
      run: async (action) => { ran.push(action); await clickGate; return {}; },
    }));

    const key = serializeBrowserControllerKey(keyA);
    emitRequest({ requestId: 'req-1', action: 'browser.click', target: { directory: '/proj', tabId: 'tab-a' } });
    emitRequest({ requestId: 'req-2', action: 'browser.click', target: { directory: '/proj', tabId: 'tab-a' } });
    await wait(30);
    expect(claims).toEqual(['req-1', 'req-2']);
    expect(isAgentControlling(key)).toBe(true);

    emitCancel('req-1');
    expect(isAgentControlling(key)).toBe(false);

    releaseClick();
    await wait(30);

    // req-1's in-flight result is discarded, never posted; req-2's queued op
    // was dropped without running and that failure is still reported.
    expect(ran).toEqual(['browser.click']);
    expect(posted.some((entry) => entry.requestId === 'req-1')).toBe(false);
    const dropped = posted.find((entry) => entry.requestId === 'req-2');
    expect(dropped?.ok).toBe(false);
    expect(dropped?.error).toBe('The queued action was dropped');
  });

  test('ignores a cancel for a request this client did not claim', async () => {
    const { isAgentControlling } = await import('./controlCoordinator');
    let releaseClick!: () => void;
    const clickGate = new Promise<void>((resolve) => { releaseClick = resolve; });
    cleanups.push(registerBrowserController(keyA, {
      run: async () => { await clickGate; return { clicked: true }; },
    }));

    const key = serializeBrowserControllerKey(keyA);
    emitRequest({ requestId: 'req-1', action: 'browser.click', target: { directory: '/proj', tabId: 'tab-a' } });
    await wait(30);

    emitCancel('req-claimed-elsewhere');
    expect(isAgentControlling(key)).toBe(true);

    releaseClick();
    await wait(30);
    expect(posted.some((entry) => entry.requestId === 'req-1' && entry.ok)).toBe(true);
  });

  test('discards an in-flight read-only result when its request is cancelled', async () => {
    let releaseSnapshot!: () => void;
    const snapshotGate = new Promise<void>((resolve) => { releaseSnapshot = resolve; });
    cleanups.push(registerBrowserController(keyA, {
      run: async () => { await snapshotGate; return { url: 'http://a/' }; },
    }));

    emitRequest({ requestId: 'req-snap', action: 'browser.snapshot', target: { directory: '/proj', tabId: 'tab-a' } });
    await wait(30);

    emitCancel('req-snap');
    releaseSnapshot();
    await wait(30);

    expect(posted.some((entry) => entry.requestId === 'req-snap')).toBe(false);
  });

  test('honors a cancel that arrives while the claim is still in flight', async () => {
    const ran: string[] = [];
    let releaseClaim!: () => void;
    claimBlocker = new Promise<void>((resolve) => { releaseClaim = resolve; });
    cleanups.push(registerBrowserController(keyA, {
      run: async (action) => { ran.push(action); return {}; },
    }));

    emitRequest({ requestId: 'req-1', action: 'browser.click', target: { directory: '/proj', tabId: 'tab-a' } });
    await wait(10);
    // The server granted and then settled the request before our claim
    // response came back: the cancel must not be lost with it.
    emitCancel('req-1');
    releaseClaim();
    await wait(30);

    expect(claims).toEqual(['req-1']);
    expect(ran).toEqual([]);
    expect(posted).toEqual([]);
  });
});


describe('target identity on every result', () => {
  beforeEach(() => {
    posted.length = 0;
    claims.length = 0;
    claimBodies.length = 0;
    grantClaims = true;
  });

  afterEach(() => {
    setActiveBrowserTarget(null);
    while (cleanups.length > 0) cleanups.pop()?.();
  });

  test('names the tab that served a tab-named action', async () => {
    cleanups.push(registerBrowserController(keyB, {
      run: async () => ({ clicked: true }),
    }));

    emitRequest({ requestId: 'req-named', action: 'browser.click', target: { directory: '/proj', tabId: 'tab-b' } });
    await wait(50);

    expect(posted[0]?.ok).toBe(true);
    expect((posted[0]?.data as { target?: unknown }).target).toEqual({ directory: '/proj', tabId: 'tab-b' });
  });

  test('names the resolved active tab on a tab-less success', async () => {
    cleanups.push(registerBrowserController(keyA, { run: async () => ({}) }));
    cleanups.push(registerBrowserController(keyB, { run: async () => ({ clicked: true }) }));
    setActiveBrowserTarget(keyB);

    emitRequest({ requestId: 'req-active-ok', action: 'browser.click' });
    await wait(50);

    expect(posted[0]?.ok).toBe(true);
    expect((posted[0]?.data as { target?: unknown }).target).toEqual({ directory: '/proj', tabId: 'tab-b' });
  });

  test('a tab-less failure names the resolved active tab it ran against', async () => {
    cleanups.push(registerBrowserController(keyA, { run: async () => ({}) }));
    cleanups.push(registerBrowserController(keyB, {
      run: async () => { throw new Error('The page returned no result'); },
    }));
    setActiveBrowserTarget(keyB);

    // No target at all: the request runs against the visible tab, B.
    emitRequest({ requestId: 'req-active-fail', action: 'browser.click' });
    await wait(50);

    expect(posted[0]?.ok).toBe(false);
    expect(posted[0]?.error).toBe('The page returned no result');
    expect((posted[0]?.data as { target?: unknown }).target).toEqual({ directory: '/proj', tabId: 'tab-b' });
  });

  test('browser.tabs lists the scope\'s tabs with the active one marked, without driving a page', async () => {
    const ran: string[] = [];
    cleanups.push(registerBrowserController(keyA, {
      run: async (action) => { ran.push(action); return {}; },
      getInfo: () => ({ tabId: 'tab-a', url: 'http://a/', title: 'A' }),
    }));
    cleanups.push(registerBrowserController(keyB, {
      run: async (action) => { ran.push(action); return {}; },
      getInfo: () => ({ tabId: 'tab-b', url: 'http://b/', title: 'B' }),
    }));
    setActiveBrowserTarget(keyB);

    emitRequest({ requestId: 'req-tabs', action: 'browser.tabs', target: { directory: '/proj' } });
    await wait(50);

    // Read-only: no controller ran, but the request was still claimed.
    expect(ran).toEqual([]);
    expect(claims).toEqual(['req-tabs']);
    expect(posted[0]?.ok).toBe(true);
    const data = posted[0]?.data as { tabs?: unknown; target?: unknown };
    expect(data.tabs).toEqual([
      { tabId: 'tab-a', url: 'http://a/', title: 'A', active: false },
      { tabId: 'tab-b', url: 'http://b/', title: 'B', active: true },
    ]);
    expect(data.target).toEqual({ directory: '/proj' });
  });

  test('browser.tabs is not claimed for a directory with no controller in scope', async () => {
    const ran: string[] = [];
    cleanups.push(registerBrowserController(keyA, {
      run: async (action) => { ran.push(action); return {}; },
    }));
    setActiveBrowserTarget(keyA);

    emitRequest({ requestId: 'req-tabs-elsewhere', action: 'browser.tabs', target: { directory: '/elsewhere' } });
    await wait(50);

    expect(claims).toEqual([]);
    expect(posted).toEqual([]);
  });

  test('browser.tabs answers while a mutating op holds a tab', async () => {
    let releaseClick!: () => void;
    const clickGate = new Promise<void>((resolve) => { releaseClick = resolve; });
    cleanups.push(registerBrowserController(keyA, {
      run: async (action) => {
        if (action === 'browser.click') await clickGate;
        return {};
      },
      getInfo: () => ({ tabId: 'tab-a', url: 'http://a/', title: 'A' }),
    }));

    emitRequest({ requestId: 'req-click', action: 'browser.click', target: { directory: '/proj', tabId: 'tab-a' } });
    await wait(20);
    emitRequest({ requestId: 'req-tabs', action: 'browser.tabs', target: { directory: '/proj' } });
    await wait(30);

    // The listing is not a mutation: it answered without waiting for the click.
    const tabsPost = posted.find((entry) => entry.requestId === 'req-tabs');
    expect(tabsPost?.ok).toBe(true);
    expect((tabsPost?.data as { tabs?: unknown }).tabs).toEqual([
      { tabId: 'tab-a', url: 'http://a/', title: 'A', active: false },
    ]);
    expect(posted.some((entry) => entry.requestId === 'req-click')).toBe(false);

    releaseClick();
    await wait(30);
    expect(posted.some((entry) => entry.requestId === 'req-click' && entry.ok)).toBe(true);
  });
});