import { afterEach, expect, test, vi } from 'vitest';
import { listenForNotificationNavigation, navigateFromNotification } from '@openchamber/ui/lib/router/notificationNavigation';

afterEach(() => vi.unstubAllGlobals());

test('browser navigation works without a service worker and stops after router unmount', () => {
  vi.stubGlobal('navigator', {});
  vi.stubGlobal('window', { location: new URL('https://app.example/?session=other') });
  const accept = vi.fn(() => true);
  const cleanup = listenForNotificationNavigation(accept);
  try {
    expect(navigateFromNotification('/?session=target')).toBe(true);
    expect(accept).toHaveBeenCalledWith(new URL('https://app.example/?session=target'));
  } finally {
    cleanup();
  }
  expect(navigateFromNotification('/?session=target')).toBe(false);
  expect(accept).toHaveBeenCalledOnce();
});

test('a busy router or synchronous failure leaves browser fallback available', () => {
  vi.stubGlobal('navigator', {});
  vi.stubGlobal('window', { location: new URL('https://app.example/') });
  const cleanupBusy = listenForNotificationNavigation(() => false);
  expect(navigateFromNotification('/?session=target')).toBe(false);
  cleanupBusy();
  const cleanupFailure = listenForNotificationNavigation(() => { throw new Error('routing failed'); });
  expect(navigateFromNotification('/?session=target')).toBe(false);
  cleanupFailure();
});

function setup() {
  const serviceWorker = new EventTarget();
  vi.stubGlobal('navigator', { serviceWorker });
  vi.stubGlobal('window', { location: new URL('https://app.example/') });
  const accept = vi.fn(() => true);
  const cleanup = listenForNotificationNavigation(accept);
  return {
    accept,
    cleanup,
    dispatch: (overrides = {}, origin = 'https://app.example') => {
      const channel = new MessageChannel();
      serviceWorker.dispatchEvent(new MessageEvent('message', {
        origin,
        data: {
          type: 'openchamber:notification-navigation',
          url: 'https://app.example/?session=session-1',
          expiresAt: Date.now() + 1500,
          ...overrides,
        },
        ports: [channel.port2],
      }));
      channel.port1.close();
      channel.port2.close();
    },
  };
}

test('a mounted router accepts the notification URL and cleans up on unmount', () => {
  const app = setup();
  app.dispatch();
  expect(app.accept).toHaveBeenCalledWith(new URL('https://app.example/?session=session-1'));
  app.cleanup();
  app.dispatch();
  expect(app.accept).toHaveBeenCalledOnce();
});

test('expired, foreign, malformed, and other-document requests cannot navigate the app', () => {
  const app = setup();
  app.dispatch({ expiresAt: Date.now() - 1 });
  app.dispatch({ url: 'https://foreign.example/' });
  app.dispatch({ url: 'https://app.example/other-app' });
  app.dispatch({ url: 'invalid' });
  app.dispatch({}, 'https://foreign.example');
  expect(app.accept).not.toHaveBeenCalled();
  app.cleanup();
});

test.each([true, false])('acknowledges router acceptance as %s', async (accepted) => {
  const serviceWorker = new EventTarget();
  vi.stubGlobal('navigator', { serviceWorker });
  vi.stubGlobal('window', { location: new URL('https://app.example/') });
  const cleanup = listenForNotificationNavigation(() => accepted);
  const channel = new MessageChannel();
  const reply = new Promise<unknown>((resolve) => {
    channel.port1.onmessage = (event: MessageEvent<unknown>) => resolve(event.data);
  });
  try {
    serviceWorker.dispatchEvent(new MessageEvent('message', {
      origin: 'https://app.example',
      data: {
        type: 'openchamber:notification-navigation',
        url: 'https://app.example/?session=session-1',
        expiresAt: Date.now() + 1500,
      },
      ports: [channel.port2],
    }));
    expect(await reply).toBe(accepted);
  } finally {
    cleanup();
    channel.port1.close();
    channel.port2.close();
  }
});
