import { afterEach, describe, expect, it, vi } from 'vitest';
import { createNotificationTriggerRuntime } from './runtime.js';

afterEach(() => { vi.unstubAllEnvs(); });
const item = { provider: 'github', instance: 'github.com', owner: 'acme', repo: 'private', number: 7 };
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
    await h.runtime.notifyPullRequest({ item, event: 'removed' });
    expect(h.native.mock.calls[0][0].body).toBe('acme/private#7');
    expect(h.push.mock.calls[0][0].body).toBe('');
    expect(h.apns.mock.calls[0][0].body).toBe('');
    expect(h.apns.mock.calls[0][0].sealed).toBeUndefined();
    expect(h.channels.mock.calls[0][0].notification.body).toBe('');
  });
});
