import { afterEach, describe, expect, it, vi } from 'vitest';
import { createNotificationTriggerRuntime } from './runtime.js';

afterEach(() => { vi.unstubAllEnvs(); });
const item = { provider: 'github', instance: 'github.com', owner: 'acme', repo: 'private', number: 7 };
const url = 'https://github.com/acme/private/pull/7';
const harness = (settings = {}, visible = false) => {
  const native = vi.fn(() => true);
  const ui = vi.fn(); const push = vi.fn(); const apns = vi.fn(); const channels = vi.fn();
  const runtime = createNotificationTriggerRuntime({
    readSettingsFromDisk: async () => ({ nativeNotificationsEnabled: true, notificationMode: 'always', locale: 'uk', ...settings }),
    emitDesktopNotification: native, broadcastUiNotification: ui, sendPushToAllUiSessions: push,
    sendApnsToAllUiSessions: apns, isAnyInteractiveClientVisible: () => visible,
    deliverToExtensionChannels: channels,
    buildOpenCodeUrl: (value) => `http://localhost${value}`, getOpenCodeAuthHeaders: () => ({}),
  });
  return { runtime, native, ui, push, apns, channels };
};

describe('pull request notifications', () => {
  it('uses the same native, UI, push and extension channels as session notifications', async () => {
    const h = harness();
    await h.runtime.notifyPullRequest({ item, event: 'checks-failed' });
    expect(h.native.mock.calls[0][0]).toMatchObject({ kind: 'pull-request', title: 'Перевірки pull request не пройдено', body: 'acme/private#7' });
    expect(h.ui).toHaveBeenCalledTimes(1);
    expect(h.push).toHaveBeenCalledTimes(1);
    expect(h.apns).toHaveBeenCalledTimes(1);
    expect(h.channels).toHaveBeenCalledTimes(1);
  });
  it('respects the profile toggle for all delivery channels', async () => {
    const h = harness({ notifyOnPullRequests: false });
    await h.runtime.notifyPullRequest({ item, event: 'merged' });
    for (const sink of [h.native, h.ui, h.push, h.apns, h.channels]) expect(sink).not.toHaveBeenCalled();
  });
  it('keeps repository content out of external channels in enterprise mode', async () => {
    vi.stubEnv('OPENCHAMBER_ENTERPRISE_MODE', '1');
    const h = harness();
    await h.runtime.notifyPullRequest({ item, event: 'removed', url, directory: '/work/app' });
    expect(h.native.mock.calls[0][0].body).toBe('acme/private#7');
    expect(h.push.mock.calls[0][0].body).toBe('');
    expect(h.apns.mock.calls[0][0].body).toBe('');
    expect(h.apns.mock.calls[0][0].sealed).toBeUndefined();
    expect(h.channels.mock.calls[0][0].notification.body).toBe('');
    expect(JSON.stringify(h.push.mock.calls[0][0])).not.toContain('private');
    expect(JSON.stringify(h.apns.mock.calls[0][0])).not.toContain('private');
    expect(JSON.stringify(h.channels.mock.calls[0][0])).not.toContain('private');
    expect(h.push.mock.calls[0][0].data.url).toBe('/');
  });
  it('carries the pull request and its project folder to the clicks of every channel', async () => {
    const h = harness();
    await h.runtime.notifyPullRequest({ item, event: 'merged', url, directory: '/work/app' });
    expect(h.native.mock.calls[0][0]).toMatchObject({ itemUrl: url, directory: '/work/app' });
    expect(h.ui.mock.calls[0][0]).toMatchObject({ itemUrl: url, directory: '/work/app' });
    const route = new URL(h.push.mock.calls[0][0].data.url, 'http://app');
    expect(route.pathname).toBe('/');
    expect(route.searchParams.get('item')).toBe(url);
    expect(route.searchParams.get('itemDir')).toBe('/work/app');
    const phone = h.apns.mock.calls[0][0];
    const link = new URL(phone.sealed.url);
    expect(link.protocol).toBe('openchamber:');
    expect(link.host).toBe('tracker-item');
    expect(link.searchParams.get('url')).toBe(url);
    expect(link.searchParams.get('dir')).toBe('/work/app');
    expect(JSON.stringify({ ...phone, sealed: undefined })).not.toContain('private');
    expect(h.channels.mock.calls[0][0].notification).not.toHaveProperty('itemUrl');
  });
  it('opens the pull request without a folder when the follow has none', async () => {
    const h = harness();
    await h.runtime.notifyPullRequest({ item, event: 'merged', url });
    expect(h.native.mock.calls[0][0].itemUrl).toBe(url);
    expect(h.native.mock.calls[0][0]).not.toHaveProperty('directory');
    const route = new URL(h.push.mock.calls[0][0].data.url, 'http://app');
    expect(route.searchParams.get('item')).toBe(url);
    expect(route.searchParams.has('itemDir')).toBe(false);
  });
});
