import { afterAll, beforeEach, describe, expect, mock, test } from 'bun:test';

let reads = 0;
let runtimeKey = 'runtime-a';
let emit: (event: { type: string; updatedAt?: number }) => void = () => {};

mock.module('@/lib/openchamberEvents', () => ({
  subscribeOpenchamberEvents: (listener: typeof emit) => {
    emit = listener;
    return () => { emit = () => {}; };
  },
}));
mock.module('@/lib/runtime-switch', () => ({ getRuntimeKey: () => runtimeKey }));
mock.module('@/stores/useSessionFoldersStore', () => ({
  handleSessionFoldersChanged: () => {},
  handleSessionFoldersStreamReady: () => { reads += 1; },
}));

const originalWindow = globalThis.window;
const originalDocument = globalThis.document;
const fakeWindow = new EventTarget();
const fakeDocument = Object.assign(new EventTarget(), { visibilityState: 'visible' });
Object.defineProperty(globalThis, 'window', { configurable: true, value: fakeWindow });
Object.defineProperty(globalThis, 'document', { configurable: true, value: fakeDocument });
afterAll(() => {
  Object.defineProperty(globalThis, 'window', { configurable: true, value: originalWindow });
  Object.defineProperty(globalThis, 'document', { configurable: true, value: originalDocument });
});

const { subscribeSessionFoldersSync } = await import('./session-folders-sync');

describe('subscribeSessionFoldersSync', () => {
  let unsubscribe: () => void = () => {};
  const originalNow = Date.now;
  let now = 1_000_000;

  beforeEach(() => {
    unsubscribe();
    reads = 0;
    runtimeKey = 'runtime-a';
    fakeDocument.visibilityState = 'visible';
    Date.now = () => now;
    now += 60_000;
    unsubscribe = subscribeSessionFoldersSync('runtime-a');
  });
  afterAll(() => {
    unsubscribe();
    Date.now = originalNow;
  });

  for (const signal of ['focus', 'pageshow', 'online', 'openchamber:system-resume']) {
    test(`reads the folders on ${signal}`, () => {
      fakeWindow.dispatchEvent(new Event(signal));
      expect(reads).toBe(1);
    });
  }

  test('reads the folders when the window becomes visible, and not when it hides', () => {
    fakeDocument.visibilityState = 'hidden';
    fakeDocument.dispatchEvent(new Event('visibilitychange'));
    expect(reads).toBe(0);

    fakeDocument.visibilityState = 'visible';
    fakeDocument.dispatchEvent(new Event('visibilitychange'));
    expect(reads).toBe(1);
  });

  test('one return firing several signals is one read; a later return reads again', () => {
    fakeDocument.dispatchEvent(new Event('visibilitychange'));
    fakeWindow.dispatchEvent(new Event('focus'));
    fakeWindow.dispatchEvent(new Event('pageshow'));
    expect(reads).toBe(1);

    now += 2_000;
    fakeWindow.dispatchEvent(new Event('focus'));
    expect(reads).toBe(2);
  });

  test('coming back online reads even right after a read made while still offline', () => {
    fakeWindow.dispatchEvent(new Event('focus'));
    fakeWindow.dispatchEvent(new Event('online'));
    expect(reads).toBe(2);
  });

  test('a window of another runtime does not read, and an unsubscribed one stops', () => {
    runtimeKey = 'runtime-b';
    fakeWindow.dispatchEvent(new Event('focus'));
    expect(reads).toBe(0);

    runtimeKey = 'runtime-a';
    unsubscribe();
    fakeWindow.dispatchEvent(new Event('focus'));
    fakeDocument.dispatchEvent(new Event('visibilitychange'));
    expect(reads).toBe(0);
  });

  test('still reads when the stream reconnects', () => {
    emit({ type: 'event-stream-ready' });
    expect(reads).toBe(1);
  });
});
