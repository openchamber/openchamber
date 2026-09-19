import { afterEach, beforeEach, describe, expect, mock, test } from 'bun:test';

type Listener = (event: { type: string; requestId: string; action: string; parameters: Record<string, unknown> }) => void;

const posted: Array<{ requestId: string; ok: boolean; data?: unknown; error?: string }> = [];
const claims: string[] = [];
/** Flipped to false to play the client that lost the race for a request. */
let grantClaims = true;
let listener: Listener | null = null;

mock.module('@/lib/runtime-fetch', () => ({
  runtimeFetch: mock(async (path: string, init?: { body?: string }) => {
    const body = JSON.parse(init?.body ?? '{}');
    if (path.endsWith('/claim')) {
      claims.push(body.requestId);
      return { ok: true, status: 200, json: async () => ({ granted: grantClaims }) };
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
}));

const { registerBrowserController, registerBrowserOpener } = await import('./controlClient');

/** Registrations are module-global, so every test unwinds its own. */
const cleanups: Array<() => void> = [];

/**
 * Stubs the host identity the capability check reads. The app injects it before
 * boot; each test sets it so both host kinds are exercised through the real
 * capability function rather than a mocked one.
 */
const asHost = (electron: boolean): void => {
  Object.defineProperty(globalThis, 'window', {
    configurable: true,
    value: electron ? { __OPENCHAMBER_ELECTRON__: true } : {},
  });
};

const emitOpen = (parameters: Record<string, unknown>): void => {
  listener?.({ type: 'browser-control-request', requestId: 'req-1', action: 'browser.open', parameters });
};

const wait = (ms: number): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms));

describe('opening a page before any view exists', () => {
  beforeEach(() => {
    posted.length = 0;
    claims.length = 0;
    grantClaims = true;
    // The reported environment: a plain browser tab, display only.
    asHost(false);
  });

  afterEach(() => {
    while (cleanups.length > 0) cleanups.pop()?.();
    Reflect.deleteProperty(globalThis, 'window');
  });

  test('lets the view that the open created apply the layout that was asked for', async () => {
    const opened: string[] = [];
    const ran: Array<{ action: string; parameters: Record<string, unknown> }> = [];

    cleanups.push(registerBrowserOpener((url) => {
      opened.push(url);
      // The pane mounts a moment after the tab is created, as it does in the app.
      setTimeout(() => {
        cleanups.push(registerBrowserController({
          run: async (action, parameters) => {
            ran.push({ action, parameters });
            return { viewport: { mode: 'mobile', width: 390, height: 844 } };
          },
        }));
      }, 120);
    }));

    emitOpen({ url: 'https://example.test', viewport: 'mobile' });
    await wait(400);

    expect(opened).toEqual(['https://example.test']);
    expect(ran).toEqual([{ action: 'browser.resize', parameters: { viewport: 'mobile' } }]);
    expect(posted[0]?.data).toEqual({
      url: 'https://example.test',
      opened: true,
      viewportApplied: true,
      viewport: { mode: 'mobile', width: 390, height: 844 },
      drivable: false,
    });
  });

  test('does nothing at all when another client was granted the request', async () => {
    grantClaims = false;
    const opened: string[] = [];
    const ran: string[] = [];
    cleanups.push(registerBrowserOpener((url) => { opened.push(url); }));
    cleanups.push(registerBrowserController({
      run: async (action) => { ran.push(action); return {}; },
    }));

    emitOpen({ url: 'https://example.test' });
    await wait(50);

    expect(claims).toEqual(['req-1']);
    // The losing client must not act: a late result cannot undo a click.
    expect(ran).toEqual([]);
    expect(opened).toEqual([]);
    expect(posted).toEqual([]);
  });

  test('claims the request before touching a page', async () => {
    const ran: string[] = [];
    cleanups.push(registerBrowserController({
      run: async (action) => { ran.push(action); return {}; },
    }));

    listener?.({ type: 'browser-control-request', requestId: 'req-1', action: 'browser.click', parameters: { selector: 'button' } });
    await wait(50);

    expect(claims).toEqual(['req-1']);
    expect(ran).toEqual(['browser.click']);
  });

  test('does not wait for a view when no layout was requested', async () => {
    cleanups.push(registerBrowserOpener(() => {}));

    emitOpen({ url: 'https://example.test' });
    await wait(20);

    expect(posted[0]?.data).toEqual({ url: 'https://example.test', opened: true, drivable: false });
  });

  test('says the layout was not applied when no view ever appears', async () => {
    cleanups.push(registerBrowserOpener(() => {}));

    emitOpen({ url: 'https://example.test', viewport: 'mobile' });
    // Past the client's own attach deadline.
    await wait(2_400);

    // A display-only client can never apply a layout, so the note must not send
    // the agent after a resize that cannot happen here.
    expect(posted[0]?.data).toEqual({
      url: 'https://example.test',
      opened: true,
      viewportApplied: false,
      drivable: false,
      note: 'The panel had no browser view yet, so the viewport was not applied. This client can display a page but cannot drive one, so browser.resize is not available here.',
    });
  });

  test('a controller answer reports the host drivability for an open', async () => {
    const ran: string[] = [];
    cleanups.push(registerBrowserController({
      run: async (action) => {
        ran.push(action);
        return { url: 'https://example.test', title: 'Example', opened: true, settled: true };
      },
    }));

    emitOpen({ url: 'https://example.test' });
    await wait(50);

    expect(ran).toEqual(['browser.open']);
    expect(posted[0]?.data).toEqual({
      url: 'https://example.test',
      title: 'Example',
      opened: true,
      settled: true,
      drivable: false,
    });
  });

  test('on a driving host, a plain open reports that the page can be driven', async () => {
    asHost(true);
    cleanups.push(registerBrowserOpener(() => {}));

    emitOpen({ url: 'https://example.test' });
    await wait(20);

    expect(posted[0]?.data).toEqual({ url: 'https://example.test', opened: true, drivable: true });
  });

  test('on a driving host, the created view applies the layout and the result stays drivable', async () => {
    asHost(true);
    const opened: string[] = [];
    const ran: string[] = [];

    cleanups.push(registerBrowserOpener((url) => {
      opened.push(url);
      setTimeout(() => {
        cleanups.push(registerBrowserController({
          run: async (action) => {
            ran.push(action);
            return { viewport: { mode: 'mobile', width: 390, height: 844 } };
          },
        }));
      }, 120);
    }));

    emitOpen({ url: 'https://example.test', viewport: 'mobile' });
    await wait(400);

    expect(opened).toEqual(['https://example.test']);
    expect(ran).toEqual(['browser.resize']);
    expect(posted[0]?.data).toEqual({
      url: 'https://example.test',
      opened: true,
      viewportApplied: true,
      viewport: { mode: 'mobile', width: 390, height: 844 },
      drivable: true,
    });
  });

  test('on a driving host, a missing view keeps the resize follow-up in the note', async () => {
    asHost(true);
    cleanups.push(registerBrowserOpener(() => {}));

    emitOpen({ url: 'https://example.test', viewport: 'mobile' });
    await wait(2_400);

    expect(posted[0]?.data).toEqual({
      url: 'https://example.test',
      opened: true,
      viewportApplied: false,
      drivable: true,
      note: 'The panel had no browser view yet, so the viewport was not applied. Call browser.resize now that one exists.',
    });
  });

  test('on a driving host, a controller answer reports drivable', async () => {
    asHost(true);
    cleanups.push(registerBrowserController({
      run: async () => ({ url: 'https://example.test', title: 'Example', opened: true, settled: true }),
    }));

    emitOpen({ url: 'https://example.test' });
    await wait(50);

    expect(posted[0]?.data).toEqual({
      url: 'https://example.test',
      title: 'Example',
      opened: true,
      settled: true,
      drivable: true,
    });
  });
});
