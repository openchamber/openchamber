// Bun 1.4 exposes Jest-compatible timers at runtime, but its bundled test declarations omit them.
// @ts-expect-error Bun's local test declarations lag its runtime export.
import { afterEach, beforeEach, expect, jest, test } from 'bun:test';
import { permissionReviewSchema, usePermissionReviewStore as store } from './usePermissionReviewStore';

const originalFetch = globalThis.fetch;
const request = { id: 'p', sessionID: 's', directory: '/project' };
const snapshot = (revision: number, phase: 'manual' | 'reviewing' | 'answered' = 'reviewing', remainingMs = 1000) => ({
  dispositionVersion: 1 as const, instanceId: 'server', revision,
  permissions: [{ permissionId: 'p', phase, remainingMs: phase === 'manual' ? 0 : remainingMs }],
});
const deferred = () => {
  let resolve: (response: Response) => void = () => {};
  const promise = new Promise<Response>((done) => { resolve = done; });
  return { promise, resolve };
};
beforeEach(() => store.getState().reset());
afterEach(() => { store.getState().reset(); globalThis.fetch = originalFetch; });

test('unknown is hidden during one shared lookup; manual result exposes without a classifier', async () => {
  const response = deferred();
  let calls = 0;
  let started = () => {};
  const fetched = new Promise<void>((resolve) => { started = resolve; });
  globalThis.fetch = Object.assign(async () => { calls++; started(); return response.promise; }, originalFetch);
  expect(store.getState().visible('p')).toBe(false);
  const first = store.getState().ensure([request]);
  await store.getState().ensure([request]);
  await fetched;
  expect(calls).toBe(1);
  expect(store.getState().visible('p')).toBe(false);
  response.resolve(Response.json(snapshot(1, 'manual')));
  await first;
  expect(store.getState().visible('p')).toBe(true);
});

test('held before pending and reload hydration preserve explicit manual authority', async () => {
  globalThis.fetch = Object.assign(async () => Response.json(snapshot(3, 'manual')), originalFetch);
  await store.getState().load();
  expect(store.getState().visible('p')).toBe(true);
  await store.getState().ensure([request]);
  store.getState().applySnapshot(snapshot(4));
  expect(store.getState().visible('p')).toBe(true);
});

test('an unscoped consumer cannot claim an ID before its scoped owner registers it', async () => {
  const bodies: Array<BodyInit | null | undefined> = [];
  globalThis.fetch = Object.assign(async (_input: RequestInfo | URL, init?: RequestInit) => {
    bodies.push(init?.body);
    return Response.json(snapshot(1, 'manual'));
  }, originalFetch);
  await store.getState().ensure([{ id: request.id, sessionID: request.sessionID }]);
  expect(store.getState().entries.has(request.id)).toBe(false);
  expect(bodies).toEqual([]);
  await store.getState().ensure([request]);
  expect(bodies).toEqual([JSON.stringify({ requests: [request] })]);
  expect(store.getState().visible(request.id)).toBe(true);
});

test('missing ID after a snapshot stays unknown and triggers its own lookup', async () => {
  store.getState().applySnapshot({ ...snapshot(1), permissions: [] });
  expect(store.getState().visible('p')).toBe(false);
  globalThis.fetch = Object.assign(async () => Response.json(snapshot(2, 'manual')), originalFetch);
  await store.getState().ensure([request]);
  expect(store.getState().visible('p')).toBe(true);
});

test('control may beat lookup and answer may beat raw removal without renewing the lease', async () => {
  const response = deferred();
  globalThis.fetch = Object.assign(async () => response.promise, originalFetch);
  const pending = store.getState().ensure([request]);
  store.getState().applySnapshot(snapshot(2));
  const deadline = store.getState().deadlines.get('p');
  store.getState().applySnapshot(snapshot(3, 'answered'));
  response.resolve(Response.json(snapshot(1, 'manual')));
  await pending;
  expect(store.getState().visible('p')).toBe(false);
  expect(store.getState().deadlines.get('p')).toBe(deadline);
});

for (const failure of ['http', 'unsupported', 'malformed', 'missing-id']) {
  test(`${failure} exposes controls and reconnect never hides the same request again`, async () => {
    globalThis.fetch = Object.assign(async () => failure === 'http' ? new Response(null, { status: 503 })
      : Response.json(failure === 'unsupported' ? { revision: 0, permissions: [] }
        : failure === 'malformed' ? { permissions: null } : { ...snapshot(1), permissions: [] }), originalFetch);
    await store.getState().ensure([request]);
    expect(store.getState().visible('p')).toBe(true);
    store.getState().disconnect();
    store.getState().connect();
    store.getState().applySnapshot(snapshot(20));
    expect(store.getState().visible('p')).toBe(true);
  });
}

test('failed hydration exposes unknown requests; observing them makes fallback sticky', async () => {
  globalThis.fetch = Object.assign(async () => new Response(null, { status: 503 }), originalFetch);
  await store.getState().load();
  expect(store.getState().visible('p')).toBe(true);
  await store.getState().ensure([request]);
  store.getState().connect();
  store.getState().applySnapshot(snapshot(1));
  expect(store.getState().visible('p')).toBe(true);
});

test('disconnect rejects in-flight completion; runtime reset permits new IDs but not stale results', async () => {
  const response = deferred();
  globalThis.fetch = Object.assign(async () => response.promise, originalFetch);
  const pending = store.getState().ensure([request]);
  store.getState().disconnect();
  expect(store.getState().visible('p')).toBe(true);
  store.getState().reset();
  response.resolve(Response.json(snapshot(90)));
  await pending;
  expect(store.getState().revision).toBe(-1);
  expect(store.getState().entries.size).toBe(0);
});

test('expiry exposes controls permanently even if server sends a later review', async () => {
  jest.useFakeTimers();
  try {
    store.getState().applySnapshot(snapshot(1, 'reviewing', 1));
    jest.advanceTimersByTime(1);
    expect(store.getState().visible('p')).toBe(true);
    store.getState().applySnapshot(snapshot(2));
    expect(store.getState().visible('p')).toBe(true);
  } finally {
    jest.useRealTimers();
  }
});

test('lookup timeout exposes controls and a late successful response cannot hide them', async () => {
  jest.useFakeTimers();
  try {
    let resolveLate = () => {};
    globalThis.fetch = Object.assign((_input: RequestInfo | URL, init?: RequestInit) => new Promise<Response>((resolve, reject) => {
      resolveLate = () => resolve(Response.json(snapshot(1)));
      init?.signal?.addEventListener('abort', () => reject(init.signal?.reason), { once: true });
    }), originalFetch);
    const pending = store.getState().ensure([request]);
    jest.advanceTimersByTime(5_000);
    await pending;
    expect(store.getState().visible('p')).toBe(true);
    resolveLate();
    await Promise.resolve();
    expect(store.getState().visible('p')).toBe(true);
  } finally {
    jest.useRealTimers();
  }
});

test('schema rejects malformed and unbounded leases', () => {
  expect(permissionReviewSchema.safeParse(snapshot(-1)).success).toBe(false);
  expect(permissionReviewSchema.safeParse(snapshot(1, 'reviewing', 25001)).success).toBe(false);
});

test('VS Code controls and its responder bypass disposition coordination', async () => {
  const previous = Object.getOwnPropertyDescriptor(globalThis, 'window');
  Object.defineProperty(globalThis, 'window', { configurable: true, value: { __VSCODE_CONFIG__: {} } });
  let calls = 0;
  globalThis.fetch = Object.assign(async () => { calls++; return Response.json(snapshot(1)); }, originalFetch);
  try {
    expect(store.getState().visible('p')).toBe(true);
    await store.getState().ensure([request]);
    await store.getState().load();
    expect(calls).toBe(0);
  } finally {
    if (previous) Object.defineProperty(globalThis, 'window', previous);
    else Reflect.deleteProperty(globalThis, 'window');
  }
});
