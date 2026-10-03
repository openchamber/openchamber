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

type CapturedNotification = {
  title: string;
  options?: NotificationOptions;
  instance: Notification & { close: () => void };
};

const installNotificationMock = (
  onCreate: (title: string, options?: NotificationOptions) => void,
  captured?: CapturedNotification[],
) => {
  const MockNotification = function Notification(
    this: Notification & { close: () => void },
    title: string,
    options?: NotificationOptions,
  ) {
    this.close = vi.fn();
    onCreate(title, options);
    captured?.push({ title, options, instance: this });
    return this;
  } as unknown as MockNotificationConstructor;
  MockNotification.permission = 'granted';
  MockNotification.requestPermission = vi.fn(async () => 'granted' as NotificationPermission);

  Object.defineProperty(globalThis, 'Notification', {
    configurable: true,
    value: MockNotification,
  });
};

const installWindowMock = (overrides?: {
  pathname?: string;
  search?: string;
  focus?: () => void;
  assign?: (url: string) => void;
}) => {
  const storage = new Map<string, string>();
  const focus = overrides?.focus ?? (() => undefined);
  const assign = overrides?.assign ?? (() => undefined);
  Object.defineProperty(globalThis, 'window', {
    configurable: true,
    value: {
      localStorage: {
        getItem: (key: string) => storage.get(key) ?? null,
        setItem: (key: string, value: string) => storage.set(key, value),
        removeItem: (key: string) => storage.delete(key),
      },
      location: {
        pathname: overrides?.pathname ?? '/',
        search: overrides?.search ?? '',
        assign,
      },
      focus,
    },
  });
};

const installFocusedDocument = () => {
  Object.defineProperty(globalThis, 'document', {
    configurable: true,
    value: {
      visibilityState: 'visible',
      hasFocus: () => true,
    },
  });
};

const installEmptyNavigator = () => {
  Object.defineProperty(globalThis, 'navigator', {
    configurable: true,
    value: {},
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

  it('includes the session target in service-worker notification data', async () => {
    installWindowMock();
    installFocusedDocument();
    const showNotification = vi.fn(async () => undefined);
    Object.defineProperty(globalThis, 'navigator', {
      configurable: true,
      value: {
        serviceWorker: {
          getRegistration: vi.fn(async () => ({
            active: {},
            showNotification,
          })),
        },
      },
    });
    const created: Array<{ title: string; options?: NotificationOptions }> = [];
    installNotificationMock((title, options) => created.push({ title, options }));

    const { createWebNotificationsAPI } = await import('./notifications');
    const api = createWebNotificationsAPI();

    await expect(api.notifyAgentCompletion({
      title: 'Ready',
      body: 'Done',
      tag: 'ready-ses_123',
      sessionId: 'ses_123',
    })).resolves.toBe(true);

    expect(showNotification).toHaveBeenCalledTimes(1);
    expect(showNotification).toHaveBeenCalledWith('Ready', expect.objectContaining({
      body: 'Done',
      tag: 'ready-ses_123',
      data: { url: '/?session=ses_123', sessionId: 'ses_123' },
    }));
    expect(created).toHaveLength(0);
  });

  it('routes a foreground notification click to the notified session', async () => {
    const assign = vi.fn();
    const focus = vi.fn();
    installWindowMock({ pathname: '/', search: '', focus, assign });
    installFocusedDocument();
    installEmptyNavigator();
    const captured: CapturedNotification[] = [];
    installNotificationMock(() => undefined, captured);

    const { createWebNotificationsAPI } = await import('./notifications');
    const api = createWebNotificationsAPI();

    await expect(api.notifyAgentCompletion({
      title: 'Ready',
      body: 'Done',
      tag: 'ready-ses_123',
      sessionId: 'ses_123',
    })).resolves.toBe(true);

    expect(captured).toHaveLength(1);
    expect(captured[0]?.options).toMatchObject({
      data: { url: '/?session=ses_123', sessionId: 'ses_123' },
    });

    const instance = captured[0]?.instance;
    expect(typeof instance?.onclick).toBe('function');
    instance?.onclick?.call(instance, new Event('click'));

    expect(focus).toHaveBeenCalled();
    expect(assign).toHaveBeenCalledWith('/?session=ses_123');
    expect(instance?.close).toHaveBeenCalled();
  });

  it('only focuses when the notified session is already open', async () => {
    const assign = vi.fn();
    const focus = vi.fn();
    installWindowMock({ pathname: '/', search: '?session=ses_123', focus, assign });
    installFocusedDocument();
    installEmptyNavigator();
    const captured: CapturedNotification[] = [];
    installNotificationMock(() => undefined, captured);

    const { createWebNotificationsAPI } = await import('./notifications');
    const api = createWebNotificationsAPI();

    await expect(api.notifyAgentCompletion({
      title: 'Ready',
      body: 'Done',
      tag: 'ready-ses_123',
      sessionId: 'ses_123',
    })).resolves.toBe(true);

    const instance = captured[0]?.instance;
    instance?.onclick?.call(instance, new Event('click'));

    expect(focus).toHaveBeenCalled();
    expect(assign).not.toHaveBeenCalled();
  });

  it('omits notification data when there is no session', async () => {
    installWindowMock();
    installFocusedDocument();
    const shown: Array<{ title: string; options?: NotificationOptions }> = [];
    const showNotification = vi.fn(async (title: string, options?: NotificationOptions) => {
      shown.push({ title, options });
    });
    Object.defineProperty(globalThis, 'navigator', {
      configurable: true,
      value: {
        serviceWorker: {
          getRegistration: vi.fn(async () => ({
            active: {},
            showNotification,
          })),
        },
      },
    });
    const created: Array<{ title: string; options?: NotificationOptions }> = [];
    installNotificationMock((title, options) => created.push({ title, options }));

    const { createWebNotificationsAPI } = await import('./notifications');
    const api = createWebNotificationsAPI();

    await expect(api.notifyAgentCompletion({ title: 'Note', body: 'Hello' })).resolves.toBe(true);

    expect(showNotification).toHaveBeenCalledTimes(1);
    expect(shown).toHaveLength(1);
    // SAFETY: NotificationOptions.data carries our own { url, sessionId } target;
    // read the key only to assert it is omitted when there is no session.
    expect((shown[0]?.options as { data?: unknown } | undefined)?.data).toBeUndefined();
  });
});
