import { afterEach, beforeEach, describe, expect, mock, test } from 'bun:test';

type InventoryPost = {
  clientId?: unknown;
  revision?: unknown;
  openableDirectory?: unknown;
  controllers?: unknown;
  activeTarget?: unknown;
  hasFocus?: unknown;
};

const posts: InventoryPost[] = [];
/** Queued `recorded` answers for the next posts; empty means `true`. */
let recordedQueue: boolean[] = [];
let failFetch = false;
let deferPosts = false;
let releasePendingPost: ((recorded?: boolean) => void) | null = null;
let readyListener: (() => void) | null = null;
let streamConnected = true;

mock.module('@/lib/runtime-fetch', () => ({
  runtimeFetch: mock(async (path: string, init?: { body?: string }) => {
    if (!path.includes('/api/browser-control/inventory')) {
      throw new Error(`unexpected fetch: ${path}`);
    }
    posts.push(JSON.parse(init?.body ?? '{}') as InventoryPost);
    if (failFetch) {
      throw new Error('network down');
    }
    if (deferPosts) {
      return new Promise((resolve) => {
        releasePendingPost = (recorded = true) => resolve({
          ok: true,
          status: 200,
          json: async () => ({ recorded }),
        });
      });
    }
    const recorded = recordedQueue.length > 0 ? recordedQueue.shift()! : true;
    return { ok: true, status: 200, json: async () => ({ recorded }) };
  }),
}));

mock.module('@/lib/openchamberEvents', () => ({
  getBrowserControlClientId: () => 'win-test',
  subscribeEventStreamReady: (listener: () => void) => {
    readyListener = listener;
    return () => { readyListener = null; };
  },
  isEventStreamConnected: () => streamConnected,
  subscribeOpenchamberEvents: () => () => undefined,
}));

const {
  startBrowserControlInventory,
  stopBrowserControlInventory,
} = await import('./controlInventory');
const {
  registerBrowserController,
  registerBrowserOpener,
  setActiveBrowserTarget,
} = await import('./controlClient');

const wait = (ms: number): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms));

const keyA = { runtimeKey: 'runtime', directory: '/proj', tabId: 'tab-a' };
const cleanups: Array<() => void> = [];
let focusHandlers: Array<() => void> = [];
let focusState = true;

const lastPost = (): InventoryPost | undefined => posts[posts.length - 1];

const expectIncreasingRevisions = (): void => {
  const revisions = posts.map((post) => post.revision as number);
  for (let index = 1; index < revisions.length; index += 1) {
    expect(revisions[index] > revisions[index - 1]).toBe(true);
  }
};

describe('browser control inventory publisher', () => {
  beforeEach(() => {
    posts.length = 0;
    recordedQueue = [];
    failFetch = false;
    deferPosts = false;
    releasePendingPost = null;
    readyListener = null;
    streamConnected = true;
    focusState = true;
    focusHandlers = [];
    globalThis.window = {
      addEventListener: (_type: string, handler: () => void) => { focusHandlers.push(handler); },
      removeEventListener: () => undefined,
    } as unknown as Window & typeof globalThis;
    globalThis.document = {
      hasFocus: () => focusState,
    } as unknown as Document;
  });

  afterEach(() => {
    while (cleanups.length > 0) cleanups.pop()?.();
    stopBrowserControlInventory();
    delete (globalThis as { window?: unknown }).window;
    delete (globalThis as { document?: unknown }).document;
  });

  test('posts the registry state shortly after starting', async () => {
    cleanups.push(registerBrowserController(keyA, { run: async () => ({}) }));
    cleanups.push(registerBrowserOpener('/proj/', () => ({ tabId: 'tab-new' })));
    setActiveBrowserTarget(keyA);

    startBrowserControlInventory();
    await wait(200);

    expect(posts.length).toBeGreaterThan(0);
    const post = lastPost()!;
    expect(post.clientId).toBe('win-test');
    // The wire shape carries the canonical directory the server compares against.
    expect(post.openableDirectory).toBe('/proj');
    expect(post.controllers).toEqual([{ directory: '/proj', tabId: 'tab-a' }]);
    expect(post.activeTarget).toEqual({ directory: '/proj', tabId: 'tab-a' });
    expect(post.hasFocus).toBe(true);
  });

  test('re-posts when the registry changes', async () => {
    startBrowserControlInventory();
    await wait(200);
    const before = posts.length;

    cleanups.push(registerBrowserController(keyA, { run: async () => ({}) }));
    await wait(200);

    expect(posts.length).toBe(before + 1);
    expect(lastPost()!.controllers).toEqual([{ directory: '/proj', tabId: 'tab-a' }]);
  });

  test('re-posts when the event stream reports ready again (reconnect)', async () => {
    startBrowserControlInventory();
    await wait(200);
    const before = posts.length;
    expect(typeof readyListener).toBe('function');

    readyListener!();
    await wait(200);

    expect(posts.length).toBe(before + 1);
  });

  test('samples hasFocus per post and re-posts on focus change', async () => {
    startBrowserControlInventory();
    await wait(200);
    expect(lastPost()!.hasFocus).toBe(true);

    focusState = false;
    for (const handler of focusHandlers) handler();
    await wait(200);

    expect(lastPost()!.hasFocus).toBe(false);
  });

  test('retries an unrecorded post with bounded backoff and then goes idle', async () => {
    recordedQueue = [false, false, false, false, false];

    startBrowserControlInventory();
    // Initial post (~100ms) plus retries at +250/+500/+1000, then silence.
    await wait(2_400);
    expect(posts.length).toBe(4);

    await wait(400);
    expect(posts.length).toBe(4);

    // The next change re-arms the publisher.
    cleanups.push(registerBrowserController(keyA, { run: async () => ({}) }));
    await wait(200);
    expect(posts.length).toBe(5);
  });

  test('treats a failed fetch like an unrecorded one and keeps revisions monotonic', async () => {
    failFetch = true;

    startBrowserControlInventory();
    await wait(900);
    failFetch = false;
    await wait(1_400);

    expect(posts.length).toBeGreaterThanOrEqual(3);
    expectIncreasingRevisions();
  });

  test('keeps publishing across a directory change', async () => {
    const unregisterA = registerBrowserOpener('/proj-a', () => ({ tabId: 'tab-a' }));
    await wait(200);
    expect(lastPost()!.openableDirectory).toBe('/proj-a');

    // The panel re-registers its opener when the effective directory changes.
    unregisterA();
    cleanups.push(registerBrowserOpener('/proj-b', () => ({ tabId: 'tab-b' })));
    await wait(250);

    expect(lastPost()!.openableDirectory).toBe('/proj-b');
    expectIncreasingRevisions();

    // Still alive: a stream-ready signal produces another post.
    const before = posts.length;
    readyListener!();
    await wait(200);
    expect(posts.length).toBe(before + 1);
  });

  test('posts a clearing inventory when the last registration goes away', async () => {
    cleanups.push(registerBrowserController(keyA, { run: async () => ({}) }));
    await wait(200);
    expect((lastPost()!.controllers as unknown[]).length).toBe(1);

    while (cleanups.length > 0) cleanups.pop()?.();
    await wait(50);

    const clearing = lastPost()!;
    expect(clearing.controllers).toEqual([]);
    expect(clearing.openableDirectory).toBe(null);
    expect(clearing.activeTarget).toBe(null);
  });

  test('skips the clearing post when the event stream is already closed', async () => {
    cleanups.push(registerBrowserController(keyA, { run: async () => ({}) }));
    await wait(200);
    const before = posts.length;

    streamConnected = false;
    while (cleanups.length > 0) cleanups.pop()?.();
    await wait(200);

    expect(posts.length).toBe(before);
  });

  test('replaces the pending snapshot when the state changes mid-flight', async () => {
    deferPosts = true;
    startBrowserControlInventory();
    await wait(200);
    expect(posts.length).toBe(1);
    expect(typeof releasePendingPost).toBe('function');

    // The state changes while the first post is still unanswered; the answer
    // must not settle the old state as final.
    cleanups.push(registerBrowserController(keyA, { run: async () => ({}) }));
    await wait(200);
    deferPosts = false;
    releasePendingPost!(true);
    await wait(300);

    expect(posts.length).toBe(2);
    expect(lastPost()!.controllers).toEqual([{ directory: '/proj', tabId: 'tab-a' }]);
    expectIncreasingRevisions();
  });
});
