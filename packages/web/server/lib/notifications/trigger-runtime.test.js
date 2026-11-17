import { afterEach, describe, expect, it, vi } from 'vitest';

import { createNotificationTriggerRuntime } from './runtime.js';
import { createNotificationTemplateRuntime } from './template-runtime.js';

/**
 * The "ready" push is built from the translated `message.updated` events.
 * v2 splits a turn: the step start names agent and model, the step end
 * carries the finish. What is pinned here: the finish is announced with the
 * agent and model from the start, a user abort announces nothing, and an
 * active goal (which lives in OpenChamber's own metadata) silences the push.
 */
const makeRuntime = ({ metadata = {} } = {}) => {
  const emitDesktopNotification = vi.fn(() => true);
  const runtime = createNotificationTriggerRuntime({
    readSettingsFromDisk: async () => ({ nativeNotificationsEnabled: true, notificationMode: 'always', notifyOnCompletion: true }),
    prepareNotificationLastMessage: async ({ message }) => message,
    buildTemplateVariables: async () => ({}),
    extractLastMessageText: () => 'done',
    fetchLastAssistantMessageText: async () => 'done',
    resolveNotificationTemplate: () => '',
    shouldApplyResolvedTemplateMessage: () => false,
    emitDesktopNotification,
    broadcastUiNotification: vi.fn(),
    sendPushToAllUiSessions: vi.fn(async () => undefined),
    sendApnsToAllUiSessions: vi.fn(async () => undefined),
    isAnyInteractiveClientVisible: () => true,
    buildOpenCodeUrl: (path) => `http://opencode.test${path}`,
    getOpenCodeAuthHeaders: () => ({}),
    readSessionMetadata: async () => metadata,
  });
  return { runtime, emitDesktopNotification };
};

const stepStarted = (sessionID, id) => ({
  type: 'message.updated',
  properties: { sessionID, info: { id, sessionID, role: 'assistant', agent: 'build', providerID: 'anthropic', modelID: 'claude-sonnet-5', time: { created: 1 } } },
});
const stepEnded = (sessionID, id) => ({
  type: 'message.updated',
  properties: { sessionID, info: { id, sessionID, role: 'assistant', finish: 'stop', time: { completed: 2 } } },
});

const turnEnded = (sessionID) => ({ type: 'session.idle', properties: { sessionID } });

describe('ready notification on v2 step events', () => {
  it('announces the turn end with the agent and model of its last step', async () => {
    vi.spyOn(console, 'warn').mockImplementation(() => {});
    const { runtime, emitDesktopNotification } = makeRuntime();

    await runtime.maybeSendPushForTrigger(stepStarted('ses_1', 'msg_1'));
    expect(emitDesktopNotification).not.toHaveBeenCalled();

    // A step's `stop` is not the end of the turn: the execution may still
    // drain steering input, so only its idle event announces readiness.
    await runtime.maybeSendPushForTrigger(stepEnded('ses_1', 'msg_1'));
    expect(emitDesktopNotification).not.toHaveBeenCalled();

    await runtime.maybeSendPushForTrigger(turnEnded('ses_1'));
    expect(emitDesktopNotification).toHaveBeenCalledTimes(1);
    expect(emitDesktopNotification.mock.calls[0][0]).toMatchObject({
      kind: 'ready',
      title: 'Build agent is ready',
      body: 'Claude Sonnet 5 completed the task',
    });
  });

  it('announces nothing for a user abort', async () => {
    const { runtime, emitDesktopNotification } = makeRuntime();

    await runtime.maybeSendPushForTrigger({
      type: 'session.idle',
      properties: { sessionID: 'ses_2', aborted: true, reason: 'user', error: { name: 'MessageAbortedError', message: 'aborted' } },
    });

    expect(emitDesktopNotification).not.toHaveBeenCalled();
  });

  it('stays quiet while a goal from OpenChamber\'s own metadata is active', async () => {
    const { runtime, emitDesktopNotification } = makeRuntime({
      metadata: { openchamber: { goal: { id: 'g', status: 'active', objective: 'x' } } },
    });

    await runtime.maybeSendPushForTrigger(stepStarted('ses_3', 'msg_3'));
    await runtime.maybeSendPushForTrigger(stepEnded('ses_3', 'msg_3'));
    await runtime.maybeSendPushForTrigger(turnEnded('ses_3'));

    expect(emitDesktopNotification).not.toHaveBeenCalled();
  });
});

describe('ready notification while background subagents run', () => {
  const stubOpenCode = ({ active, children }) => {
    vi.stubGlobal('fetch', vi.fn(async (input) => {
      const url = new URL(String(input));
      if (url.pathname === '/api/session/active') return Response.json({ data: active() });
      if (url.pathname === '/api/session') return Response.json({ data: children, cursor: {} });
      return Response.json({});
    }));
  };

  it('stays silent on the pause and announces the real turn end', async () => {
    vi.spyOn(console, 'warn').mockImplementation(() => {});
    let active = { ses_child: { type: 'running' } };
    stubOpenCode({ active: () => active, children: [{ id: 'ses_child', parentID: 'ses_1' }] });
    const { runtime, emitDesktopNotification } = makeRuntime();

    await runtime.maybeSendPushForTrigger(stepStarted('ses_1', 'msg_1'));
    await runtime.maybeSendPushForTrigger(turnEnded('ses_1'));
    expect(emitDesktopNotification).not.toHaveBeenCalled();

    // The subagent finished and OpenCode ran the parent again with its result.
    active = {};
    await runtime.maybeSendPushForTrigger(turnEnded('ses_1'));
    expect(emitDesktopNotification).toHaveBeenCalledTimes(1);
    vi.unstubAllGlobals();
  });

  it('announces the idle when the subagent check cannot be made', async () => {
    vi.spyOn(console, 'warn').mockImplementation(() => {});
    vi.stubGlobal('fetch', vi.fn(async () => new Response('down', { status: 503 })));
    const { runtime, emitDesktopNotification } = makeRuntime();

    await runtime.maybeSendPushForTrigger(stepStarted('ses_1', 'msg_1'));
    await runtime.maybeSendPushForTrigger(turnEnded('ses_1'));
    expect(emitDesktopNotification).toHaveBeenCalledTimes(1);
    vi.unstubAllGlobals();
  });
});

describe('push content in enterprise mode', () => {
  const makePushRuntime = () => {
    const sendPushToAllUiSessions = vi.fn(async () => undefined);
    const sendApnsToAllUiSessions = vi.fn(async () => undefined);
    const runtime = createNotificationTriggerRuntime({
      readSettingsFromDisk: async () => ({ nativeNotificationsEnabled: true, notificationMode: 'always', notifyOnCompletion: true }),
      prepareNotificationLastMessage: async ({ message }) => message,
      buildTemplateVariables: async () => ({ session_name: 'Fix the billing export' }),
      extractLastMessageText: () => 'The customer table is migrated',
      fetchLastAssistantMessageText: async () => 'The customer table is migrated',
      resolveNotificationTemplate: (template, variables) => template.replace('{last_message}', variables.last_message ?? ''),
      shouldApplyResolvedTemplateMessage: () => true,
      emitDesktopNotification: vi.fn(() => true),
      broadcastUiNotification: vi.fn(),
      sendPushToAllUiSessions,
      sendApnsToAllUiSessions,
      isAnyInteractiveClientVisible: () => false,
      buildOpenCodeUrl: (path) => `http://opencode.test${path}`,
      getOpenCodeAuthHeaders: () => ({}),
      readSessionMetadata: async () => ({}),
    });
    return { runtime, sendPushToAllUiSessions, sendApnsToAllUiSessions };
  };

  it('sends only the scenario title and the deep link, on both channels', async () => {
    vi.spyOn(console, 'warn').mockImplementation(() => {});
    vi.stubGlobal('fetch', vi.fn(async () => Response.json({ data: {} })));
    process.env.OPENCHAMBER_ENTERPRISE_MODE = 'true';
    try {
      const { runtime, sendPushToAllUiSessions, sendApnsToAllUiSessions } = makePushRuntime();
      await runtime.maybeSendPushForTrigger(stepStarted('ses_e', 'msg_e'));
      await runtime.maybeSendPushForTrigger(turnEnded('ses_e'));

      const web = sendPushToAllUiSessions.mock.calls[0][0];
      expect(web).toMatchObject({ title: 'Agent response is ready', body: '', data: { sessionId: 'ses_e', type: 'ready' } });
      expect(web.data.sessionName).toBeUndefined();
      expect(sendApnsToAllUiSessions.mock.calls[0][0]).toMatchObject({ title: 'Agent response is ready', body: '' });
      expect(sendApnsToAllUiSessions.mock.calls[0][0].sealed).toBeUndefined();
      expect(JSON.stringify([web, sendApnsToAllUiSessions.mock.calls[0][0]])).not.toMatch(/billing|customer/);
    } finally {
      delete process.env.OPENCHAMBER_ENTERPRISE_MODE;
      vi.unstubAllGlobals();
    }
  });

  it('gives a phone with a push key the session name and the reply', async () => {
    vi.spyOn(console, 'warn').mockImplementation(() => {});
    vi.stubGlobal('fetch', vi.fn(async () => Response.json({ data: {} })));
    try {
      const { runtime, sendPushToAllUiSessions, sendApnsToAllUiSessions } = makePushRuntime();
      await runtime.maybeSendPushForTrigger(stepStarted('ses_p', 'msg_p'));
      await runtime.maybeSendPushForTrigger(turnEnded('ses_p'));

      const apns = sendApnsToAllUiSessions.mock.calls[0][0];
      // The clear text stays generic; the reply rides only in `sealed`.
      expect(apns).toMatchObject({ title: 'Agent response is ready', body: 'Fix the billing export' });
      expect(apns.sealed).toEqual({ title: 'Fix the billing export', body: 'The customer table is migrated' });
      expect(sendPushToAllUiSessions.mock.calls[0][0].phoneBody).toBeUndefined();
    } finally {
      vi.unstubAllGlobals();
    }
  });
});

describe('phone text for permissions and questions', () => {
  const makeAskRuntime = () => {
    const sendApnsToAllUiSessions = vi.fn(async () => undefined);
    const emitDesktopNotification = vi.fn(() => true);
    const runtime = createNotificationTriggerRuntime({
      readSettingsFromDisk: async () => ({ nativeNotificationsEnabled: true, notificationMode: 'always', notifyOnQuestion: true }),
      buildTemplateVariables: async () => ({ session_name: 'Fix login redirect loop' }),
      resolveNotificationTemplate: (template, variables) => template.replace('{last_message}', variables.last_message ?? ''),
      shouldApplyResolvedTemplateMessage: () => true,
      emitDesktopNotification,
      broadcastUiNotification: vi.fn(),
      sendPushToAllUiSessions: vi.fn(async () => undefined),
      sendApnsToAllUiSessions,
      isAnyInteractiveClientVisible: () => false,
      getIsSessionAutoAccepting: async () => false,
    });
    return { runtime, sendApnsToAllUiSessions, emitDesktopNotification };
  };

  const permissionAsked = (id, action, resources) => ({
    type: 'permission.asked',
    properties: { sessionID: 'ses_1', id, action, resources },
  });

  it('names the command or file the agent wants, on the phone and on desktop', async () => {
    vi.useFakeTimers();
    const { runtime, sendApnsToAllUiSessions, emitDesktopNotification } = makeAskRuntime();

    await runtime.maybeSendPushForTrigger(permissionAsked('per_1', 'bash', ['git push origin bohdan/dev']));
    await vi.advanceTimersByTimeAsync(600);
    await runtime.maybeSendPushForTrigger(permissionAsked('per_2', 'edit', ['~/.ssh/config']));
    await vi.advanceTimersByTimeAsync(600);
    await runtime.maybeSendPushForTrigger(permissionAsked('per_3', 'webfetch', ['https://example.com']));
    await vi.advanceTimersByTimeAsync(600);
    vi.useRealTimers();

    expect(sendApnsToAllUiSessions.mock.calls.map(([payload]) => payload.sealed)).toEqual([
      { title: 'Fix login redirect loop', body: 'Wants to run: git push origin bohdan/dev' },
      { title: 'Fix login redirect loop', body: 'Wants to edit: ~/.ssh/config' },
      { title: 'Fix login redirect loop', body: 'Wants permission: webfetch: https://example.com' },
    ]);
    expect(emitDesktopNotification.mock.calls[0][0].body).toBe('bash: git push origin bohdan/dev');
  });

  it('puts the question on the phone', async () => {
    vi.useFakeTimers();
    const { runtime, sendApnsToAllUiSessions } = makeAskRuntime();

    await runtime.maybeSendPushForTrigger({
      type: 'form.created',
      properties: {
        sessionID: 'ses_1',
        form: { id: 'frm_1', sessionID: 'ses_1', title: 'Logout', fields: [{ key: 'q', type: 'string', title: 'Should logout also forget the remembered device?' }] },
      },
    });
    await vi.advanceTimersByTimeAsync(600);
    vi.useRealTimers();

    expect(sendApnsToAllUiSessions.mock.calls[0][0].sealed).toEqual({
      title: 'Fix login redirect loop',
      body: 'Question: Should logout also forget the remembered device?',
    });
  });
});

// A permission request or question raised by a subagent at any depth is
// answered from the highest session above it in the same directory, whose
// composer docks every request below it, so the alert opens that session. Its
// text still names the session that asked.
describe('alerts about a nested subagent\'s request', () => {
  // OpenCode answers `GET /api/session/:id` as `{ data }`, with the session's
  // current directory as `location.directory`. The default tree is root →
  // child → grandchild, all in /repo.
  const sameDirectory = {
    ses_root: { directory: '/repo' },
    ses_child: { parentID: 'ses_root', directory: '/repo' },
    ses_grandchild: { parentID: 'ses_child', directory: '/repo' },
  };
  const stubLineage = (records = sameDirectory) => vi.stubGlobal('fetch', vi.fn(async (input) => {
    const id = decodeURIComponent(new URL(String(input)).pathname.replace('/api/session/', ''));
    const record = records[id];
    if (!record) return new Response(null, { status: 503 });
    return Response.json({ data: { id, parentID: record.parentID, location: { directory: record.directory } } });
  }));
  const makeNestedRuntime = () => {
    const emitDesktopNotification = vi.fn(() => true);
    const broadcastUiNotification = vi.fn();
    const sendPushToAllUiSessions = vi.fn(async () => undefined);
    const sendApnsToAllUiSessions = vi.fn(async () => undefined);
    const runtime = createNotificationTriggerRuntime({
      readSettingsFromDisk: async () => ({ nativeNotificationsEnabled: true, notificationMode: 'always', notifyOnQuestion: true }),
      buildTemplateVariables: async () => ({ session_name: 'Level two' }),
      resolveNotificationTemplate: (template, variables) => template.replace('{last_message}', variables.last_message ?? ''),
      shouldApplyResolvedTemplateMessage: () => true,
      emitDesktopNotification,
      broadcastUiNotification,
      sendPushToAllUiSessions,
      sendApnsToAllUiSessions,
      isAnyInteractiveClientVisible: () => false,
      buildOpenCodeUrl: (path) => `http://opencode.test${path}`,
      getOpenCodeAuthHeaders: () => ({}),
      getIsSessionAutoAccepting: async () => false,
    });
    return { runtime, emitDesktopNotification, broadcastUiNotification, sendPushToAllUiSessions, sendApnsToAllUiSessions };
  };
  const trigger = async (runtime, payload, delivered) => {
    vi.useFakeTimers();
    try {
      await runtime.maybeSendPushForTrigger(payload);
      await vi.advanceTimersByTimeAsync(600);
      await vi.waitFor(() => expect(delivered).toHaveBeenCalled());
    } finally {
      vi.useRealTimers();
    }
  };

  it('opens a grandchild\'s permission request in the root on every channel', async () => {
    stubLineage();
    try {
      const { runtime, emitDesktopNotification, broadcastUiNotification, sendPushToAllUiSessions, sendApnsToAllUiSessions } = makeNestedRuntime();
      await trigger(runtime, {
        type: 'permission.asked',
        properties: { sessionID: 'ses_grandchild', directory: '/repo', id: 'per_1', action: 'bash', resources: ['echo ok'] },
      }, sendApnsToAllUiSessions);

      const native = emitDesktopNotification.mock.calls[0][0];
      expect(native).toMatchObject({ kind: 'permission', sessionId: 'ses_root', directory: '/repo', tag: 'permission-ses_grandchild:per_1' });
      expect(broadcastUiNotification.mock.calls[0][0]).toMatchObject({ sessionId: 'ses_root' });
      expect(sendPushToAllUiSessions.mock.calls[0][0].data).toMatchObject({ url: '/?session=ses_root', sessionId: 'ses_root', sessionName: 'Level two' });
      expect(sendApnsToAllUiSessions.mock.calls[0][0]).toMatchObject({ body: 'Level two', data: { sessionId: 'ses_root' } });
    } finally {
      vi.unstubAllGlobals();
    }
  });

  it('opens a grandchild\'s question in the root', async () => {
    stubLineage();
    try {
      const { runtime, emitDesktopNotification, sendPushToAllUiSessions } = makeNestedRuntime();
      await trigger(runtime, {
        type: 'form.created',
        properties: { sessionID: 'ses_grandchild', directory: '/repo', form: { id: 'frm_1', sessionID: 'ses_grandchild', title: 'Pick a layout', fields: [] } },
      }, sendPushToAllUiSessions);

      expect(emitDesktopNotification.mock.calls[0][0]).toMatchObject({ kind: 'question', sessionId: 'ses_root', tag: 'question-ses_grandchild' });
      expect(sendPushToAllUiSessions.mock.calls[0][0].data).toMatchObject({ url: '/?session=ses_root', sessionId: 'ses_root', sessionName: 'Level two' });
    } finally {
      vi.unstubAllGlobals();
    }
  });

  it('keeps a top-level session\'s own request in that session and its directory', async () => {
    stubLineage();
    try {
      const { runtime, emitDesktopNotification } = makeNestedRuntime();
      await trigger(runtime, {
        type: 'permission.asked',
        properties: { sessionID: 'ses_root', directory: '/repo', id: 'per_2', action: 'bash', resources: ['ls'] },
      }, emitDesktopNotification);

      expect(emitDesktopNotification.mock.calls[0][0]).toMatchObject({ sessionId: 'ses_root', directory: '/repo' });
    } finally {
      vi.unstubAllGlobals();
    }
  });

  it('opens the root for a tree in the filesystem root directory', async () => {
    stubLineage({
      ses_root: { parentID: undefined, directory: '/' },
      ses_child: { parentID: 'ses_root', directory: '/' },
      ses_grandchild: { parentID: 'ses_child', directory: '/' },
    });
    try {
      const { runtime, emitDesktopNotification } = makeNestedRuntime();
      await trigger(runtime, {
        type: 'permission.asked',
        properties: { sessionID: 'ses_grandchild', directory: '/', id: 'per_3', action: 'bash', resources: ['ls'] },
      }, emitDesktopNotification);

      expect(emitDesktopNotification.mock.calls[0][0]).toMatchObject({ sessionId: 'ses_root', directory: '/' });
    } finally {
      vi.unstubAllGlobals();
    }
  });

  // A moved subagent's requests live in its new directory, and an ancestor's
  // dock reads only its own directory.
  it('opens a moved subagent\'s request in the highest session of its new directory', async () => {
    stubLineage({
      ses_root: { directory: '/repo' },
      ses_child: { parentID: 'ses_root', directory: '/worktree' },
      ses_grandchild: { parentID: 'ses_child', directory: '/worktree' },
    });
    try {
      const { runtime, emitDesktopNotification, sendPushToAllUiSessions } = makeNestedRuntime();
      await trigger(runtime, {
        type: 'permission.asked',
        properties: { sessionID: 'ses_grandchild', directory: '/worktree', id: 'per_3', action: 'bash', resources: ['ls'] },
      }, sendPushToAllUiSessions);

      expect(emitDesktopNotification.mock.calls[0][0]).toMatchObject({ sessionId: 'ses_child', directory: '/worktree' });
      expect(sendPushToAllUiSessions.mock.calls[0][0].data).toMatchObject({ url: '/?session=ses_child', sessionId: 'ses_child' });
    } finally {
      vi.unstubAllGlobals();
    }
  });

  it('keeps a question in its own session when the subagent above it moved away', async () => {
    stubLineage({
      ses_root: { directory: '/repo' },
      ses_child: { parentID: 'ses_root', directory: '/elsewhere' },
      ses_grandchild: { parentID: 'ses_child', directory: '/repo' },
    });
    try {
      const { runtime, emitDesktopNotification } = makeNestedRuntime();
      await trigger(runtime, {
        type: 'form.created',
        properties: { sessionID: 'ses_grandchild', directory: '/repo', form: { id: 'frm_2', sessionID: 'ses_grandchild', title: 'Pick a layout', fields: [] } },
      }, emitDesktopNotification);

      expect(emitDesktopNotification.mock.calls[0][0]).toMatchObject({ sessionId: 'ses_grandchild', directory: '/repo' });
    } finally {
      vi.unstubAllGlobals();
    }
  });

  it('opens a subagent\'s waiting page in its own session, the only one that draws it', async () => {
    stubLineage();
    try {
      const { runtime, emitDesktopNotification } = makeNestedRuntime();
      await trigger(runtime, {
        type: 'openchamber:page-waiting',
        properties: { sessionID: 'ses_grandchild', directory: '/repo', page: { id: 'call_1', title: 'Review the page' } },
      }, emitDesktopNotification);

      expect(emitDesktopNotification.mock.calls[0][0]).toMatchObject({ sessionId: 'ses_grandchild', directory: '/repo' });
    } finally {
      vi.unstubAllGlobals();
    }
  });
});

describe('subagent finish with subagent notifications off', () => {
  const makeSubtaskRuntime = () => {
    const emitDesktopNotification = vi.fn(() => true);
    const runtime = createNotificationTriggerRuntime({
      readSettingsFromDisk: async () => ({ nativeNotificationsEnabled: true, notificationMode: 'always', notifyOnCompletion: true, notifyOnSubtasks: false }),
      prepareNotificationLastMessage: async ({ message }) => message,
      buildTemplateVariables: async () => ({}),
      extractLastMessageText: () => 'done',
      fetchLastAssistantMessageText: async () => 'done',
      resolveNotificationTemplate: () => '',
      shouldApplyResolvedTemplateMessage: () => false,
      emitDesktopNotification,
      broadcastUiNotification: vi.fn(),
      sendPushToAllUiSessions: vi.fn(async () => undefined),
      sendApnsToAllUiSessions: vi.fn(async () => undefined),
      isAnyInteractiveClientVisible: () => true,
      buildOpenCodeUrl: (path) => `http://opencode.test${path}`,
      getOpenCodeAuthHeaders: () => ({}),
      readSessionMetadata: async () => ({}),
    });
    return { runtime, emitDesktopNotification };
  };

  // OpenCode answers `GET /api/session/:id` as `{ data }` with no `location`.
  const stubSessionRecord = () => {
    vi.stubGlobal('fetch', vi.fn(async (input) => {
      const url = new URL(String(input));
      if (url.pathname === '/api/session/active') return Response.json({ data: {} });
      if (url.pathname === '/api/session/ses_child') return Response.json({ data: { id: 'ses_child', parentID: 'ses_parent' } });
      return Response.json({ data: [], cursor: {} });
    }));
  };

  it('reads the parent from the session record envelope', async () => {
    vi.spyOn(console, 'warn').mockImplementation(() => {});
    stubSessionRecord();
    const { runtime, emitDesktopNotification } = makeSubtaskRuntime();

    await runtime.maybeSendPushForTrigger(stepStarted('ses_child', 'msg_c'));
    await runtime.maybeSendPushForTrigger(turnEnded('ses_child'));
    expect(emitDesktopNotification).not.toHaveBeenCalled();
    vi.unstubAllGlobals();
  });

  it('a partial session update does not erase a known parent', async () => {
    vi.spyOn(console, 'warn').mockImplementation(() => {});
    vi.stubGlobal('fetch', vi.fn(async () => new Response('down', { status: 503 })));
    const { runtime, emitDesktopNotification } = makeSubtaskRuntime();

    await runtime.maybeSendPushForTrigger({ type: 'session.created', properties: { sessionID: 'ses_child', info: { id: 'ses_child', parentID: 'ses_parent' } } });
    // Usage updates arrive as `session.updated` with a partial record.
    await runtime.maybeSendPushForTrigger({ type: 'session.updated', properties: { sessionID: 'ses_child', info: { id: 'ses_child', cost: 1 } } });
    await runtime.maybeSendPushForTrigger(stepStarted('ses_child', 'msg_c'));
    await runtime.maybeSendPushForTrigger(turnEnded('ses_child'));
    expect(emitDesktopNotification).not.toHaveBeenCalled();
    vi.unstubAllGlobals();
  });
});

describe('input-needed notification for a page that waits for an answer', () => {
  it('notifies like a form, with the page title as the ask, and opens its session', async () => {
    vi.useFakeTimers();
    const emitDesktopNotification = vi.fn(() => true);
    const sendApnsToAllUiSessions = vi.fn(async () => undefined);
    const runtime = createNotificationTriggerRuntime({
      readSettingsFromDisk: async () => ({ nativeNotificationsEnabled: true, notificationMode: 'always', notifyOnQuestion: true }),
      buildTemplateVariables: async () => ({ session_name: 'Sidebar cleanup' }),
      resolveNotificationTemplate: (template, variables) => template.replace('{last_message}', variables.last_message ?? ''),
      shouldApplyResolvedTemplateMessage: () => true,
      emitDesktopNotification,
      broadcastUiNotification: vi.fn(),
      sendPushToAllUiSessions: vi.fn(async () => undefined),
      sendApnsToAllUiSessions,
      isAnyInteractiveClientVisible: () => false,
    });

    await runtime.maybeSendPushForTrigger({
      type: 'openchamber:page-waiting',
      properties: { sessionID: 'ses_1', directory: '/repo', page: { id: 'call_1', title: 'Pick a session row layout' } },
    });
    await vi.advanceTimersByTimeAsync(600);
    vi.useRealTimers();

    expect(emitDesktopNotification.mock.calls[0][0]).toMatchObject({
      kind: 'question', title: 'Input needed', body: 'Pick a session row layout', sessionId: 'ses_1', directory: '/repo', tag: 'question-ses_1',
    });
    expect(sendApnsToAllUiSessions.mock.calls[0][0].sealed).toEqual({ title: 'Sidebar cleanup', body: 'Question: Pick a session row layout' });
  });

  it('stays quiet when question notifications are off', async () => {
    vi.useFakeTimers();
    const emitDesktopNotification = vi.fn(() => true);
    const runtime = createNotificationTriggerRuntime({
      readSettingsFromDisk: async () => ({ nativeNotificationsEnabled: true, notificationMode: 'always', notifyOnQuestion: false }),
      buildTemplateVariables: async () => ({}),
      resolveNotificationTemplate: () => '',
      shouldApplyResolvedTemplateMessage: () => false,
      emitDesktopNotification,
      broadcastUiNotification: vi.fn(),
      sendPushToAllUiSessions: vi.fn(async () => undefined),
      sendApnsToAllUiSessions: vi.fn(async () => undefined),
      isAnyInteractiveClientVisible: () => false,
    });

    await runtime.maybeSendPushForTrigger({ type: 'openchamber:page-waiting', properties: { sessionID: 'ses_1', page: { id: 'call_1', title: 'Pick' } } });
    await vi.advanceTimersByTimeAsync(600);
    vi.useRealTimers();

    expect(emitDesktopNotification).not.toHaveBeenCalled();
  });
});

describe('a settled form or page cancels the pending question push (#2313)', () => {
  const makeSettleRuntime = () => {
    const emitDesktopNotification = vi.fn(() => true);
    const sendApnsToAllUiSessions = vi.fn(async () => undefined);
    const sendPushToAllUiSessions = vi.fn(async () => undefined);
    const runtime = createNotificationTriggerRuntime({
      readSettingsFromDisk: async () => ({ nativeNotificationsEnabled: true, notificationMode: 'always', notifyOnQuestion: true }),
      buildTemplateVariables: async () => ({ session_name: 'Sidebar cleanup' }),
      resolveNotificationTemplate: (template, variables) => template.replace('{last_message}', variables.last_message ?? ''),
      shouldApplyResolvedTemplateMessage: () => true,
      emitDesktopNotification,
      broadcastUiNotification: vi.fn(),
      sendPushToAllUiSessions,
      sendApnsToAllUiSessions,
      isAnyInteractiveClientVisible: () => false,
      getIsSessionAutoAccepting: async () => false,
    });
    return { runtime, emitDesktopNotification, sendApnsToAllUiSessions, sendPushToAllUiSessions };
  };

  const formCreated = (sessionID = 'ses_1') => ({
    type: 'form.created',
    properties: {
      sessionID,
      form: { id: 'frm_1', sessionID, title: 'Logout', fields: [{ key: 'q', type: 'string', title: 'Should logout also forget the remembered device?' }] },
    },
  });

  it('a form settled inside the debounce pushes nothing', async () => {
    vi.useFakeTimers();
    const { runtime, emitDesktopNotification, sendApnsToAllUiSessions, sendPushToAllUiSessions } = makeSettleRuntime();

    await runtime.maybeSendPushForTrigger(formCreated());
    await vi.advanceTimersByTimeAsync(100);
    await runtime.maybeSendPushForTrigger({ type: 'form.settled', properties: { sessionID: 'ses_1', formID: 'frm_1' } });
    await vi.advanceTimersByTimeAsync(900);
    vi.useRealTimers();

    expect(emitDesktopNotification).not.toHaveBeenCalled();
    expect(sendApnsToAllUiSessions).not.toHaveBeenCalled();
    expect(sendPushToAllUiSessions).not.toHaveBeenCalled();
  });

  it('a waiting page that settles inside the debounce pushes nothing', async () => {
    vi.useFakeTimers();
    const { runtime, emitDesktopNotification, sendApnsToAllUiSessions, sendPushToAllUiSessions } = makeSettleRuntime();

    await runtime.maybeSendPushForTrigger({
      type: 'openchamber:page-waiting',
      properties: { sessionID: 'ses_1', directory: '/repo', page: { id: 'call_1', title: 'Pick a session row layout' } },
    });
    await vi.advanceTimersByTimeAsync(100);
    await runtime.maybeSendPushForTrigger({
      type: 'openchamber:page-settled',
      properties: { sessionID: 'ses_1', pageID: 'call_1' },
    });
    await vi.advanceTimersByTimeAsync(900);
    vi.useRealTimers();

    expect(emitDesktopNotification).not.toHaveBeenCalled();
    expect(sendApnsToAllUiSessions).not.toHaveBeenCalled();
    expect(sendPushToAllUiSessions).not.toHaveBeenCalled();
  });

  it('an unanswered form still pushes after the debounce', async () => {
    vi.useFakeTimers();
    const { runtime, emitDesktopNotification, sendApnsToAllUiSessions } = makeSettleRuntime();

    await runtime.maybeSendPushForTrigger(formCreated());
    await vi.advanceTimersByTimeAsync(600);
    vi.useRealTimers();

    expect(emitDesktopNotification).toHaveBeenCalled();
    expect(sendApnsToAllUiSessions).toHaveBeenCalled();
  });

  it('a settle for a session with no pending timer does not throw and pushes nothing', async () => {
    vi.useFakeTimers();
    const { runtime, emitDesktopNotification, sendApnsToAllUiSessions } = makeSettleRuntime();

    await expect(runtime.maybeSendPushForTrigger({ type: 'form.settled', properties: { sessionID: 'ses_unknown', formID: 'frm_x' } })).resolves.not.toThrow();
    await expect(runtime.maybeSendPushForTrigger({ type: 'openchamber:page-settled', properties: { sessionID: 'ses_unknown', pageID: 'call_x' } })).resolves.not.toThrow();
    await vi.advanceTimersByTimeAsync(900);
    vi.useRealTimers();

    expect(emitDesktopNotification).not.toHaveBeenCalled();
    expect(sendApnsToAllUiSessions).not.toHaveBeenCalled();
  });

  it('a settle for a different session leaves the pending push armed', async () => {
    vi.useFakeTimers();
    const { runtime, emitDesktopNotification } = makeSettleRuntime();

    await runtime.maybeSendPushForTrigger(formCreated('ses_1'));
    await runtime.maybeSendPushForTrigger({ type: 'form.settled', properties: { sessionID: 'ses_2', formID: 'frm_1' } });
    await vi.advanceTimersByTimeAsync(600);
    vi.useRealTimers();

    expect(emitDesktopNotification).toHaveBeenCalled();
  });
});

describe('input-needed notification for an MCP elicitation', () => {
  it('opens the app, since the form belongs to no session', async () => {
    vi.useFakeTimers();
    const emitDesktopNotification = vi.fn(() => true);
    const sendPushToAllUiSessions = vi.fn(async () => undefined);
    const buildTemplateVariables = vi.fn(async () => ({}));
    const runtime = createNotificationTriggerRuntime({
      readSettingsFromDisk: async () => ({ nativeNotificationsEnabled: true, notificationMode: 'always', notifyOnQuestion: true }),
      buildTemplateVariables,
      resolveNotificationTemplate: () => '',
      shouldApplyResolvedTemplateMessage: () => false,
      emitDesktopNotification,
      broadcastUiNotification: vi.fn(),
      sendPushToAllUiSessions,
      sendApnsToAllUiSessions: vi.fn(async () => undefined),
      isAnyInteractiveClientVisible: () => false,
    });

    await runtime.maybeSendPushForTrigger({
      type: 'form.created',
      properties: {
        sessionID: 'global',
        form: {
          id: 'frm_1',
          sessionID: 'global',
          title: 'azure-devops is requesting input',
          fields: [{ key: 'project', type: 'string', title: 'Project', description: 'The Azure DevOps project.' }],
        },
      },
    });
    await vi.advanceTimersByTimeAsync(600);
    vi.useRealTimers();

    expect(buildTemplateVariables.mock.calls[0][1]).toBeUndefined();
    expect(emitDesktopNotification.mock.calls[0][0]).toMatchObject({ kind: 'question', title: 'azure-devops is requesting input' });
    expect(emitDesktopNotification.mock.calls[0][0].sessionId).toBeUndefined();
    const push = sendPushToAllUiSessions.mock.calls[0][0];
    expect(push.data.url).toBe('/');
    expect(push.data.sessionId).toBeUndefined();
  });
});

describe('notifications for a chat of an isolated space', () => {
  // The chat lives in the OpenCode inside the space; the host's OpenCode answers 404 for it.
  const SPACE = '32aa0c80b805';
  const SESSION = 'ses_space_1';
  const insideAnswers = ({ parentID = null, metadata = {} } = {}) => vi.fn(async (input) => {
    const url = new URL(String(input));
    if (url.pathname === '/api/session/active') return Response.json({ data: {} });
    if (url.pathname === '/api/session') return Response.json({ data: [], cursor: {} });
    if (url.pathname === `/api/session/${SESSION}`) return Response.json({ data: { id: SESSION, title: '2+2 answer', parentID, metadata } });
    if (url.pathname === `/api/session/${SESSION}/message`) {
      return Response.json({ data: [{ id: 'msg_1', type: 'assistant', finish: 'stop', content: [{ type: 'text', text: '2+2 is 4.' }] }], cursor: {} });
    }
    return new Response(null, { status: 404 });
  });

  const makeSpaceRuntime = ({ settings = {}, inside = insideAnswers(), isAutoAnswered = vi.fn(async () => false) } = {}) => {
    const hostFetch = vi.fn(async () => new Response(null, { status: 404 }));
    vi.stubGlobal('fetch', hostFetch);
    const readSettingsFromDisk = async () => ({ nativeNotificationsEnabled: true, notificationMode: 'always', notifyOnCompletion: true, notifyOnQuestion: true, ...settings });
    const templates = createNotificationTemplateRuntime({
      readSettingsFromDisk,
      buildOpenCodeUrl: (path) => `http://opencode.test${path}`,
      getOpenCodeAuthHeaders: () => ({}),
      resolveGitBinaryForSpawn: () => 'git',
    });
    const emitDesktopNotification = vi.fn(() => true);
    const sendApnsToAllUiSessions = vi.fn(async () => undefined);
    // The host's own metadata store reads the host's OpenCode.
    const readSessionMetadata = vi.fn(async () => ({}));
    const runtime = createNotificationTriggerRuntime({
      readSettingsFromDisk,
      readSessionMetadata,
      prepareNotificationLastMessage: async ({ message }) => message,
      buildTemplateVariables: templates.buildTemplateVariables,
      extractLastMessageText: templates.extractLastMessageText,
      fetchLastAssistantMessageText: templates.fetchLastAssistantMessageText,
      resolveNotificationTemplate: templates.resolveNotificationTemplate,
      shouldApplyResolvedTemplateMessage: templates.shouldApplyResolvedTemplateMessage,
      emitDesktopNotification,
      broadcastUiNotification: vi.fn(),
      sendPushToAllUiSessions: vi.fn(async () => undefined),
      sendApnsToAllUiSessions,
      isAnyInteractiveClientVisible: () => false,
      buildOpenCodeUrl: (path) => `http://opencode.test${path}`,
      getOpenCodeAuthHeaders: () => ({}),
      spaceFetchFor: (spaceId) => (spaceId === SPACE ? inside : null),
    });
    runtime.setGetIsSessionAutoAccepting(isAutoAnswered);
    return { runtime, hostFetch, inside, emitDesktopNotification, sendApnsToAllUiSessions, isAutoAnswered, readSessionMetadata };
  };

  afterEach(() => {
    vi.unstubAllGlobals();
    vi.useRealTimers();
  });

  it('gives the phone the chat name and the reply, read inside the space', async () => {
    vi.spyOn(console, 'warn').mockImplementation(() => {});
    const { runtime, hostFetch, inside, emitDesktopNotification, sendApnsToAllUiSessions, readSessionMetadata } = makeSpaceRuntime();

    await runtime.maybeSendPushForTrigger(stepStarted(SESSION, 'msg_1'), { spaceId: SPACE });
    await runtime.maybeSendPushForTrigger(turnEnded(SESSION), { spaceId: SPACE });

    expect(emitDesktopNotification).toHaveBeenCalledTimes(1);
    expect(readSessionMetadata).not.toHaveBeenCalled();
    expect(sendApnsToAllUiSessions.mock.calls[0][0]).toMatchObject({
      body: '2+2 answer',
      sealed: { title: '2+2 answer', body: '2+2 is 4.' },
    });
    expect(inside).toHaveBeenCalled();
    expect(hostFetch).not.toHaveBeenCalled();
  });

  it('announces a main chat of a space with subagent notifications off', async () => {
    vi.spyOn(console, 'warn').mockImplementation(() => {});
    const { runtime, hostFetch, emitDesktopNotification } = makeSpaceRuntime({ settings: { notifyOnSubtasks: false } });

    await runtime.maybeSendPushForTrigger(stepStarted(SESSION, 'msg_1'), { spaceId: SPACE });
    await runtime.maybeSendPushForTrigger(turnEnded(SESSION), { spaceId: SPACE });

    expect(emitDesktopNotification).toHaveBeenCalledTimes(1);
    expect(hostFetch).not.toHaveBeenCalled();
  });

  it('stays quiet while a goal in the space\'s own record is active', async () => {
    vi.spyOn(console, 'warn').mockImplementation(() => {});
    const { runtime, emitDesktopNotification } = makeSpaceRuntime({
      inside: insideAnswers({ metadata: { openchamber: { goal: { id: 'g', status: 'active', objective: 'x' } } } }),
    });

    await runtime.maybeSendPushForTrigger(stepStarted(SESSION, 'msg_1'), { spaceId: SPACE });
    await runtime.maybeSendPushForTrigger(turnEnded(SESSION), { spaceId: SPACE });

    expect(emitDesktopNotification).not.toHaveBeenCalled();
  });

  it('still stays quiet for a subagent of a space with subagent notifications off', async () => {
    vi.spyOn(console, 'warn').mockImplementation(() => {});
    const { runtime, emitDesktopNotification } = makeSpaceRuntime({ settings: { notifyOnSubtasks: false }, inside: insideAnswers({ parentID: 'ses_parent' }) });

    await runtime.maybeSendPushForTrigger(stepStarted(SESSION, 'msg_1'), { spaceId: SPACE });
    await runtime.maybeSendPushForTrigger(turnEnded(SESSION), { spaceId: SPACE });

    expect(emitDesktopNotification).not.toHaveBeenCalled();
  });

  it('asks neither the host\'s OpenCode nor its permission policy about a space\'s request', async () => {
    vi.useFakeTimers();
    vi.spyOn(console, 'warn').mockImplementation(() => {});
    const { runtime, hostFetch, isAutoAnswered, emitDesktopNotification, sendApnsToAllUiSessions } = makeSpaceRuntime();

    await runtime.maybeSendPushForTrigger({
      type: 'permission.asked',
      properties: { id: 'per_1', sessionID: SESSION, directory: `/spaces/${SPACE}/project`, action: 'read', resources: ['/etc/hostname'] },
    }, { spaceId: SPACE });
    await vi.advanceTimersByTimeAsync(600);

    expect(emitDesktopNotification).toHaveBeenCalledTimes(1);
    expect(sendApnsToAllUiSessions.mock.calls[0][0]).toMatchObject({ body: '2+2 answer' });
    expect(isAutoAnswered).not.toHaveBeenCalled();
    expect(hostFetch).not.toHaveBeenCalled();
  });

  it('falls back to the generic text, without the host\'s OpenCode, when the space cannot be asked', async () => {
    vi.spyOn(console, 'warn').mockImplementation(() => {});
    const { runtime, hostFetch, emitDesktopNotification, sendApnsToAllUiSessions } = makeSpaceRuntime({
      inside: vi.fn(async () => { throw new Error('space_not_running'); }),
    });

    await runtime.maybeSendPushForTrigger(stepStarted(SESSION, 'msg_1'), { spaceId: SPACE });
    await runtime.maybeSendPushForTrigger(turnEnded(SESSION), { spaceId: SPACE });

    expect(emitDesktopNotification).toHaveBeenCalledTimes(1);
    expect(sendApnsToAllUiSessions.mock.calls[0][0]).toMatchObject({ body: 'Session', sealed: undefined });
    expect(hostFetch).not.toHaveBeenCalled();
  });
});

describe('notification retention bounds', () => {
  const makeAskRuntime = () => {
    const emitDesktopNotification = vi.fn(() => true);
    const runtime = createNotificationTriggerRuntime({
      readSettingsFromDisk: async () => ({ nativeNotificationsEnabled: true, notificationMode: 'always', notifyOnQuestion: true }),
      buildTemplateVariables: async () => ({ session_name: 'Fix login redirect loop' }),
      resolveNotificationTemplate: (template, variables) => template.replace('{last_message}', variables.last_message ?? ''),
      shouldApplyResolvedTemplateMessage: () => true,
      emitDesktopNotification,
      broadcastUiNotification: vi.fn(),
      sendPushToAllUiSessions: vi.fn(async () => undefined),
      sendApnsToAllUiSessions: vi.fn(async () => undefined),
      isAnyInteractiveClientVisible: () => false,
      getIsSessionAutoAccepting: async () => false,
    });
    return { runtime, emitDesktopNotification };
  };

  const permissionAsked = (id) => ({
    type: 'permission.asked',
    properties: { sessionID: 'ses_1', id, action: 'bash', resources: ['echo ok'] },
  });

  it('evicts the oldest notified permission requests past the bound and still suppresses a recent duplicate', async () => {
    vi.useFakeTimers();
    vi.spyOn(console, 'warn').mockImplementation(() => {});
    try {
      const { runtime, emitDesktopNotification } = makeAskRuntime();
      // One more distinct request than the 500-entry bound.
      for (let i = 1; i <= 501; i += 1) {
        await runtime.maybeSendPushForTrigger(permissionAsked(`per_${i}`));
        await vi.advanceTimersByTimeAsync(600);
      }
      expect(emitDesktopNotification).toHaveBeenCalledTimes(501);

      // The most recent request is still remembered: no second notification.
      await runtime.maybeSendPushForTrigger(permissionAsked('per_501'));
      await vi.advanceTimersByTimeAsync(600);
      expect(emitDesktopNotification).toHaveBeenCalledTimes(501);

      // The oldest request fell out of the bound, so its re-delivery notifies again.
      await runtime.maybeSendPushForTrigger(permissionAsked('per_1'));
      await vi.advanceTimersByTimeAsync(600);
      expect(emitDesktopNotification).toHaveBeenCalledTimes(502);
    } finally {
      vi.useRealTimers();
    }
  }, 120_000);

  it('evicts the oldest ready-notification cooldown entries past the bound', async () => {
    vi.useFakeTimers();
    vi.spyOn(console, 'warn').mockImplementation(() => {});
    vi.stubGlobal('fetch', vi.fn(async () => Response.json({ data: {} })));
    try {
      const { runtime, emitDesktopNotification } = makeRuntime();
      // One more session than the 500-entry cooldown bound, all at the same
      // frozen instant, so only eviction — never the 5s cooldown expiring —
      // can let the first session announce again.
      for (let i = 1; i <= 501; i += 1) {
        await runtime.maybeSendPushForTrigger(stepStarted(`ses_${i}`, `msg_${i}`));
        await runtime.maybeSendPushForTrigger(turnEnded(`ses_${i}`));
      }
      expect(emitDesktopNotification).toHaveBeenCalledTimes(501);

      // The most recent session is still inside its cooldown.
      await runtime.maybeSendPushForTrigger(turnEnded('ses_501'));
      expect(emitDesktopNotification).toHaveBeenCalledTimes(501);

      // The first session's cooldown entry was evicted, so it announces again.
      await runtime.maybeSendPushForTrigger(turnEnded('ses_1'));
      expect(emitDesktopNotification).toHaveBeenCalledTimes(502);
    } finally {
      vi.useRealTimers();
      vi.unstubAllGlobals();
    }
  }, 120_000);
});

describe('session parent cache bounds (#974)', () => {
  // With subagent notifications off, the turn-end path answers from the
  // cache: a cached parent (a string) suppresses the announcement, a
  // cached no-parent answer (null, from a full session.created record)
  // announces, and an unknown parent — the lineage fetch is stubbed
  // down, so a cache miss answers undefined — suppresses. Eviction is
  // therefore observable: a session cached as parentless announces
  // while its entry lives and goes silent once the entry is evicted.
  const makeBoundedRuntime = () => {
    const emitDesktopNotification = vi.fn(() => true);
    const runtime = createNotificationTriggerRuntime({
      readSettingsFromDisk: async () => ({ nativeNotificationsEnabled: true, notificationMode: 'always', notifyOnCompletion: true, notifyOnSubtasks: false }),
      prepareNotificationLastMessage: async ({ message }) => message,
      buildTemplateVariables: async () => ({}),
      extractLastMessageText: () => 'done',
      fetchLastAssistantMessageText: async () => 'done',
      resolveNotificationTemplate: () => '',
      shouldApplyResolvedTemplateMessage: () => false,
      emitDesktopNotification,
      broadcastUiNotification: vi.fn(),
      sendPushToAllUiSessions: vi.fn(async () => undefined),
      sendApnsToAllUiSessions: vi.fn(async () => undefined),
      isAnyInteractiveClientVisible: () => true,
      buildOpenCodeUrl: (path) => `http://opencode.test${path}`,
      getOpenCodeAuthHeaders: () => ({}),
      readSessionMetadata: async () => ({}),
    });
    return { runtime, emitDesktopNotification };
  };

  // A full session.created record with no parentID caches the
  // no-parent answer for the session.
  const cacheParentless = async (runtime, sessionID) => {
    await runtime.maybeSendPushForTrigger({
      type: 'session.created',
      properties: { sessionID, info: { id: sessionID } },
    });
  };

  const finishTurn = async (runtime, sessionID) => {
    await runtime.maybeSendPushForTrigger(stepStarted(sessionID, `msg_${sessionID}`));
    await runtime.maybeSendPushForTrigger(turnEnded(sessionID));
  };

  const stubFetchDown = () => {
    vi.stubGlobal('fetch', vi.fn(async () => new Response('down', { status: 503 })));
  };

  it('a live cached entry still answers: a cached parentless session announces', async () => {
    vi.spyOn(console, 'warn').mockImplementation(() => {});
    stubFetchDown();
    const { runtime, emitDesktopNotification } = makeBoundedRuntime();

    await cacheParentless(runtime, 'ses_child');
    await cacheParentless(runtime, 'ses_other_1');
    await cacheParentless(runtime, 'ses_other_2');
    await finishTurn(runtime, 'ses_child');

    expect(emitDesktopNotification).toHaveBeenCalledTimes(1);
    vi.unstubAllGlobals();
  });

  it('evicts the oldest entry under cap pressure from never-re-read sessions', async () => {
    vi.spyOn(console, 'warn').mockImplementation(() => {});
    stubFetchDown();
    const { runtime, emitDesktopNotification } = makeBoundedRuntime();

    await cacheParentless(runtime, 'ses_child');
    for (let index = 0; index < 500; index += 1) {
      await cacheParentless(runtime, `ses_filler_${index}`);
    }

    // The newest entry still lives: it announces from the cache.
    await finishTurn(runtime, 'ses_filler_499');
    expect(emitDesktopNotification).toHaveBeenCalledTimes(1);

    // ses_child was the oldest entry and was evicted: its parent is
    // now unknown, so its finish is suppressed instead of announced.
    await finishTurn(runtime, 'ses_child');
    expect(emitDesktopNotification).toHaveBeenCalledTimes(1);
    vi.unstubAllGlobals();
  });

  it('re-caching a session refreshes its position, so the cap evicts an older neighbour instead', async () => {
    vi.spyOn(console, 'warn').mockImplementation(() => {});
    stubFetchDown();
    const { runtime, emitDesktopNotification } = makeBoundedRuntime();

    await cacheParentless(runtime, 'ses_child');
    for (let index = 0; index < 499; index += 1) {
      await cacheParentless(runtime, `ses_filler_${index}`);
    }
    await cacheParentless(runtime, 'ses_child');
    await cacheParentless(runtime, 'ses_newest');

    await finishTurn(runtime, 'ses_child');
    expect(emitDesktopNotification).toHaveBeenCalledTimes(1);

    await finishTurn(runtime, 'ses_filler_0');
    expect(emitDesktopNotification).toHaveBeenCalledTimes(1);
    vi.unstubAllGlobals();
  });

  it('sweeps an expired entry on a later set, without the entry ever being re-read', async () => {
    vi.spyOn(console, 'warn').mockImplementation(() => {});
    stubFetchDown();
    let now = 1700000000000;
    vi.spyOn(Date, 'now').mockImplementation(() => now);
    const { runtime, emitDesktopNotification } = makeBoundedRuntime();

    await cacheParentless(runtime, 'ses_child');
    now += 61 * 1000;
    // This set sweeps ses_child's expired entry.
    await cacheParentless(runtime, 'ses_other');
    // Back inside ses_child's original TTL window: if the entry had
    // survived the sweep, this finish would still hit the cache and
    // announce (the control case below proves that it does).
    now -= 60 * 1000;
    await finishTurn(runtime, 'ses_child');

    expect(emitDesktopNotification).not.toHaveBeenCalled();
    vi.unstubAllGlobals();
  });

  it('control: an expired entry that no later set swept is still answered after the clock returns inside its TTL', async () => {
    vi.spyOn(console, 'warn').mockImplementation(() => {});
    stubFetchDown();
    let now = 1700000000000;
    vi.spyOn(Date, 'now').mockImplementation(() => now);
    const { runtime, emitDesktopNotification } = makeBoundedRuntime();

    await cacheParentless(runtime, 'ses_child');
    now += 61 * 1000;
    now -= 60 * 1000;
    await finishTurn(runtime, 'ses_child');

    expect(emitDesktopNotification).toHaveBeenCalledTimes(1);
    vi.unstubAllGlobals();
  });
});
