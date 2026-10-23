import { afterEach, beforeEach, expect, it, vi } from 'vitest';

const botTarget = { projectId: 'project-one', itemId: 'item_one' };
const captured: NotificationFixture[] = [];

// Only the browser notification boundary is replaced; target construction and
// runtime identity use the production implementations.
class NotificationFixture {
  static permission = 'granted';
  onclick: ((event: Event) => void) | null = null;
  close = vi.fn();
  constructor(readonly title: string, readonly options?: NotificationOptions) { captured.push(this); }
}

const browser = {
  location: { pathname: '/', search: '', assign: vi.fn() },
  focus: vi.fn(),
  __OPENCHAMBER_API_BASE_URL__: 'https://owner.test',
  __OPENCHAMBER_LOCAL_ORIGIN__: 'https://owner.test',
};

beforeEach(() => {
  captured.length = 0;
  browser.__OPENCHAMBER_API_BASE_URL__ = 'https://owner.test';
  vi.stubGlobal('window', browser);
  vi.stubGlobal('document', { visibilityState: 'visible', hasFocus: () => true });
  vi.stubGlobal('navigator', {});
  vi.stubGlobal('Notification', NotificationFixture);
});

afterEach(() => {
  vi.clearAllMocks();
  vi.unstubAllGlobals();
  vi.resetModules();
  Reflect.deleteProperty(browser, '__OPENCHAMBER_DESKTOP__');
});

it.each([undefined, 'ses_stage'])('opens only the local Bots query target with session=%s', async (sessionId) => {
  const { createWebNotificationsAPI } = await import('./notifications');
  await createWebNotificationsAPI().notifyAgentCompletion({ title: 'Attention', botTarget, sessionId });
  const notification = captured[0];
  if (!notification?.onclick) throw new Error('Notification click listener missing');

  notification.onclick(new Event('click'));

  expect(notification.options?.data).toEqual({ url: '/?botsProject=project-one&botItem=item_one', botTarget });
  expect(browser.location.assign).toHaveBeenCalledWith('/?botsProject=project-one&botItem=item_one');
  expect(notification.close).toHaveBeenCalled();
});

it('carries the sessionless Bots target through service-worker notification data', async () => {
  const showNotification = vi.fn(async () => undefined);
  vi.stubGlobal('navigator', { serviceWorker: { getRegistration: async () => ({ active: {}, showNotification }) } });
  const { createWebNotificationsAPI } = await import('./notifications');

  await createWebNotificationsAPI().notifyAgentCompletion({ title: 'Attention', botTarget });

  expect(showNotification).toHaveBeenCalledWith('Attention', expect.objectContaining({
    data: { url: '/?botsProject=project-one&botItem=item_one', botTarget },
  }));
  expect(captured).toEqual([]);
});

it('omits a foreign runtime target from service-worker notification data', async () => {
  const showNotification = vi.fn(async () => undefined);
  vi.stubGlobal('navigator', { serviceWorker: { getRegistration: async () => ({ active: {}, showNotification }) } });
  const { createWebNotificationsAPI } = await import('./notifications');

  await createWebNotificationsAPI().notifyAgentCompletion({ title: 'Attention', botTarget, runtimeKey: 'host:foreign' });

  expect(showNotification).toHaveBeenCalledWith('Attention', { body: undefined, tag: undefined });
});

it('retires a target when the runtime changes while service-worker registration is pending', async () => {
  const showNotification = vi.fn(async () => undefined);
  vi.stubGlobal('navigator', { serviceWorker: { getRegistration: async () => {
    browser.__OPENCHAMBER_API_BASE_URL__ = 'https://other.test';
    return { active: {}, showNotification };
  } } });
  const { createWebNotificationsAPI } = await import('./notifications');

  await createWebNotificationsAPI().notifyAgentCompletion({ title: 'Attention', botTarget });

  expect(showNotification).toHaveBeenCalledWith('Attention', { body: undefined, tag: undefined });
});

it('drops foreground click navigation after the runtime changes', async () => {
  const { createWebNotificationsAPI } = await import('./notifications');
  await createWebNotificationsAPI().notifyAgentCompletion({ title: 'Attention', botTarget });
  browser.__OPENCHAMBER_API_BASE_URL__ = 'https://other.test';
  const notification = captured[0];
  if (!notification?.onclick) throw new Error('Notification click listener missing');

  notification.onclick(new Event('click'));

  expect(browser.location.assign).not.toHaveBeenCalled();
  expect(browser.focus).toHaveBeenCalled();
});

it('leaves a foreign runtime target unapplied in a plain browser', async () => {
  const { createWebNotificationsAPI } = await import('./notifications');
  await createWebNotificationsAPI().notifyAgentCompletion({ title: 'Attention', botTarget, runtimeKey: 'host:foreign' });
  const notification = captured[0];
  if (!notification?.onclick) throw new Error('Notification click listener missing');

  notification.onclick(new Event('click'));

  expect(browser.location.assign).not.toHaveBeenCalled();
});

it.each([
  { projectId: 'project-one', itemId: '../item' },
  { projectId: 'https://other.test', itemId: 'item' },
  { projectId: 'project-one', itemId: 'item', url: 'https://other.test' },
])('rejects malformed Bots target data without using the stage session: %j', async (target) => {
  const { createWebNotificationsAPI } = await import('./notifications');
  await createWebNotificationsAPI().notifyAgentCompletion({ title: 'Attention', botTarget: target, sessionId: 'ses_fallback' });
  const notification = captured[0];
  if (!notification?.onclick) throw new Error('Notification click listener missing');

  notification.onclick(new Event('click'));

  expect(notification.options?.data).toBeUndefined();
  expect(browser.location.assign).not.toHaveBeenCalled();
});

it('forwards a sessionless Bots target and owner through the desktop bridge', async () => {
  const invoke = vi.fn(async () => undefined);
  Object.assign(browser, { __OPENCHAMBER_DESKTOP__: { invoke } });
  const { createWebNotificationsAPI } = await import('./notifications');

  await createWebNotificationsAPI().notifyAgentCompletion({ botTarget, runtimeKey: 'host:owner' });

  expect(invoke).toHaveBeenCalledWith('desktop_notify', {
    payload: expect.objectContaining({ botTarget, runtimeKey: 'host:owner', sessionId: undefined }),
  });
  expect(captured).toEqual([]);
});
