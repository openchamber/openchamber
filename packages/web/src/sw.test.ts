import { afterEach, expect, test, vi } from 'vitest';

afterEach(() => {
  vi.unstubAllGlobals();
  vi.useRealTimers();
});

type TestClient = {
  url?: string;
  focus: () => Promise<void>;
  navigate?: (url: string) => Promise<WindowClient | null>;
  postMessage?: (message: { type: string; url: string; expiresAt: number }, ports: MessagePort[]) => void;
};

type ClickEvent = {
  notification: { close: () => void; data: { sessionId: string } };
  waitUntil: (work: Promise<void>) => void;
};

async function setup(clients: TestClient[]) {
  let click: (event: ClickEvent) => void = () => {};
  const openWindow = vi.fn();
  vi.stubGlobal('self', {
    location: { origin: 'https://app.example' },
    clients: { matchAll: async () => clients, openWindow },
    addEventListener: (name: string, handler: typeof click) => {
      if (name === 'notificationclick') click = handler;
    },
  });
  vi.resetModules();
  await import('./sw');
  return {
    openWindow,
    click: (data = { sessionId: 'session-1' }) => {
      let completion = Promise.resolve();
      click({
        notification: { close() {}, data },
        waitUntil: (work: Promise<void>) => { completion = work; },
      });
      return completion;
    },
  };
}

test('a running PWA accepts notification navigation without a document load', async () => {
  const navigate = vi.fn();
  const focus = vi.fn().mockResolvedValue(undefined);
  const postMessage = vi.fn((_message: { type: string; url: string; expiresAt: number }, ports: MessagePort[]) => {
    ports[0].postMessage(true);
    ports[0].close();
  });
  const app = await setup([{ url: 'https://app.example/', focus, navigate, postMessage }]);
  await app.click();
  expect(focus).toHaveBeenCalledOnce();
  expect(navigate).not.toHaveBeenCalled();
  expect(app.openWindow).not.toHaveBeenCalled();
});

test('an old page that never acknowledges falls back after the deadline', async () => {
  vi.useFakeTimers();
  const navigate = vi.fn().mockResolvedValue({});
  const app = await setup([{
    focus: async () => {}, navigate, postMessage() {},
  }]);
  const click = app.click();
  await vi.advanceTimersByTimeAsync(1499);
  expect(navigate).not.toHaveBeenCalled();
  await vi.advanceTimersByTimeAsync(1);
  await click;
  expect(navigate).toHaveBeenCalledWith('https://app.example/?session=session-1');
  expect(app.openWindow).not.toHaveBeenCalled();
});

test('a closed window does not block opening the notification target', async () => {
  const app = await setup([{ focus: async () => { throw new Error('closed'); } }]);
  await app.click();
  expect(app.openWindow).toHaveBeenCalledWith('https://app.example/?session=session-1');
});

test('a cold start opens the target directly', async () => {
  const app = await setup([]);
  await app.click();
  expect(app.openWindow).toHaveBeenCalledWith('https://app.example/?session=session-1');
});
