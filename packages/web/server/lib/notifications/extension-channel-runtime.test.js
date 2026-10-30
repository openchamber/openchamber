import { afterEach, describe, expect, it, vi } from 'vitest';

import { createOutboundHandles } from '../source-control/outbound-handles.js';
import { createExtensionNotificationChannels } from './extension-channels.js';
import { createNotificationTriggerRuntime } from './runtime.js';

const genericTitles = {
  ready: 'Agent response is ready',
  error: 'Agent hit an error',
  question: 'Agent needs your input',
  permission: 'Agent needs permission',
  review: 'Review finished',
  goal_complete: 'Goal complete',
  goal_blocked: 'Goal blocked',
  goal_budget: 'Goal reached its token budget',
};

const harness = async ({ settings = {}, visible = false } = {}) => {
  const delivered = [];
  const channels = createExtensionNotificationChannels({
    listGuests: async () => [{
      id: 'receiver', name: 'Receiver', packageRoot: '/receiver', capabilityGrants: ['service'],
      service: { runtime: 'host', entry: 'main.js', provides: ['notifications'] },
      notifications: { label: 'Receiver', instances: { kind: 'fixed', origin: 'https://receiver.example' }, token: { header: 'authorization', scheme: 'bearer' } },
    }],
    proxyServiceRequest: async ({ body }) => {
      delivered.push(JSON.parse(body).input.notification);
      return { status: 200, body: '{"ok":true,"data":{"delivered":true}}' };
    },
    persistPath: '/extensions.json',
    accounts: { read: async () => ({ instance: 'https://receiver.example', account: { id: '1', login: null, token: 'test-token', status: 'valid' } }) },
    handles: createOutboundHandles(),
    isAnyUiVisible: () => visible,
  });
  await channels.reconcile();
  const runtime = createNotificationTriggerRuntime({
    readSettingsFromDisk: async () => ({ nativeNotificationsEnabled: true, notificationMode: 'always', ...settings }),
    prepareNotificationLastMessage: async ({ message }) => message,
    buildTemplateVariables: async () => ({ session_name: 'Private session', last_message: 'Private reply' }),
    extractLastMessageText: () => 'Private reply',
    fetchLastAssistantMessageText: async () => 'Private reply',
    resolveNotificationTemplate: () => 'Private template',
    shouldApplyResolvedTemplateMessage: () => true,
    emitDesktopNotification: () => true,
    broadcastUiNotification: () => {},
    sendPushToAllUiSessions: async () => {},
    sendApnsToAllUiSessions: async () => {},
    isAnyInteractiveClientVisible: () => visible,
    buildOpenCodeUrl: (path) => `http://opencode.test${path}`,
    getOpenCodeAuthHeaders: () => ({}),
    getIsSessionAutoAccepting: async () => false,
    deliverToExtensionChannels: channels.deliver,
  });
  const trigger = async (kind) => {
    const properties = { sessionID: `ses_${kind}`, directory: '/private/repo' };
    if (kind === 'ready') await runtime.maybeSendPushForTrigger({ type: 'session.idle', properties });
    if (kind === 'error') await runtime.maybeSendPushForTrigger({ type: 'session.error', properties: { ...properties, error: { type: 'Error', message: 'Private error' } } });
    if (kind === 'question') await runtime.maybeSendPushForTrigger({ type: 'form.created', properties: { ...properties, form: { id: 'form_1', sessionID: properties.sessionID, title: 'Private question', fields: [{ title: 'Private field' }] } } });
    if (kind === 'permission') await runtime.maybeSendPushForTrigger({ type: 'permission.asked', properties: { ...properties, id: 'permission_1', action: 'bash', resources: ['private command'] } });
    if (kind === 'review') await runtime.notifyAutoReviewEnded({ sessionId: properties.sessionID, directory: properties.directory, status: 'clean' });
    if (kind.startsWith('goal_')) await runtime.sendGoalSettlePush({ sessionId: properties.sessionID, directory: properties.directory, status: { goal_complete: 'complete', goal_blocked: 'blocked', goal_budget: 'budgetLimited' }[kind], title: 'Private goal', body: 'Private body' });
    await vi.advanceTimersByTimeAsync(600);
  };
  return { delivered, trigger };
};

afterEach(() => {
  vi.useRealTimers();
  vi.unstubAllGlobals();
  vi.unstubAllEnvs();
});

describe('extension channel notification boundary', () => {
  const setup = () => {
    vi.useFakeTimers();
    vi.stubGlobal('fetch', vi.fn(async (input) => Response.json({ data: String(input).includes('/active') ? {} : { id: 'ses_1', title: 'Private session' } })));
  };

  it('strips content for ready, error, question, permission and every settle kind in enterprise mode', async () => {
    setup();
    vi.stubEnv('OPENCHAMBER_ENTERPRISE_MODE', 'true');
    const h = await harness();
    for (const kind of Object.keys(genericTitles)) await h.trigger(kind);
    expect(h.delivered.map(({ kind }) => kind)).toEqual(Object.keys(genericTitles));
    for (const notice of h.delivered) {
      expect(notice).toMatchObject({ title: genericTitles[notice.kind], body: '', sessionName: null, directory: null });
      expect(notice.sessionId).toBe(`ses_${notice.kind}`);
      expect(notice.url).toBe(`/?session=ses_${notice.kind}`);
    }
    expect(JSON.stringify(h.delivered)).not.toMatch(/Private|private/);
  });

  it('keeps content outside enterprise mode', async () => {
    setup();
    vi.stubEnv('OPENCHAMBER_ENTERPRISE_MODE', 'false');
    const h = await harness();
    for (const kind of Object.keys(genericTitles)) await h.trigger(kind);
    expect(h.delivered).toHaveLength(8);
    for (const notice of h.delivered) expect(notice).toMatchObject({ sessionName: 'Private session', directory: '/private/repo' });
    expect(h.delivered.some(({ body }) => body.includes('Private'))).toBe(true);
  });

  it('obeys kind toggles and suppresses delivery while a client is visible unless always', async () => {
    setup();
    const disabled = await harness({ settings: { notifyOnCompletion: false, notifyOnError: false, notifyOnQuestion: false } });
    for (const kind of ['ready', 'error', 'question', 'permission', 'review']) await disabled.trigger(kind);
    expect(disabled.delivered).toEqual([]);
    const visible = await harness({ visible: true, settings: { notificationMode: 'hidden-only' } });
    for (const kind of Object.keys(genericTitles)) await visible.trigger(kind);
    expect(visible.delivered).toEqual([]);
    const always = await harness({ visible: true });
    await always.trigger('ready');
    expect(always.delivered).toHaveLength(1);
  });
});
