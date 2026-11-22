import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { createNotificationTriggerRuntime } from './runtime.js';

beforeEach(() => {
  vi.useFakeTimers();
  // The session record the push text and the toast's Open read.
  vi.stubGlobal('fetch', vi.fn(async () => new Response(JSON.stringify({ title: 'Schema work', location: { directory: '/repo' } }))));
});
afterEach(() => {
  vi.useRealTimers();
  vi.unstubAllGlobals();
  vi.unstubAllEnvs();
});

const harness = (settings = {}, { visible = false } = {}) => {
  const native = vi.fn(() => true);
  const ui = vi.fn(); const push = vi.fn(); const apns = vi.fn(); const channels = vi.fn(); const clearApns = vi.fn(async () => {});
  const runtime = createNotificationTriggerRuntime({
    readSettingsFromDisk: async () => ({ nativeNotificationsEnabled: true, notificationMode: 'hidden-only', locale: 'en', ...settings }),
    emitDesktopNotification: native, broadcastUiNotification: ui, sendPushToAllUiSessions: push,
    sendApnsToAllUiSessions: apns, clearApnsNotifications: clearApns,
    isAnyInteractiveClientVisible: () => visible, isAnyUiVisible: () => visible,
    deliverToExtensionChannels: channels,
    buildOpenCodeUrl: (value) => `http://localhost${value}`, getOpenCodeAuthHeaders: () => ({}),
  });
  return { runtime, native, ui, push, apns, channels, clearApns };
};

const answer = (label, sessionId = 'ses_1') => ({ sessionId, label, title: 'Migration schema', summary: `${label} picked B` });
const settle = async () => {
  await vi.advanceTimersByTimeAsync(2_500);
};

describe('shared page answer notifications', () => {
  it('announces one delivered answer everywhere, with the toast for open windows', async () => {
    const h = harness();
    h.runtime.notifyShareAnswer(answer('Yulia'));
    await settle();

    expect(h.native).toHaveBeenCalledTimes(1);
    expect(h.native.mock.calls[0][0]).toMatchObject({ kind: 'share-answer', title: 'Yulia answered “Migration schema”', body: 'Yulia picked B', tag: 'share-ses_1', sessionId: 'ses_1', directory: '/repo' });
    expect(h.ui).toHaveBeenCalledTimes(1);
    expect(h.ui.mock.calls[0][0]).toMatchObject({ kind: 'share-answer', showWhenFocused: true, toastOnly: false });
    expect(h.push.mock.calls[0][0]).toMatchObject({ tag: 'share-ses_1', data: { sessionId: 'ses_1', type: 'share-answer' } });
    expect(h.apns).toHaveBeenCalledTimes(1);
    expect(h.channels).toHaveBeenCalledTimes(1);
  });

  it('shows only the toast while a window is in use, and still fires once per answer', async () => {
    const h = harness({}, { visible: true });
    h.runtime.notifyShareAnswer(answer('Yulia'));
    await settle();
    expect(h.native).not.toHaveBeenCalled();
    expect(h.ui).toHaveBeenCalledTimes(1);
    expect(h.ui.mock.calls[0][0].toastOnly).toBe(true);
    expect(h.apns).not.toHaveBeenCalled();
    await settle();
    expect(h.ui).toHaveBeenCalledTimes(1);
  });

  it('collapses answers delivered close together into one notification about the newest', async () => {
    const h = harness({ locale: 'uk' });
    h.runtime.notifyShareAnswer(answer('Yulia', 'ses_1'));
    await vi.advanceTimersByTimeAsync(1_000);
    h.runtime.notifyShareAnswer(answer('Denis', 'ses_2'));
    await vi.advanceTimersByTimeAsync(1_000);
    h.runtime.notifyShareAnswer(answer('Denis', 'ses_3'));
    await settle();

    expect(h.ui).toHaveBeenCalledTimes(1);
    expect(h.ui.mock.calls[0][0]).toMatchObject({ title: 'Відповідей на поширені сторінки: 3', body: 'Yulia, Denis', sessionId: 'ses_3', tag: 'share-ses_3' });
  });

  it('stays silent with the completion toggle off', async () => {
    const h = harness({ notifyOnCompletion: false });
    h.runtime.notifyShareAnswer(answer('Yulia'));
    await settle();
    for (const sink of [h.native, h.ui, h.push, h.apns, h.channels]) expect(sink).not.toHaveBeenCalled();
  });

  it('keeps the name and the page title off outside channels in enterprise mode', async () => {
    vi.stubEnv('OPENCHAMBER_ENTERPRISE_MODE', '1');
    const h = harness();
    h.runtime.notifyShareAnswer(answer('Yulia'));
    await settle();
    expect(h.native.mock.calls[0][0].title).toContain('Yulia');
    expect(h.push.mock.calls[0][0]).toMatchObject({ title: 'A shared page was answered', body: '' });
    expect(JSON.stringify(h.push.mock.calls[0][0])).not.toMatch(/Yulia|Migration|Schema work/);
    expect(h.apns.mock.calls[0][0]).toMatchObject({ title: 'A shared page was answered', body: '' });
    expect(h.apns.mock.calls[0][0].sealed).toBeUndefined();
    expect(JSON.stringify(h.channels.mock.calls[0][0].notification)).not.toMatch(/Yulia|Migration|Schema work/);
  });

  // Clock-free: OpenCode's turnStartedAt may come from another machine's clock.
  const busy = (h, sessionId = 'ses_1', turnStartedAt = 1) => h.runtime.maybeSendPushForTrigger({ type: 'session.status', properties: { sessionID: sessionId, status: { type: 'busy' }, turnStartedAt } });

  it('survives the turn its own delivery woke after the notification and clears when the next one starts', async () => {
    const h = harness();
    h.runtime.notifyShareAnswer(answer('Yulia'));
    await settle();
    await busy(h, 'ses_1', 0);
    expect(h.clearApns).not.toHaveBeenCalled();
    await busy(h, 'ses_1', 0);
    expect(h.clearApns).toHaveBeenCalledTimes(1);
    expect(h.clearApns.mock.calls[0][0].tags[0]).toMatch(/^share-ses_1@/);
  });

  it('counts a wake that started during the collapse wait, so the next turn clears it', async () => {
    const h = harness();
    h.runtime.notifyShareAnswer(answer('Yulia'));
    await busy(h, 'ses_1', 9e15);
    await settle();
    expect(h.ui).toHaveBeenCalledTimes(1);
    await busy(h, 'ses_1', 0);
    expect(h.clearApns).toHaveBeenCalledTimes(1);
  });

  it('drops a waiting answer once its session is viewed or a later turn starts', async () => {
    const viewed = harness();
    viewed.runtime.notifyShareAnswer(answer('Yulia', 'ses_1'));
    viewed.runtime.notifyShareAnswer(answer('Denis', 'ses_2'));
    await viewed.runtime.clearSessionPushNotifications('ses_1');
    await settle();
    expect(viewed.ui).toHaveBeenCalledTimes(1);
    expect(viewed.ui.mock.calls[0][0]).toMatchObject({ title: 'Denis answered “Migration schema”', sessionId: 'ses_2' });

    const moved = harness();
    moved.runtime.notifyShareAnswer(answer('Yulia'));
    await busy(moved);
    await busy(moved);
    await settle();
    for (const sink of [moved.native, moved.ui, moved.push, moved.apns, moved.channels]) expect(sink).not.toHaveBeenCalled();
  });
});
