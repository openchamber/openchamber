import { afterEach, describe, expect, it, vi } from 'vitest';
import { createNotificationTriggerRuntime } from './runtime.js';

afterEach(() => { vi.unstubAllGlobals(); vi.unstubAllEnvs(); });

// Every kind names its session, except a pull request; browser help also names its guest.
const session = { sessionId: 'ses_agent', directory: '/agent/project' };
const kindFields = { 'pull-request': {}, 'browser-help': { ...session, guestId: 'server-browser' } };
const event = (kind, properties = {}) => ({
  type: 'openchamber:notification', origin: 'agent', spaceId: null,
  properties: {
    kind, title: 'Private result', body: 'Private detail', tag: `notice-${kind}`, origin: 'agent', spaceId: null,
    ...(kindFields[kind] ?? session),
    ...properties,
  },
});
const kinds = ['goal', 'review', 'share-answer', 'browser-help', 'pull-request'];
const setup = ({ settings = {}, visible = false, focused = false, goalStatus = 'complete', failMetadata = false } = {}) => {
  const fetchImpl = vi.fn(async () => {
    if (failMetadata) throw new Error('agent_unreachable');
    return Response.json({ data: { title: 'Private session', metadata: { openchamber: { goal: { status: goalStatus } } } } });
  });
  const sendPushToAllUiSessions = vi.fn(async () => {});
  const sendApnsToAllUiSessions = vi.fn(async () => {});
  const clearApnsNotifications = vi.fn(async () => {});
  const readSettingsFromDisk = vi.fn(async () => ({ nativeNotificationsEnabled: true, notificationMode: 'always', ...settings }));
  const emitDesktopNotification = vi.fn();
  const broadcastUiNotification = vi.fn();
  const deliverToExtensionChannels = vi.fn();
  const buildTemplateVariables = vi.fn(async () => { throw new Error('local metadata is forbidden'); });
  const runtime = createNotificationTriggerRuntime({
    readSettingsFromDisk, sendPushToAllUiSessions, sendApnsToAllUiSessions, clearApnsNotifications,
    fetchImpl, buildOpenCodeUrl: (route) => `http://agent.test${route}`, getOpenCodeAuthHeaders: () => ({}),
    isAnyInteractiveClientVisible: () => visible, getIsWindowFocused: () => focused,
    emitDesktopNotification, broadcastUiNotification, deliverToExtensionChannels, buildTemplateVariables,
  });
  vi.stubGlobal('fetch', vi.fn(async () => { throw new Error('raw fetch is forbidden'); }));
  return { runtime, fetchImpl, readSettingsFromDisk, sendPushToAllUiSessions, sendApnsToAllUiSessions, clearApnsNotifications, emitDesktopNotification, broadcastUiNotification, deliverToExtensionChannels, buildTemplateVariables };
};

describe('owner push delivery for agent runtime announcements', () => {
  it.each(kinds)('delivers %s through owner device senders without another UI notification', async (kind) => {
    const owner = setup();
    await owner.runtime.deliverAgentNotification(event(kind));
    expect(owner.sendPushToAllUiSessions).toHaveBeenCalledTimes(1);
    expect(owner.sendApnsToAllUiSessions).toHaveBeenCalledTimes(1);
    expect(owner.sendPushToAllUiSessions.mock.calls[0][1]).toEqual({ requireNoSse: true });
    expect(owner.emitDesktopNotification).not.toHaveBeenCalled();
    expect(owner.broadcastUiNotification).not.toHaveBeenCalled();
    expect(owner.deliverToExtensionChannels).not.toHaveBeenCalled();
    expect(owner.buildTemplateVariables).not.toHaveBeenCalled();
    expect(globalThis.fetch).not.toHaveBeenCalled();
    expect(owner.fetchImpl).toHaveBeenCalledTimes(['goal', 'review', 'share-answer'].includes(kind) ? 1 : 0);
    const data = owner.sendPushToAllUiSessions.mock.calls[0][0].data;
    if (kind === 'browser-help') expect(data.url).toBe('/?session=ses_agent&panel=server-browser');
    if (kind === 'pull-request') expect(data).toEqual({ url: '/', type: 'pull-request' });
    if (kind === 'goal' || kind === 'review') expect(data.sessionName).toBe('Private session');
  });

  it.each(kinds)('sends no %s push when owner native notifications are off', async (kind) => {
    const owner = setup({ settings: { nativeNotificationsEnabled: false } });
    await owner.runtime.deliverAgentNotification(event(kind));
    expect(owner.sendPushToAllUiSessions).not.toHaveBeenCalled();
    expect(owner.sendApnsToAllUiSessions).not.toHaveBeenCalled();
    expect(owner.fetchImpl).not.toHaveBeenCalled();
  });

  it.each(['goal', 'review', 'share-answer'])('gates %s with the owner completion toggle', async (kind) => {
    const owner = setup({ settings: { notifyOnCompletion: false } });
    await owner.runtime.deliverAgentNotification(event(kind));
    expect(owner.sendPushToAllUiSessions).not.toHaveBeenCalled();
    expect(owner.sendApnsToAllUiSessions).not.toHaveBeenCalled();
  });

  it.each(['goal', 'review', 'share-answer'])('clears delegated %s pushes under their canonical session tag', async (kind) => {
    const owner = setup();
    await owner.runtime.deliverAgentNotification(event(kind));
    const push = owner.sendPushToAllUiSessions.mock.calls[0][0];
    const tag = `${kind === 'share-answer' ? 'share' : kind}-ses_agent`;
    expect(push.tag).toBe(tag);
    expect(push.data.nid).toBeTypeOf('string');
    await owner.runtime.clearSessionPushNotifications('ses_agent');
    expect(owner.clearApnsNotifications).toHaveBeenCalledExactlyOnceWith({ tags: [`${tag}@${push.data.nid}`], badge: 0 });
  });

  it('drops a delegated settlement viewed while its metadata was being read', async () => {
    const owner = setup();
    let resolveMetadata;
    owner.fetchImpl.mockImplementationOnce(() => new Promise((resolve) => { resolveMetadata = resolve; }));
    const pending = owner.runtime.deliverAgentNotification(event('goal'));
    await vi.waitFor(() => expect(owner.fetchImpl).toHaveBeenCalledTimes(1));
    await owner.runtime.clearSessionPushNotifications('ses_agent');
    resolveMetadata(Response.json({ data: { title: 'Private session' } }));
    await pending;
    expect(owner.sendPushToAllUiSessions).not.toHaveBeenCalled();
    expect(owner.sendApnsToAllUiSessions).not.toHaveBeenCalled();
  });

  it('keeps a toast-only shared answer off owner device push', async () => {
    const owner = setup();
    await owner.runtime.deliverAgentNotification(event('share-answer', { toastOnly: true, showWhenFocused: true }));
    expect(owner.fetchImpl).not.toHaveBeenCalled();
    expect(owner.sendPushToAllUiSessions).not.toHaveBeenCalled();
    expect(owner.sendApnsToAllUiSessions).not.toHaveBeenCalled();
  });

  it('keeps a delegated shared answer through the turn its delivery wakes', async () => {
    const owner = setup();
    await owner.runtime.deliverAgentNotification(event('share-answer', { skipTurnStart: true }));
    await owner.runtime.clearSessionPushNotifications('ses_agent', { turnStart: true });
    expect(owner.clearApnsNotifications).not.toHaveBeenCalled();
    await owner.runtime.clearSessionPushNotifications('ses_agent', { turnStart: true });
    expect(owner.clearApnsNotifications).toHaveBeenCalledTimes(1);
  });

  it('gates PR updates independently and keeps browser help independent of question and notify-tool toggles', async () => {
    const off = setup({ settings: { notifyOnPullRequests: false } });
    await off.runtime.deliverAgentNotification(event('pull-request'));
    expect(off.sendPushToAllUiSessions).not.toHaveBeenCalled();
    const on = setup({ settings: { notifyOnCompletion: false, notifyOnQuestion: false, agentNotifyToolEnabled: false } });
    await on.runtime.deliverAgentNotification(event('pull-request'));
    await on.runtime.deliverAgentNotification(event('browser-help'));
    expect(on.sendPushToAllUiSessions).toHaveBeenCalledTimes(2);
  });

  it.each(['ready', 'error', 'question', 'permission', 'plugin'])('keeps %s on its existing delivery path', async (kind) => {
    const owner = setup();
    await owner.runtime.deliverAgentNotification(event(kind, { guestId: 'server-browser', tag: 'browser-help-ses_agent' }));
    expect(owner.readSettingsFromDisk).not.toHaveBeenCalled();
    expect(owner.fetchImpl).not.toHaveBeenCalled();
    expect(owner.sendPushToAllUiSessions).not.toHaveBeenCalled();
    expect(owner.sendApnsToAllUiSessions).not.toHaveBeenCalled();
  });

  it.each(kinds)('applies enterprise content stripping to %s through the existing fanout', async (kind) => {
    vi.stubEnv('OPENCHAMBER_ENTERPRISE_MODE', 'true');
    const owner = setup();
    await owner.runtime.deliverAgentNotification(event(kind));
    const web = owner.sendPushToAllUiSessions.mock.calls[0][0];
    const native = owner.sendApnsToAllUiSessions.mock.calls[0][0];
    expect(web.body).toBe('');
    expect(web.data.sessionName).toBeUndefined();
    expect(native.body).toBe('');
    expect(native.sealed).toBeUndefined();
    expect(JSON.stringify([web, native])).not.toMatch(/Private|agent\/project/);
    if (kind === 'goal') expect(native.title).toBe('Goal complete');
  });

  it.each(['review', 'pull-request'])('honors hidden-only focus suppression for %s', async (kind) => {
    const owner = setup({ settings: { notificationMode: 'hidden-only' }, focused: true });
    await owner.runtime.deliverAgentNotification(event(kind));
    expect(owner.sendPushToAllUiSessions).not.toHaveBeenCalled();
    expect(owner.fetchImpl).not.toHaveBeenCalled();
  });

  it('keeps the existing native-device visibility suppression', async () => {
    const owner = setup({ visible: true });
    await owner.runtime.deliverAgentNotification(event('browser-help'));
    expect(owner.sendPushToAllUiSessions).toHaveBeenCalledTimes(1);
    expect(owner.sendApnsToAllUiSessions).not.toHaveBeenCalled();
  });

  it.each([
    ['complete', 'goal_complete'], ['budgetLimited', 'goal_budget'], ['blocked', 'goal_blocked'],
  ])('uses explicit goal settlement %s when a fix loop has no goal metadata', async (goalStatus, type) => {
    const owner = setup({ goalStatus: 'active' });
    await owner.runtime.deliverAgentNotification(event('goal', { goalStatus }));
    expect(owner.sendPushToAllUiSessions.mock.calls[0][0].data.type).toBe(type);
  });

  it('keeps metadata failure display-only and uses no local discovery or raw fetch', async () => {
    const owner = setup({ failMetadata: true });
    await owner.runtime.deliverAgentNotification(event('goal'));
    expect(owner.sendPushToAllUiSessions.mock.calls[0][0].data).toMatchObject({ sessionName: '', type: 'goal' });
    expect(owner.sendApnsToAllUiSessions.mock.calls[0][0].title).toBe('Agent update');
    expect(owner.buildTemplateVariables).not.toHaveBeenCalled();
    expect(globalThis.fetch).not.toHaveBeenCalled();
  });

  it('rejects malformed, oversized and foreign-origin events and strips arbitrary delivery fields', async () => {
    const owner = setup();
    for (const payload of [null, event('goal', { title: 'x'.repeat(1001) }), event('browser-help', { guestId: null }), { ...event('review'), origin: 'host' }, { ...event('goal'), spaceId: 'claimed' }]) {
      await owner.runtime.deliverAgentNotification(payload);
    }
    expect(owner.sendPushToAllUiSessions).not.toHaveBeenCalled();
    await owner.runtime.deliverAgentNotification(event('goal', { data: { url: 'https://external.test', token: 'private-token' }, deviceToken: 'private-token', sealed: { title: 'forged' } }));
    expect(owner.sendPushToAllUiSessions).toHaveBeenCalledTimes(1);
    expect(JSON.stringify(owner.sendPushToAllUiSessions.mock.calls)).not.toMatch(/external\.test|private-token|forged/);
  });
});
