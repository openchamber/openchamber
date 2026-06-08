import { afterEach, describe, expect, it, vi } from 'vitest';

type MockNotificationConstructor = {
  new (title: string, options?: NotificationOptions): Notification;
  permission: NotificationPermission;
  requestPermission: () => Promise<NotificationPermission>;
};

const originalNotification = globalThis.Notification;
const originalNavigator = globalThis.navigator;
const originalDocument = globalThis.document;
const originalWindow = globalThis.window;

const installNotificationMock = (onCreate: (title: string, options?: NotificationOptions) => void) => {
  const MockNotification = function Notification(this: Notification, title: string, options?: NotificationOptions) {
    onCreate(title, options);
    return this;
  } as unknown as MockNotificationConstructor;
  MockNotification.permission = 'granted';
  MockNotification.requestPermission = vi.fn(async () => 'granted' as NotificationPermission);

  Object.defineProperty(globalThis, 'Notification', {
    configurable: true,
    value: MockNotification,
  });
};

const installWindowMock = () => {
  const storage = new Map<string, string>();
  Object.defineProperty(globalThis, 'window', {
    configurable: true,
    value: {
      localStorage: {
        getItem: (key: string) => storage.get(key) ?? null,
        setItem: (key: string, value: string) => storage.set(key, value),
        removeItem: (key: string) => storage.delete(key),
      },
    },
  });
};

afterEach(() => {
  vi.restoreAllMocks();
  vi.resetModules();
  Object.defineProperty(globalThis, 'Notification', { configurable: true, value: originalNotification });
  Object.defineProperty(globalThis, 'navigator', { configurable: true, value: originalNavigator });
  Object.defineProperty(globalThis, 'document', { configurable: true, value: originalDocument });
  Object.defineProperty(globalThis, 'window', { configurable: true, value: originalWindow });
});

describe('web notifications API', () => {
  it('deduplicates repeated foreground notifications by tag', async () => {
    installWindowMock();
    const created: Array<{ title: string; options?: NotificationOptions }> = [];
    installNotificationMock((title, options) => created.push({ title, options }));

    const { createWebNotificationsAPI } = await import('./notifications');
    const api = createWebNotificationsAPI();

    await expect(api.notifyAgentCompletion({ title: 'Ready', body: 'Done', tag: 'ready-session' })).resolves.toBe(true);
    await expect(api.notifyAgentCompletion({ title: 'Ready', body: 'Done', tag: 'ready-session' })).resolves.toBe(true);

    expect(created).toHaveLength(1);
    expect(created[0]?.title).toBe('Ready');
  });

  it('defers hidden-page notification delivery to active push subscription without claiming foreground delivery', async () => {
    installWindowMock();
    const created: Array<{ title: string; options?: NotificationOptions }> = [];
    installNotificationMock((title, options) => created.push({ title, options }));
    const showNotification = vi.fn(async () => undefined);
    let visibilityState: DocumentVisibilityState = 'hidden';
    let focused = false;

    Object.defineProperty(globalThis, 'document', {
      configurable: true,
      value: {
        get visibilityState() {
          return visibilityState;
        },
        hasFocus: () => focused,
      },
    });
    Object.defineProperty(globalThis, 'navigator', {
      configurable: true,
      value: {
        serviceWorker: {
          getRegistration: vi.fn(async () => ({
            active: {},
            showNotification,
            pushManager: {
              getSubscription: vi.fn(async () => ({ endpoint: 'https://push.example/subscription' })),
            },
          })),
        },
      },
    });

    const { createWebNotificationsAPI } = await import('./notifications');
    const api = createWebNotificationsAPI();

    await expect(api.notifyAgentCompletion({ title: 'Ready', body: 'Done', tag: 'ready-session' })).resolves.toBe(true);

    expect(showNotification).not.toHaveBeenCalled();
    expect(created).toHaveLength(0);

    visibilityState = 'visible';
    focused = true;

    await expect(api.notifyAgentCompletion({ title: 'Ready', body: 'Done', tag: 'ready-session' })).resolves.toBe(true);

    expect(showNotification).toHaveBeenCalledTimes(1);
    expect(showNotification).toHaveBeenCalledWith('Ready', expect.objectContaining({ body: 'Done', tag: 'ready-session' }));
    expect(created).toHaveLength(0);
  });
});
