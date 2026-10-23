import { afterEach, describe, expect, it, vi } from 'vitest';
import { createNotificationTriggerRuntime } from './runtime.js';

const metadata = (notify) => ({ openchamber: { automation: { source: 'bot', botId: 'b1', itemId: 'i1', notify } } });
const settle = (status = 'complete') => ({ sessionId: 'ses_bot', directory: '/repo', status, title: 'Goal', body: 'Result' });
const finish = (directory = '/repo') => ({
  type: 'message.updated',
  properties: { directory, turnEnded: true, info: { sessionID: 'ses_bot', role: 'assistant', finish: 'stop' } },
});
const makeRuntime = ({ notify = 'attention', focused = false, failure = false, settings = {} } = {}) => {
  const fetchImpl = vi.fn(async () => failure
    ? new Response('unavailable', { status: 503 })
    : Response.json({ data: { id: 'ses_bot', title: 'Bot', metadata: metadata(notify) } }));
  vi.stubGlobal('fetch', fetchImpl);
  const recordNotification = vi.fn();
  const emitDesktopNotification = vi.fn(() => true);
  const broadcastUiNotification = vi.fn();
  const sendPushToAllUiSessions = vi.fn(async () => {});
  const sendApnsToAllUiSessions = vi.fn(async () => {});
  const runtime = createNotificationTriggerRuntime({
    readSettingsFromDisk: async () => ({ nativeNotificationsEnabled: true, notifyOnSubtasks: false, notificationMode: focused ? 'hidden-only' : 'always', ...settings }),
    prepareNotificationLastMessage: async ({ message }) => message,
    buildTemplateVariables: async () => ({}),
    extractLastMessageText: () => 'Result',
    fetchLastAssistantMessageText: async () => 'Result',
    resolveNotificationTemplate: () => '',
    shouldApplyResolvedTemplateMessage: () => false,
    buildOpenCodeUrl: (path) => `http://opencode.test${path}`,
    getOpenCodeAuthHeaders: () => ({}),
    getIsWindowFocused: () => focused,
    emitDesktopNotification, broadcastUiNotification, recordNotification,
    sendPushToAllUiSessions, sendApnsToAllUiSessions,
  });
  return { runtime, fetchImpl, recordNotification, emitDesktopNotification, broadcastUiNotification, sendPushToAllUiSessions, sendApnsToAllUiSessions };
};
afterEach(() => { vi.unstubAllGlobals(); vi.useRealTimers(); });

describe('automation delivery policy', () => {
  const botAttention = { action: { type: 'bots', projectId: 'project/one', itemId: 'item-one' }, requestId: 'item-one', title: 'Review the item', body: 'Destination changed', critical: false };

  it('delivers sessionless bot attention through existing push redaction and an item link without duplicating the center', async () => {
    const h = makeRuntime();
    await h.runtime.notifyBotAttention(botAttention);
    expect(h.recordNotification).not.toHaveBeenCalled();
    expect(h.fetchImpl).not.toHaveBeenCalled();
    expect(h.emitDesktopNotification).toHaveBeenCalledWith(expect.objectContaining({
      kind: 'bot', botTarget: { projectId: botAttention.action.projectId, itemId: botAttention.action.itemId },
    }));
    expect(h.sendPushToAllUiSessions).toHaveBeenCalledWith(expect.objectContaining({ tag: 'bot-item-one', data: {
      url: '/?botsProject=project%2Fone&botItem=item-one', type: 'bot',
    } }), { requireNoSse: true });
    expect(h.sendApnsToAllUiSessions).toHaveBeenCalledWith(expect.objectContaining({ title: 'Bot needs your attention', data: { url: '/?botsProject=project%2Fone&botItem=item-one' } }), { requireNoSse: true });
  });

  it('honors bot question and critical-error toggles and hidden-only focus', async () => {
    for (const options of [{ focused: true }, { settings: { notifyOnQuestion: false } }]) {
      const h = makeRuntime(options);
      await h.runtime.notifyBotAttention(botAttention);
      expect(h.emitDesktopNotification).not.toHaveBeenCalled();
      expect(h.sendPushToAllUiSessions).not.toHaveBeenCalled();
    }
    const h = makeRuntime({ settings: { notifyOnError: false } });
    await h.runtime.notifyBotAttention({ ...botAttention, critical: true });
    expect(h.sendPushToAllUiSessions).not.toHaveBeenCalled();
  });

  it.each([undefined, 'ses_stage'])('carries an item target through native and UI delivery with session=%s', async (sessionId) => {
    const h = makeRuntime();
    const action = { type: 'bots', projectId: 'project-one', itemId: 'item-one' };

    await h.runtime.notifyBotAttention({ ...botAttention, action, sessionId, directory: sessionId ? '/repo' : undefined });

    const expected = expect.objectContaining({ botTarget: { projectId: 'project-one', itemId: 'item-one' }, sessionId });
    expect(h.emitDesktopNotification).toHaveBeenCalledWith(expected);
    expect(h.broadcastUiNotification).toHaveBeenCalledWith(expected, { desktopNotificationDelivered: true });
  });

  it('keeps push delivery when native Bot notifications are disabled', async () => {
    const h = makeRuntime({ settings: { nativeNotificationsEnabled: false } });

    await h.runtime.notifyBotAttention(botAttention);

    expect(h.emitDesktopNotification).not.toHaveBeenCalled();
    expect(h.broadcastUiNotification).not.toHaveBeenCalled();
    expect(h.sendPushToAllUiSessions).toHaveBeenCalledTimes(1);
  });

  it.each([false, true])('records attention completion low and quiet, focused=%s', async (focused) => {
    const h = makeRuntime({ focused });
    await h.runtime.maybeSendPushForTrigger(finish());
    expect(h.recordNotification).toHaveBeenCalledWith(expect.objectContaining({ kind: 'ready', priority: 'low', delivery: 'quiet' }));
    expect(h.emitDesktopNotification).not.toHaveBeenCalled();
    expect(h.broadcastUiNotification).not.toHaveBeenCalled();
    expect(h.sendPushToAllUiSessions).not.toHaveBeenCalled();
    expect(h.sendApnsToAllUiSessions).not.toHaveBeenCalled();
    expect(h.fetchImpl).toHaveBeenCalledTimes(1);
  });

  it.each(['finish', undefined, 'invalid'])('preserves completion delivery for notify=%s', async (notify) => {
    const h = makeRuntime({ notify });
    // Use an explicit record for undefined, whose fixture default is attention.
    h.fetchImpl.mockResolvedValueOnce(Response.json({ data: { id: 'ses_bot', metadata: metadata(notify) } }));
    await h.runtime.maybeSendPushForTrigger(finish());
    expect(h.recordNotification).toHaveBeenCalledWith(expect.objectContaining({ priority: 'normal', delivery: 'delivered' }));
    expect(h.sendPushToAllUiSessions).toHaveBeenCalledTimes(1);
    expect(h.sendApnsToAllUiSessions).toHaveBeenCalledTimes(1);
  });

  it('keeps metadata across partial events and clears it on an authoritative update', async () => {
    vi.useFakeTimers();
    const h = makeRuntime();
    await h.runtime.maybeSendPushForTrigger({ type: 'session.created', properties: { sessionID: 'ses_bot', directory: '/repo', info: { id: 'ses_bot', metadata: metadata('attention') } } });
    await h.runtime.maybeSendPushForTrigger({ type: 'session.updated', properties: { sessionID: 'ses_bot', directory: '/repo', info: { id: 'ses_bot', cost: 1 } } });
    await h.runtime.maybeSendPushForTrigger(finish());
    expect(h.recordNotification).toHaveBeenLastCalledWith(expect.objectContaining({ delivery: 'quiet' }));
    await h.runtime.maybeSendPushForTrigger({ type: 'session.updated', properties: { sessionID: 'ses_bot', directory: '/repo', info: { id: 'ses_bot', metadata: {} } } });
    await vi.advanceTimersByTimeAsync(5001);
    await h.runtime.maybeSendPushForTrigger(finish());
    expect(h.recordNotification).toHaveBeenLastCalledWith(expect.objectContaining({ delivery: 'delivered' }));
    expect(h.fetchImpl).not.toHaveBeenCalled();
  });

  it('retries after a read failure rather than caching finish', async () => {
    vi.useFakeTimers();
    const h = makeRuntime({ failure: true });
    await h.runtime.maybeSendPushForTrigger(finish());
    expect(h.recordNotification).not.toHaveBeenCalled(); // Unknown parent stays suppressed.
    h.fetchImpl.mockImplementation(async () => Response.json({ data: { id: 'ses_bot', metadata: metadata('attention') } }));
    await h.runtime.maybeSendPushForTrigger(finish());
    expect(h.recordNotification).toHaveBeenCalledWith(expect.objectContaining({ delivery: 'quiet' }));
  });

  it('expires parent and automation policy together', async () => {
    vi.useFakeTimers();
    const h = makeRuntime();
    await h.runtime.maybeSendPushForTrigger(finish());
    await vi.advanceTimersByTimeAsync(60001);
    h.fetchImpl.mockImplementation(async () => Response.json({ data: { id: 'ses_bot', metadata: {} } }));
    await h.runtime.maybeSendPushForTrigger(finish());
    expect(h.recordNotification).toHaveBeenLastCalledWith(expect.objectContaining({ delivery: 'delivered' }));
    expect(h.fetchImpl).toHaveBeenCalledTimes(2);
  });

  it('records an attention goal completion low and quiet without alerts or push', async () => {
    const h = makeRuntime();
    await h.runtime.notifyGoalSettle(settle());
    expect(h.recordNotification).toHaveBeenCalledWith(expect.objectContaining({ kind: 'goal', priority: 'low', delivery: 'quiet' }));
    expect(h.emitDesktopNotification).not.toHaveBeenCalled();
    expect(h.broadcastUiNotification).not.toHaveBeenCalled();
    expect(h.sendPushToAllUiSessions).not.toHaveBeenCalled();
    expect(h.sendApnsToAllUiSessions).not.toHaveBeenCalled();
  });

  it.each(['blocked', 'budgetLimited'])('preserves high priority and push for an attention goal that is %s', async (status) => {
    const h = makeRuntime();
    await h.runtime.notifyGoalSettle(settle(status));
    expect(h.recordNotification).toHaveBeenCalledWith(expect.objectContaining({ priority: 'high', delivery: 'delivered' }));
    expect(h.emitDesktopNotification).toHaveBeenCalledTimes(1);
    expect(h.sendPushToAllUiSessions).toHaveBeenCalledTimes(1);
    expect(h.sendApnsToAllUiSessions).toHaveBeenCalledTimes(1);
  });

  it('preserves finish goal delivery when the policy read fails', async () => {
    const h = makeRuntime({ failure: true });
    await h.runtime.notifyGoalSettle(settle());
    expect(h.recordNotification).toHaveBeenCalledWith(expect.objectContaining({ priority: 'normal', delivery: 'delivered' }));
    expect(h.sendPushToAllUiSessions).toHaveBeenCalledTimes(1);
  });

  it.each(['question', 'permission', 'error'])('keeps %s high with alerts and push in an attention session', async (kind) => {
    vi.useFakeTimers();
    const h = makeRuntime();
    await h.runtime.maybeSendPushForTrigger({ type: 'session.created', properties: { sessionID: 'ses_bot', directory: '/repo', info: { id: 'ses_bot', metadata: metadata('attention') } } });
    const events = {
      question: { type: 'form.created', properties: { sessionID: 'ses_bot', directory: '/repo', form: { id: 'f1', sessionID: 'ses_bot', title: 'Choose', fields: [] } } },
      permission: { type: 'permission.asked', properties: { sessionID: 'ses_bot', directory: '/repo', id: 'p1', action: 'edit', resources: ['file'] } },
      error: { type: 'session.error', properties: { sessionID: 'ses_bot', directory: '/repo', error: { message: 'Failed' } } },
    };
    await h.runtime.maybeSendPushForTrigger(events[kind]);
    await vi.advanceTimersByTimeAsync(501);
    expect(h.recordNotification).toHaveBeenCalledWith(expect.objectContaining({ kind, priority: 'high', delivery: 'delivered' }));
    expect(h.sendPushToAllUiSessions).toHaveBeenCalledTimes(1);
    expect(h.sendApnsToAllUiSessions).toHaveBeenCalledTimes(1);
  });
});
