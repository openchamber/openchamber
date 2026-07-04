import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import express from 'express';
import request from 'supertest';
import { createMessengerOpencodeBridge, questionContexts, approvalContexts } from './messenger-opencode-bridge.js';
import { createMessengerSyncRouter, resolveMessengerTarget } from './messenger-sync.js';

/**
 * Regression coverage for the Discord approval flow: a button click must reply
 * to OpenCode WITH the correct directory, otherwise OpenCode can't match the
 * pending permission and it stays "pending" forever in the web UI.
 */

function makeFakeStore() {
  return {
    lookup: () => null,
    bind: () => {},
    touch: () => {},
    setOverrides: () => {},
    getVerbosityDefault: () => null,
    getProjectDefaults: () => null,
    lookupBySessionId: () => [],
  };
}

function makeBridge(overrides = {}) {
  return createMessengerOpencodeBridge({
    globalEventHub: { subscribeEvent: () => () => {} },
    buildOpenCodeUrl: (p) => `http://opencode${p}`,
    getOpenCodeAuthHeaders: () => ({}),
    broadcastEvent: () => {},
    store: makeFakeStore(),
    listProjects: async () => [],
    // Session is not tracked locally → exercise the reverse-lookup path used
    // after a listener restart.
    lookupMessengerTarget: () => ({
      type: 'discord',
      token: 'bot-token',
      targetKey: 'chan-123',
      threadId: null,
      projectPath: '/binding/project',
    }),
    ...overrides,
  });
}

const flush = () => new Promise((r) => setTimeout(r, 0));

describe('approval flow — reply directory', () => {
  let originalFetch;

  beforeEach(() => {
    originalFetch = globalThis.fetch;
    globalThis.fetch = vi.fn(async () => ({
      ok: true,
      status: 200,
      json: async () => ({ id: 'discord-msg-1' }),
      text: async () => '',
    }));
  });

  afterEach(() => {
    globalThis.fetch = originalFetch;
    vi.restoreAllMocks();
  });

  async function askPermission(bridge, envelopeDirectory, metadata = {}) {
    bridge._handleGlobalEvent({
      directory: envelopeDirectory,
      payload: {
        type: 'permission.asked',
        properties: {
          id: 'req-1',
          sessionID: 'ses-1',
          permission: 'bash',
          patterns: [],
          always: [],
          metadata,
        },
      },
    });
    await flush();
    const ids = [...bridge.approvalContexts.keys()];
    expect(ids.length).toBe(1);
    return ids[0];
  }

  it('uses the authoritative SSE envelope directory for the reply', async () => {
    const bridge = makeBridge();
    const respond = vi.fn(async () => {});
    bridge.initApprovalListener(respond);

    const approvalId = await askPermission(bridge, '/envelope/project');

    // The approval message was posted to Discord.
    expect(globalThis.fetch).toHaveBeenCalled();

    bridge.handleApprovalDecision(approvalId, 'approve');
    await flush();

    expect(respond).toHaveBeenCalledTimes(1);
    expect(respond).toHaveBeenCalledWith({
      sessionID: 'ses-1',
      requestID: 'req-1',
      reply: 'once',
      directory: '/envelope/project',
    });
  });

  it('falls back to the bound project path when the envelope is "global"', async () => {
    const bridge = makeBridge();
    const respond = vi.fn(async () => {});
    bridge.initApprovalListener(respond);

    const approvalId = await askPermission(bridge, 'global');
    bridge.handleApprovalDecision(approvalId, 'approve-always');
    await flush();

    expect(respond).toHaveBeenCalledWith(
      expect.objectContaining({ reply: 'always', directory: '/binding/project' }),
    );
  });

  it('is idempotent — a duplicate click does not double-reply', async () => {
    const bridge = makeBridge();
    const respond = vi.fn(async () => {});
    bridge.initApprovalListener(respond);

    const approvalId = await askPermission(bridge, '/p');
    bridge.handleApprovalDecision(approvalId, 'deny');
    bridge.handleApprovalDecision(approvalId, 'deny');
    await flush();

    expect(respond).toHaveBeenCalledTimes(1);
    expect(respond).toHaveBeenCalledWith(expect.objectContaining({ reply: 'reject' }));
  });
});

describe('permission mode (/yolo) auto-approve', () => {
  let originalFetch;

  beforeEach(() => {
    originalFetch = globalThis.fetch;
    globalThis.fetch = vi.fn(async () => ({
      ok: true,
      status: 200,
      json: async () => ({ id: 'discord-msg-1' }),
      text: async () => '',
    }));
  });

  afterEach(() => {
    globalThis.fetch = originalFetch;
    vi.restoreAllMocks();
  });

  function makeBridgeWithMode(mode) {
    return makeBridge({
      store: {
        ...makeFakeStore(),
        lookup: () => (mode ? { permissionModeOverride: mode } : null),
        getPermissionModeDefault: () => null,
      },
    });
  }

  async function askPermission(bridge, permissionName) {
    bridge._handleGlobalEvent({
      directory: '/envelope/project',
      payload: {
        type: 'permission.asked',
        properties: {
          id: 'req-1',
          sessionID: 'ses-1',
          permission: permissionName,
          patterns: [],
          always: [],
          metadata: {},
        },
      },
    });
    await flush();
  }

  it('yolo mode auto-approves without posting buttons', async () => {
    const bridge = makeBridgeWithMode('yolo');
    const respond = vi.fn(async () => {});
    bridge.initApprovalListener(respond);

    await askPermission(bridge, 'bash');

    // No interactive approval message was tracked (auto-approved instead).
    expect([...bridge.approvalContexts.keys()]).toHaveLength(0);
    expect(respond).toHaveBeenCalledWith({
      sessionID: 'ses-1',
      requestID: 'req-1',
      reply: 'once',
      directory: '/envelope/project',
    });
  });

  it('auto-edit mode auto-approves edits but still prompts for shell', async () => {
    const respond1 = vi.fn(async () => {});
    const editBridge = makeBridgeWithMode('auto-edit');
    editBridge.initApprovalListener(respond1);
    await askPermission(editBridge, 'edit');
    expect(respond1).toHaveBeenCalledWith(expect.objectContaining({ reply: 'once' }));
    expect([...editBridge.approvalContexts.keys()]).toHaveLength(0);

    const respond2 = vi.fn(async () => {});
    const shellBridge = makeBridgeWithMode('auto-edit');
    shellBridge.initApprovalListener(respond2);
    await askPermission(shellBridge, 'bash');
    // Shell still requires an explicit decision → an approval message is posted.
    expect(respond2).not.toHaveBeenCalled();
    expect([...shellBridge.approvalContexts.keys()]).toHaveLength(1);
  });

  it('ask mode (default) always posts buttons', async () => {
    const bridge = makeBridgeWithMode(null);
    const respond = vi.fn(async () => {});
    bridge.initApprovalListener(respond);
    await askPermission(bridge, 'edit');
    expect(respond).not.toHaveBeenCalled();
    expect([...bridge.approvalContexts.keys()]).toHaveLength(1);
  });
});

describe('discord project sync persistence', () => {
  let originalFetch;

  beforeEach(() => {
    originalFetch = globalThis.fetch;
  });

  afterEach(() => {
    globalThis.fetch = originalFetch;
    vi.restoreAllMocks();
  });

  it('persists project channel bindings immediately after sync-projects', async () => {
    globalThis.fetch = vi.fn(async (url) => {
      const u = String(url);
      if (u.includes('/guilds/guild-1/channels')) {
        return {
          ok: true,
          status: 200,
          json: async () => [{ id: 'chan-otto-ui', name: 'otto-ui', type: 0, position: 1 }],
          text: async () => '',
        };
      }
      if (u.includes('/channels/chan-otto-ui/messages')) {
        return {
          ok: true,
          status: 200,
          json: async () => ({ id: 'msg-1' }),
          text: async () => '',
        };
      }
      return { ok: false, status: 404, json: async () => ({}), text: async () => 'not found' };
    });

    const persistSettings = vi.fn(async () => {});
    const app = express();
    app.use(
      '/',
      createMessengerSyncRouter({
        broadcastEvent: () => {},
        readSettings: async () => ({
          discord: { botToken: 'old-token', guildId: 'guild-1', defaultChannelId: 'general' },
          projects: [{ id: 'proj-1', path: '/data/projects/otto-ui', label: 'Otto Ui' }],
        }),
        persistSettings,
        sanitizeProjects: (projects) => projects,
      }).router,
    );

    const res = await request(app)
      .post('/discord/sync-projects')
      .send({
        token: 'bot-token',
        guildId: 'guild-1',
        createThreads: false,
        projects: [{ id: 'proj-1', label: 'Otto Ui', body: 'sync body' }],
        mappings: [],
      })
      .expect(200);

    expect(res.body.ok).toBe(true);
    expect(res.body.channels[0]).toMatchObject({
      projectId: 'proj-1',
      projectPath: '/data/projects/otto-ui',
      channelId: 'chan-otto-ui',
    });
    expect(persistSettings).toHaveBeenCalledWith({
      discord: expect.objectContaining({
        botToken: 'bot-token',
        guildId: 'guild-1',
        defaultChannelId: 'general',
        projectBindings: [
          { channelId: 'chan-otto-ui', projectPath: '/data/projects/otto-ui', projectLabel: 'Otto Ui' },
        ],
      }),
    });
  });
});

describe('web session mirroring', () => {
  let originalFetch;

  // A fetch mock that distinguishes thread creation from message posting so
  // tests can assert the project-channel → per-session-thread routing.
  function installFetchMock() {
    let threadSeq = 0;
    let msgSeq = 0;
    globalThis.fetch = vi.fn(async (url) => {
      const u = String(url);
      if (u.endsWith('/threads')) {
        threadSeq += 1;
        const id = `thread-${threadSeq}`;
        return { ok: true, status: 200, json: async () => ({ id, name: 'web' }), text: async () => '' };
      }
      msgSeq += 1;
      return { ok: true, status: 200, json: async () => ({ id: `msg-${msgSeq}` }), text: async () => '' };
    });
  }

  beforeEach(() => {
    originalFetch = globalThis.fetch;
    installFetchMock();
  });

  afterEach(() => {
    globalThis.fetch = originalFetch;
    vi.restoreAllMocks();
  });

  function makeWebBridge(extra = {}) {
    return makeBridge({
      lookupMessengerTarget: () => null,
      getDefaultMessengerTarget: async ({ projectPath }) => ({
        type: 'discord',
        token: 'bot-token',
        channelId: 'project-chan',
        threadId: null,
        projectPath,
        projectLabel: 'My Project',
      }),
      ...extra,
    });
  }

  async function emitUserMessage(bridge, { sessionId, messageId, partId, text }) {
    // role lives on message.updated, not on the part — mirror real OpenCode.
    await bridge._handleGlobalEvent({
      directory: '/web/project',
      payload: { type: 'message.updated', properties: { info: { id: messageId, role: 'user', sessionID: sessionId } } },
    });
    await bridge._handleGlobalEvent({
      directory: '/web/project',
      payload: {
        type: 'message.part.updated',
        properties: { part: { id: partId, type: 'text', messageID: messageId, sessionID: sessionId, text } },
      },
    });
  }

  async function emitAssistantMessage(bridge, { sessionId, messageId, partId, text }) {
    await bridge._handleGlobalEvent({
      directory: '/web/project',
      payload: { type: 'message.updated', properties: { info: { id: messageId, role: 'assistant', sessionID: sessionId } } },
    });
    await bridge._handleGlobalEvent({
      directory: '/web/project',
      payload: {
        type: 'message.part.updated',
        properties: {
          part: { id: partId, type: 'text', messageID: messageId, sessionID: sessionId, text, time: { end: Date.now() } },
        },
      },
    });
  }

  it('routes a web conversation into a per-session thread under the project channel', async () => {
    const bridge = makeWebBridge();

    await emitUserMessage(bridge, {
      sessionId: 'web-ses-1',
      messageId: 'm-user-1',
      partId: 'usr-1',
      text: 'hello from web',
    });
    await emitAssistantMessage(bridge, {
      sessionId: 'web-ses-1',
      messageId: 'm-ast-1',
      partId: 'ast-1',
      text: 'hello from assistant',
    });

    // A thread was created in the PROJECT channel (not posted to #general).
    const threadCalls = globalThis.fetch.mock.calls.filter(([url]) =>
      String(url).includes('/channels/project-chan/threads'),
    );
    expect(threadCalls).toHaveLength(1);

    // Both the user echo and the assistant reply went into that thread.
    const threadMessageCalls = globalThis.fetch.mock.calls.filter(([url]) =>
      String(url).includes('/channels/thread-1/messages'),
    );
    expect(threadMessageCalls).toHaveLength(2);
    expect(JSON.parse(threadMessageCalls[0][1].body).content).toContain('hello from web');
    expect(JSON.parse(threadMessageCalls[0][1].body).content).toContain('Web');
    expect(JSON.parse(threadMessageCalls[1][1].body).content).toContain('hello from assistant');
  });

  it('renders a user-run shell command as a clean command + output block (no marker noise)', async () => {
    const bridge = makeWebBridge();
    const sessionId = 'web-ses-shell';

    // 1. The synthetic shell-marker user message OpenCode injects for a
    //    user-run shell command (web `!cmd` / messenger `/shell`).
    await emitUserMessage(bridge, {
      sessionId,
      messageId: 'm-shell-user',
      partId: 'shell-usr',
      text: 'The following tool was executed by the user\n\n<bash>',
    });

    // 2. The assistant echo: parentID points back at the marker message and the
    //    sole part is the bash tool carrying the command + output.
    await bridge._handleGlobalEvent({
      directory: '/web/project',
      payload: {
        type: 'message.updated',
        properties: { info: { id: 'm-shell-ast', role: 'assistant', parentID: 'm-shell-user', sessionID: sessionId } },
      },
    });
    await bridge._handleGlobalEvent({
      directory: '/web/project',
      payload: {
        type: 'message.part.updated',
        properties: {
          part: {
            id: 'shell-bash',
            type: 'tool',
            tool: 'bash',
            messageID: 'm-shell-ast',
            sessionID: sessionId,
            state: { status: 'completed', input: { command: 'pwd' }, output: '/web/project' },
          },
        },
      },
    });

    const messages = globalThis.fetch.mock.calls
      .filter(([url]) => String(url).includes('/messages'))
      .map(([, init]) => JSON.parse(init.body).content);

    // The internal marker is never mirrored as a Web prompt block.
    expect(messages.some((c) => c.includes('The following tool was executed by the user'))).toBe(false);
    // The command + its output ARE posted, as a single shell block.
    const shellBlock = messages.find((c) => c.includes('**shell**'));
    expect(shellBlock).toBeTruthy();
    expect(shellBlock).toContain('`pwd`');
    expect(shellBlock).toContain('/web/project');
  });

  it('mirrors a web user message when the part arrives before the role event', async () => {
    const bridge = makeWebBridge();

    await bridge._handleGlobalEvent({
      directory: '/web/project',
      payload: {
        type: 'message.part.updated',
        properties: {
          part: {
            id: 'usr-late-role',
            type: 'text',
            messageID: 'm-late-role',
            sessionID: 'web-ses-late-role',
            text: 'part arrived first',
          },
        },
      },
    });
    expect(globalThis.fetch).not.toHaveBeenCalled();

    await bridge._handleGlobalEvent({
      directory: '/web/project',
      payload: {
        type: 'message.updated',
        properties: { info: { id: 'm-late-role', role: 'user', sessionID: 'web-ses-late-role' } },
      },
    });

    const userEchoes = globalThis.fetch.mock.calls
      .filter(([url]) => String(url).includes('/messages'))
      .map(([, init]) => JSON.parse(init.body).content)
      .filter((content) => content.includes('Web'));
    expect(userEchoes).toHaveLength(1);
    expect(userEchoes[0]).toContain('part arrived first');
  });

  it('mirrors a follow-up web user message in the same session (no second thread)', async () => {
    const bridge = makeWebBridge();

    await emitUserMessage(bridge, { sessionId: 'web-ses-2', messageId: 'm-u1', partId: 'u1', text: 'first' });
    await emitAssistantMessage(bridge, { sessionId: 'web-ses-2', messageId: 'm-a1', partId: 'a1', text: 'reply one' });
    await emitUserMessage(bridge, { sessionId: 'web-ses-2', messageId: 'm-u2', partId: 'u2', text: 'second question' });

    // Only one thread for the whole session.
    const threadCalls = globalThis.fetch.mock.calls.filter(([url]) =>
      String(url).includes('/threads'),
    );
    expect(threadCalls).toHaveLength(1);

    const userEchoes = globalThis.fetch.mock.calls
      .filter(([url]) => String(url).includes('/messages'))
      .map(([, init]) => JSON.parse(init.body).content)
      .filter((c) => c.includes('Web'));
    expect(userEchoes.some((c) => c.includes('first'))).toBe(true);
    expect(userEchoes.some((c) => c.includes('second question'))).toBe(true);
  });

  it('does not mirror unbound web parts when no default target is configured', async () => {
    const bridge = makeBridge({
      lookupMessengerTarget: () => null,
      getDefaultMessengerTarget: async () => null,
    });

    await emitAssistantMessage(bridge, {
      sessionId: 'web-ses-3',
      messageId: 'm-x',
      partId: 'ast-x',
      text: 'not mirrored',
    });

    expect(globalThis.fetch).not.toHaveBeenCalled();
  });
});

describe('discord inbound mirroring', () => {
  let originalFetch;

  beforeEach(() => {
    originalFetch = globalThis.fetch;
  });

  afterEach(() => {
    globalThis.fetch = originalFetch;
    vi.restoreAllMocks();
  });

  it('does not echo a Discord user part when role is nested on the message', async () => {
    globalThis.fetch = vi.fn(async () => ({
      ok: true,
      status: 200,
      json: async () => ({ id: 'msg-1' }),
      text: async () => '',
    }));

    const bridge = makeBridge({
      store: {
        ...makeFakeStore(),
        lookupBySessionId: (sessionId) =>
          sessionId === 'discord-ses-1'
            ? [{ type: 'discord', botTokenHash: 'hash', targetKey: 'thread-1', sessionId }]
            : [],
      },
      getDefaultMessengerTarget: async () => ({
        type: 'discord',
        token: 'bot-token',
        channelId: 'fallback-channel',
        threadId: null,
        projectPath: '/project',
      }),
    });

    await bridge._handleGlobalEvent({
      directory: '/project',
      payload: {
        type: 'message.part.updated',
        properties: {
          part: {
            id: 'discord-user-part',
            type: 'text',
            sessionID: 'discord-ses-1',
            message: { id: 'discord-user-message', role: 'user' },
            text: 'message typed in discord',
            time: { end: Date.now() },
          },
        },
      },
    });

    expect(globalThis.fetch).not.toHaveBeenCalled();
  });

  it('adds the Discord author to the thread via REST and replies without echoing them', async () => {
    const calls = [];
    globalThis.fetch = vi.fn(async (url, init = {}) => {
      calls.push([String(url), init]);
      const u = String(url);
      if (u.includes('/messages/source-msg/threads')) {
        return { ok: true, status: 200, json: async () => ({ id: 'thread-1', name: 'hello' }), text: async () => '' };
      }
      if (u.includes('/thread-members/user-1')) {
        return { ok: true, status: 204, json: async () => null, text: async () => '' };
      }
      if (u === 'http://opencode/session?directory=%2Fproject') {
        return { ok: true, status: 200, json: async () => ({ id: 'discord-ses-2' }), text: async () => '' };
      }
      if (u.includes('/session/discord-ses-2/prompt_async')) {
        return { ok: true, status: 200, json: async () => ({}), text: async () => '' };
      }
      if (u.includes('/channels/thread-1/messages')) {
        return { ok: true, status: 200, json: async () => ({ id: 'reply-1' }), text: async () => '' };
      }
      return { ok: false, status: 404, json: async () => ({}), text: async () => 'not found' };
    });

    const bridge = makeBridge({
      store: {
        ...makeFakeStore(),
        lookup: () => null,
        bind: () => {},
      },
    });

    const routed = await bridge.routeInbound({
      type: 'discord',
      token: 'bot-token',
      channelId: 'channel-1',
      threadId: null,
      sourceMessageId: 'source-msg',
      text: 'hello',
      projectPath: '/project',
      projectLabel: 'Project',
      from: { id: 'user-1', username: 'alice' },
    });
    expect(routed.ok).toBe(true);

    // The user was added to the new thread via the REST thread-members endpoint.
    const addMemberCalls = calls.filter(
      ([url, init]) => url.includes('/channels/thread-1/thread-members/user-1') && init.method === 'PUT',
    );
    expect(addMemberCalls).toHaveLength(1);

    await bridge._handleGlobalEvent({
      directory: '/project',
      payload: {
        type: 'message.updated',
        properties: { info: { id: 'assistant-message', role: 'assistant', sessionID: 'discord-ses-2' } },
      },
    });
    await bridge._handleGlobalEvent({
      directory: '/project',
      payload: {
        type: 'message.part.updated',
        properties: {
          part: {
            id: 'assistant-part',
            type: 'text',
            messageID: 'assistant-message',
            sessionID: 'discord-ses-2',
            text: 'assistant reply',
            time: { end: Date.now() },
          },
        },
      },
    });

    // The assistant reply is posted as-is — no mention prefix, no echo of the
    // user's own message.
    const threadMessages = calls
      .filter(([url]) => url.includes('/channels/thread-1/messages'))
      .map(([, init]) => JSON.parse(init.body).content);
    expect(threadMessages).toEqual(['assistant reply']);
  });

  it('runs a `!status` console command on Discord without sending it as a prompt', async () => {
    const calls = [];
    globalThis.fetch = vi.fn(async (url, init = {}) => {
      calls.push([String(url), init]);
      return { ok: true, status: 200, json: async () => ({ id: 'cmd-reply' }), text: async () => '' };
    });

    const bridge = makeBridge({
      store: {
        ...makeFakeStore(),
        lookup: ({ targetKey }) =>
          targetKey === 'channel-1'
            ? { sessionId: 'ses-1', projectPath: '/project', projectLabel: 'Project' }
            : null,
      },
    });

    const routed = await bridge.routeInbound({
      type: 'discord',
      token: 'bot-token',
      channelId: 'channel-1',
      threadId: null,
      sourceMessageId: 'source-msg',
      text: '!status',
      from: { id: 'user-1', username: 'alice' },
    });

    expect(routed.ok).toBe(true);
    expect(routed.handledCommand).toBe('status');

    // The command must not reach OpenCode as a prompt.
    expect(calls.some(([url]) => url.includes('/prompt_async'))).toBe(false);
    // The status reply is posted back to the originating channel.
    const reply = calls.find(([url]) => url.includes('/channels/channel-1/messages'));
    expect(reply).toBeTruthy();
    expect(JSON.parse(reply[1].body).content).toContain('Otto status');
  });

  it('does not echo a Discord reply back into a web-created thread (mixed surface)', async () => {
    // Scenario: a thread was created from the web UI (so the session ctx is a
    // web-mirror), but the user then answers FROM Discord inside that thread.
    // The user's own prompt must NOT bounce straight back to them.
    const calls = [];
    globalThis.fetch = vi.fn(async (url, init = {}) => {
      calls.push([String(url), init]);
      const u = String(url);
      if (u === 'http://opencode/session') {
        return { ok: true, status: 200, json: async () => ({ id: 'mixed-ses' }), text: async () => '' };
      }
      if (u.includes('/session/mixed-ses/prompt_async')) {
        return { ok: true, status: 200, json: async () => ({}), text: async () => '' };
      }
      // Discord thread message posts + standalone thread creation.
      if (u.endsWith('/threads')) {
        return { ok: true, status: 200, json: async () => ({ id: 'web-thread', name: 'web' }), text: async () => '' };
      }
      return { ok: true, status: 200, json: async () => ({ id: 'm' }), text: async () => '' };
    });

    // A store that binds the web thread to the session, so the inbound Discord
    // reply resolves to the SAME session created by the web flow.
    const bound = { sessionId: 'mixed-ses', projectPath: '/web/project', projectLabel: 'Web' };
    const bridge = makeBridge({
      store: {
        ...makeFakeStore(),
        // The inbound Discord reply resolves to the SAME session the web flow
        // created (bound to the web thread's id). lookupBySessionId stays empty
        // so the first web user message still creates + mirrors into the thread.
        lookup: ({ targetKey }) => (targetKey === 'web-thread' ? bound : null),
      },
      getDefaultMessengerTarget: async ({ projectPath }) => ({
        type: 'discord',
        token: 'bot-token',
        channelId: 'project-chan',
        threadId: null,
        projectPath,
        projectLabel: 'Web',
      }),
    });

    // 1. Web user message → creates the web thread + mirrors a **Web** block.
    await bridge._handleGlobalEvent({
      directory: '/web/project',
      payload: { type: 'message.updated', properties: { info: { id: 'm-web', role: 'user', sessionID: 'mixed-ses' } } },
    });
    await bridge._handleGlobalEvent({
      directory: '/web/project',
      payload: {
        type: 'message.part.updated',
        properties: { part: { id: 'p-web', type: 'text', messageID: 'm-web', sessionID: 'mixed-ses', text: 'from web' } },
      },
    });

    const beforeReply = calls.filter(([url]) => url.includes('/channels/web-thread/messages')).length;

    // 2. The user now replies FROM Discord inside that same thread.
    await bridge.routeInbound({
      type: 'discord',
      token: 'bot-token',
      channelId: 'web-thread',
      threadId: null,
      sourceMessageId: null,
      text: 'reply from discord',
      from: { id: 'user-1', username: 'alice' },
    });

    // 3. OpenCode echoes that prompt back as a `user` part on the same session.
    await bridge._handleGlobalEvent({
      directory: '/web/project',
      payload: { type: 'message.updated', properties: { info: { id: 'm-dc', role: 'user', sessionID: 'mixed-ses' } } },
    });
    await bridge._handleGlobalEvent({
      directory: '/web/project',
      payload: {
        type: 'message.part.updated',
        properties: { part: { id: 'p-dc', type: 'text', messageID: 'm-dc', sessionID: 'mixed-ses', text: 'reply from discord' } },
      },
    });

    const threadMessages = calls
      .filter(([url]) => url.includes('/channels/web-thread/messages'))
      .map(([, init]) => JSON.parse(init.body).content);
    // The Discord-originated prompt must not be mirrored back into the thread.
    expect(threadMessages.some((c) => c.includes('reply from discord'))).toBe(false);
    // ...while the earlier genuine web prompt still was mirrored once.
    expect(beforeReply).toBeGreaterThan(0);
  });
});

describe('thread renaming from OpenCode session titles', () => {
  let originalFetch;
  let calls;

  beforeEach(() => {
    originalFetch = globalThis.fetch;
    calls = [];
    globalThis.fetch = vi.fn(async (url, init = {}) => {
      calls.push([String(url), init]);
      const method = init.method ?? 'GET';
      if (String(url).includes('discord.com') && method === 'GET') {
        // The bound surface is a public thread named with the user's prompt.
        return {
          ok: true,
          status: 200,
          json: async () => ({ id: 'thread-9', type: 11, name: 'fix the auth' }),
          text: async () => '',
        };
      }
      return { ok: true, status: 200, json: async () => ({}), text: async () => '' };
    });
  });

  afterEach(() => {
    globalThis.fetch = originalFetch;
    vi.restoreAllMocks();
  });

  const sessionUpdated = (bridge, title) =>
    bridge._handleGlobalEvent({
      payload: {
        type: 'session.updated',
        properties: { info: { id: 'ses-9', title } },
      },
    });

  function makeRenameBridge() {
    return makeBridge({
      lookupMessengerTarget: () => ({
        type: 'discord',
        token: 'bot-token',
        targetKey: 'thread-9',
        threadId: null,
        projectPath: '/p',
      }),
    });
  }

  it('renames the bound thread when OpenCode generates a real title', async () => {
    const bridge = makeRenameBridge();
    await sessionUpdated(bridge, 'Fix auth bug');
    await flush();
    const patches = calls.filter(([url, init]) => init.method === 'PATCH' && url.includes('/channels/thread-9'));
    expect(patches).toHaveLength(1);
    expect(JSON.parse(patches[0][1].body)).toEqual({ name: 'Fix auth bug' });
  });

  it('ignores the "New session -" placeholder title', async () => {
    const bridge = makeRenameBridge();
    await sessionUpdated(bridge, 'New session - 2026-06-11T13:00:00.000Z');
    await flush();
    expect(calls.filter(([, init]) => init.method === 'PATCH')).toHaveLength(0);
  });

  it('renames at most once per distinct title (Discord rate-limit protection)', async () => {
    const bridge = makeRenameBridge();
    await sessionUpdated(bridge, 'Fix auth bug');
    await sessionUpdated(bridge, 'Fix auth bug');
    await sessionUpdated(bridge, 'Fix auth bug');
    await flush();
    expect(calls.filter(([, init]) => init.method === 'PATCH')).toHaveLength(1);
  });

  it('never renames a plain text channel', async () => {
    globalThis.fetch = vi.fn(async (url, init = {}) => {
      calls.push([String(url), init]);
      if ((init.method ?? 'GET') === 'GET' && String(url).includes('discord.com')) {
        return { ok: true, status: 200, json: async () => ({ id: 'chan-1', type: 0, name: 'general' }), text: async () => '' };
      }
      return { ok: true, status: 200, json: async () => ({}), text: async () => '' };
    });
    const bridge = makeBridge({
      lookupMessengerTarget: () => ({ type: 'discord', token: 'bot-token', targetKey: 'chan-1', threadId: null, projectPath: '/p' }),
    });
    await sessionUpdated(bridge, 'Fix auth bug');
    await flush();
    expect(calls.filter(([, init]) => init.method === 'PATCH')).toHaveLength(0);
  });
});

describe('thread title polling sweep (rename fallback)', () => {
  let originalFetch;
  let calls;

  beforeEach(() => {
    originalFetch = globalThis.fetch;
    calls = [];
    globalThis.fetch = vi.fn(async (url, init = {}) => {
      calls.push([String(url), init]);
      const u = String(url);
      const method = init.method ?? 'GET';
      if (u.startsWith('http://opencode/session/')) {
        // OpenCode already generated a title — the rename event was missed.
        return {
          ok: true,
          status: 200,
          json: async () => ({ id: 'ses-sweep', title: 'Polled title win' }),
          text: async () => '',
        };
      }
      if (u.includes('discord.com') && method === 'GET') {
        return {
          ok: true,
          status: 200,
          json: async () => ({ id: 'thread-sweep', type: 11, name: 'initial prompt line' }),
          text: async () => '',
        };
      }
      return { ok: true, status: 200, json: async () => ({}), text: async () => '' };
    });
  });

  afterEach(() => {
    globalThis.fetch = originalFetch;
    vi.restoreAllMocks();
  });

  it('renames bound threads from polled session titles when the event was missed', async () => {
    const bridge = makeBridge({
      store: {
        ...makeFakeStore(),
        list: () => [
          {
            type: 'discord',
            targetKey: 'thread-sweep',
            sessionId: 'ses-sweep',
            projectPath: '/p',
            lastUsedAt: new Date().toISOString(),
          },
        ],
        getSetting: () => null,
        setSetting: () => {},
      },
      lookupMessengerTarget: () => ({
        type: 'discord',
        token: 'bot-token',
        targetKey: 'thread-sweep',
        threadId: null,
        projectPath: '/p',
      }),
    });

    await bridge._sweepThreadTitles();
    await flush();

    const patches = calls.filter(([, init]) => init.method === 'PATCH');
    expect(patches).toHaveLength(1);
    expect(JSON.parse(patches[0][1].body).name).toBe('Polled title win');
  });

  it('skips placeholder titles during the sweep', async () => {
    globalThis.fetch = vi.fn(async (url, init = {}) => {
      calls.push([String(url), init]);
      if (String(url).startsWith('http://opencode/session/')) {
        return {
          ok: true,
          status: 200,
          json: async () => ({ id: 'ses-sweep', title: 'New session - 2026-06-12T07:00:00.000Z' }),
          text: async () => '',
        };
      }
      return { ok: true, status: 200, json: async () => ({ id: 'thread-sweep', type: 11, name: 'x' }), text: async () => '' };
    });
    const bridge = makeBridge({
      store: {
        ...makeFakeStore(),
        list: () => [
          { type: 'discord', targetKey: 'thread-sweep', sessionId: 'ses-sweep', projectPath: '/p', lastUsedAt: new Date().toISOString() },
        ],
        getSetting: () => null,
        setSetting: () => {},
      },
    });

    await bridge._sweepThreadTitles();
    await flush();
    expect(calls.filter(([, init]) => init.method === 'PATCH')).toHaveLength(0);
  });
});

describe('/schedule — project scheduler integration', () => {
  let originalFetch;

  beforeEach(() => {
    originalFetch = globalThis.fetch;
    globalThis.fetch = vi.fn(async () => ({
      ok: true,
      status: 200,
      json: async () => ({}),
      text: async () => '',
    }));
  });

  afterEach(() => {
    globalThis.fetch = originalFetch;
    vi.restoreAllMocks();
  });

  function makeScheduleBridge({ upserted, deleted, synced }) {
    return makeBridge({
      store: {
        ...makeFakeStore(),
        lookup: () => ({
          sessionId: 'ses-1',
          projectPath: '/proj/alpha',
          projectLabel: 'alpha',
          modelOverride: 'anthropic/claude-sonnet-4',
          agentOverride: null,
          verbosityOverride: null,
        }),
        getSetting: () => null,
        setSetting: () => {},
      },
      listProjects: async () => [{ id: 'proj-alpha', path: '/proj/alpha', label: 'alpha' }],
      projectConfigRuntime: {
        upsertScheduledTask: async (projectId, task) => {
          upserted.push({ projectId, task });
          return { task: { ...task, id: 'task-1' }, created: true };
        },
        listScheduledTasks: async (projectId) => {
          if (projectId !== 'proj-alpha') return [];
          // Echo back whatever was upserted (with the computed state the real
          // runtime would add); fall back to a static fixture for list tests.
          if (upserted.length > 0) {
            return upserted.map(({ task }) => ({
              ...task,
              id: 'task-1',
              state: { createdAt: 1, updatedAt: 1, nextRunAt: 1781340000000 },
            }));
          }
          return [
            {
              id: 'task-1',
              name: 'Run the weekly tests',
              enabled: true,
              schedule: { kind: 'cron', cron: '0 9 * * 1', timezone: 'UTC' },
              execution: { prompt: 'Run the weekly tests', providerID: 'anthropic', modelID: 'claude-sonnet-4' },
              state: { createdAt: 1, updatedAt: 1, nextRunAt: 1781340000000 },
            },
          ];
        },
        deleteScheduledTask: async (projectId, taskId) => {
          deleted.push({ projectId, taskId });
          return { deleted: true, tasks: [] };
        },
      },
      scheduledTasksRuntime: {
        syncProject: async (projectId) => synced.push(projectId),
      },
    });
  }

  it('creates a cron task in the per-project scheduler and re-syncs timers', async () => {
    const upserted = [];
    const synced = [];
    const bridge = makeScheduleBridge({ upserted, deleted: [], synced });

    const result = await bridge.runCommand({
      type: 'discord',
      token: 'bot-token',
      channelId: 'chan-1',
      commandName: 'schedule',
      args: '0 9 * * 1 Run the weekly tests',
      from: { id: 'u1', username: 'tester' },
    });

    expect(upserted).toHaveLength(1);
    expect(upserted[0].projectId).toBe('proj-alpha');
    expect(upserted[0].task.schedule).toEqual({ kind: 'cron', cron: '0 9 * * 1', timezone: 'UTC' });
    expect(upserted[0].task.execution).toMatchObject({
      prompt: 'Run the weekly tests',
      providerID: 'anthropic',
      modelID: 'claude-sonnet-4',
    });
    expect(synced).toEqual(['proj-alpha']);
    expect(result.reply).toContain('task-1');
    expect(result.reply).toContain('anthropic/claude-sonnet-4');
  });

  it('creates a one-time task from a UTC ISO date', async () => {
    const upserted = [];
    const synced = [];
    const bridge = makeScheduleBridge({ upserted, deleted: [], synced });

    const result = await bridge.runCommand({
      type: 'discord',
      token: 'bot-token',
      channelId: 'chan-1',
      commandName: 'schedule',
      args: '2099-03-01T09:00 Review open PRs',
      from: { id: 'u1' },
    });

    expect(upserted).toHaveLength(1);
    expect(upserted[0].task.schedule).toEqual({ kind: 'once', date: '2099-03-01', time: '09:00', timezone: 'UTC' });
    expect(result.reply).toContain('once at 2099-03-01 09:00');
  });

  it('rejects past one-time dates and invalid cron', async () => {
    const bridge = makeScheduleBridge({ upserted: [], deleted: [], synced: [] });

    const past = await bridge.runCommand({
      type: 'discord', token: 'bot-token', channelId: 'chan-1',
      commandName: 'schedule', args: '2020-01-01T09:00 Too late',
    });
    expect(past.reply).toContain('future');

    const badCron = await bridge.runCommand({
      type: 'discord', token: 'bot-token', channelId: 'chan-1',
      commandName: 'schedule', args: 'not-a-cron Run it',
    });
    expect(badCron.reply).toContain('✗');
  });

  it('lists and deletes tasks through the project scheduler', async () => {
    const deleted = [];
    const synced = [];
    const bridge = makeScheduleBridge({ upserted: [], deleted, synced });

    const list = await bridge.runCommand({
      type: 'discord', token: 'bot-token', channelId: 'chan-1',
      commandName: 'schedule', args: 'list',
    });
    expect(list.reply).toContain('task-1');
    expect(list.reply).toContain('cron `0 9 * * 1`');

    const del = await bridge.runCommand({
      type: 'discord', token: 'bot-token', channelId: 'chan-1',
      commandName: 'schedule', args: 'delete task-1',
    });
    expect(del.reply).toContain('Deleted');
    expect(deleted).toEqual([{ projectId: 'proj-alpha', taskId: 'task-1' }]);
    expect(synced).toEqual(['proj-alpha']);
  });
});

describe('question flow — interactive questions in Discord', () => {
  let originalFetch;
  let calls;

  beforeEach(() => {
    originalFetch = globalThis.fetch;
    calls = [];
    questionContexts.clear();
    globalThis.fetch = vi.fn(async (url, init = {}) => {
      calls.push({ url: String(url), method: init.method ?? 'GET', body: init.body ?? null });
      return { ok: true, status: 200, json: async () => ({ id: 'discord-msg-q' }), text: async () => '' };
    });
  });

  afterEach(() => {
    globalThis.fetch = originalFetch;
    questionContexts.clear();
    vi.restoreAllMocks();
  });

  const flushAll = async () => {
    await flush();
    await flush();
  };

  async function askQuestion(bridge, questions, { requestId = 'req-q1', sessionId = 'ses-q1' } = {}) {
    await bridge._handleGlobalEvent({
      directory: '/proj',
      payload: {
        type: 'question.asked',
        properties: { id: requestId, sessionID: sessionId, questions },
      },
    });
    await flushAll();
    const ids = [...questionContexts.keys()];
    expect(ids.length).toBe(1);
    return ids[0];
  }

  it('posts a question with option buttons regardless of verbosity', async () => {
    const bridge = makeBridge({
      store: { ...makeFakeStore(), getVerbosityDefault: () => 'quiet' },
    });
    await askQuestion(bridge, [
      {
        question: 'Which approach should I take?',
        header: 'Approach',
        options: [
          { label: 'Option A', description: 'fast' },
          { label: 'Option B', description: 'thorough' },
        ],
      },
    ]);

    const post = calls.find((c) => c.url.includes('/channels/chan-123/messages') && c.method === 'POST');
    expect(post).toBeTruthy();
    const body = JSON.parse(post.body);
    expect(body.content).toContain('Approach');
    expect(body.content).toContain('Which approach should I take?');
    expect(body.content).toContain('Option A');
    const buttons = body.components[0].components;
    expect(buttons).toHaveLength(2);
    expect(buttons[0].custom_id).toMatch(/^otto-question:[0-9a-f]+:0:0$/);
    expect(buttons[1].custom_id).toMatch(/^otto-question:[0-9a-f]+:0:1$/);
  });

  it('uses a select menu for multi-select questions', async () => {
    const bridge = makeBridge();
    await askQuestion(bridge, [
      {
        question: 'Pick the files to include',
        header: 'Files',
        multiple: true,
        options: [
          { label: 'a.ts' },
          { label: 'b.ts' },
          { label: 'c.ts' },
        ],
      },
    ]);

    const post = calls.find((c) => c.url.includes('/channels/chan-123/messages') && c.method === 'POST');
    const select = JSON.parse(post.body).components[0].components[0];
    expect(select.type).toBe(3);
    expect(select.custom_id).toMatch(/^otto-question-select:[0-9a-f]+:0$/);
    expect(select.options.map((o) => o.label)).toEqual(['a.ts', 'b.ts', 'c.ts']);
    expect(select.max_values).toBe(3);
  });

  it('replies to OpenCode with the picked option label', async () => {
    const bridge = makeBridge();
    const questionId = await askQuestion(bridge, [
      {
        question: 'Which approach?',
        header: 'Approach',
        options: [{ label: 'Option A' }, { label: 'Option B' }],
      },
    ]);

    const result = bridge.handleQuestionDecision(questionId, 0, ['1']);
    await flushAll();

    expect(result).toEqual({ ok: true, labels: ['Option B'], complete: true });
    const reply = calls.find((c) => c.url.includes('/question/req-q1/reply'));
    expect(reply).toBeTruthy();
    expect(reply.url).toContain('directory=%2Fproj');
    expect(JSON.parse(reply.body)).toEqual({ answers: [['Option B']] });
    expect(questionContexts.size).toBe(0);
  });

  it('collects answers across a multi-question request before replying', async () => {
    const bridge = makeBridge();
    const questionId = await askQuestion(bridge, [
      { question: 'First?', header: 'One', options: [{ label: 'A' }, { label: 'B' }] },
      { question: 'Second?', header: 'Two', options: [{ label: 'C' }, { label: 'D' }] },
    ]);

    const first = bridge.handleQuestionDecision(questionId, 0, ['0']);
    expect(first).toEqual({ ok: true, labels: ['A'], complete: false });
    await flushAll();
    expect(calls.some((c) => c.url.includes('/question/req-q1/reply'))).toBe(false);

    const second = bridge.handleQuestionDecision(questionId, 1, ['1']);
    expect(second).toEqual({ ok: true, labels: ['D'], complete: true });
    await flushAll();
    const reply = calls.find((c) => c.url.includes('/question/req-q1/reply'));
    expect(JSON.parse(reply.body)).toEqual({ answers: [['A'], ['D']] });
  });

  it('is idempotent for expired/unknown question contexts', async () => {
    const bridge = makeBridge();
    const result = bridge.handleQuestionDecision('nope', 0, ['0']);
    expect(result.ok).toBe(false);
  });

  it('strips stale components when the question is answered in the web UI', async () => {
    const bridge = makeBridge();
    await askQuestion(bridge, [
      { question: 'Which?', header: 'Pick', options: [{ label: 'A' }] },
    ]);

    await bridge._handleGlobalEvent({
      directory: '/proj',
      payload: {
        type: 'question.replied',
        properties: { sessionID: 'ses-q1', requestID: 'req-q1', answers: [['A']] },
      },
    });
    await flushAll();

    expect(questionContexts.size).toBe(0);
    const patch = calls.find(
      (c) => c.method === 'PATCH' && c.url.includes('/messages/discord-msg-q'),
    );
    expect(patch).toBeTruthy();
    expect(JSON.parse(patch.body)).toEqual({ components: [] });
  });

  it('treats a typed Discord reply as the custom answer instead of a new prompt', async () => {
    const bound = { sessionId: 'ses-q1', projectPath: '/proj', projectLabel: 'Proj' };
    const bridge = makeBridge({
      store: {
        ...makeFakeStore(),
        lookup: ({ targetKey }) => (targetKey === 'chan-123' ? bound : null),
      },
    });
    await askQuestion(bridge, [
      { question: 'Which migration name?', header: 'Name', options: [{ label: 'auto' }] },
    ]);

    const routed = await bridge.routeInbound({
      type: 'discord',
      token: 'bot-token',
      channelId: 'chan-123',
      threadId: null,
      sourceMessageId: null,
      text: 'call it add-user-table',
      from: { id: 'user-1', username: 'alice' },
    });

    expect(routed.ok).toBe(true);
    expect(routed.answeredQuestion).toBe(true);
    const reply = calls.find((c) => c.url.includes('/question/req-q1/reply'));
    expect(reply).toBeTruthy();
    expect(JSON.parse(reply.body)).toEqual({ answers: [['call it add-user-table']] });
    // The typed answer resumes the blocked turn — it must NOT also be sent
    // as a brand-new prompt.
    expect(calls.some((c) => c.url.includes('/prompt_async'))).toBe(false);
    expect(questionContexts.size).toBe(0);
  });
});

describe('todo/plan mirroring', () => {
  let originalFetch;
  let calls;

  beforeEach(() => {
    originalFetch = globalThis.fetch;
    calls = [];
    globalThis.fetch = vi.fn(async (url, init = {}) => {
      calls.push({ url: String(url), method: init.method ?? 'GET', body: init.body ?? null });
      const u = String(url);
      if (u.includes('/session/') && !u.includes('/message')) {
        return { ok: true, status: 200, json: async () => ({ id: 'ses-todo' }), text: async () => '' };
      }
      return { ok: true, status: 200, json: async () => ({ id: 'todo-msg-1' }), text: async () => '' };
    });
  });

  afterEach(() => {
    globalThis.fetch = originalFetch;
    vi.restoreAllMocks();
  });

  async function makeBridgeWithSession() {
    const bound = { sessionId: 'ses-todo', projectPath: '/proj', projectLabel: 'Proj' };
    const bridge = makeBridge({
      store: {
        ...makeFakeStore(),
        lookup: ({ targetKey }) => (targetKey === 'chan-todo' ? bound : null),
      },
    });
    // Bind a live Discord context for the session via an inbound prompt.
    const routed = await bridge.routeInbound({
      type: 'discord',
      token: 'bot-token',
      channelId: 'chan-todo',
      threadId: null,
      sourceMessageId: null,
      text: 'do the work',
      from: { id: 'user-1', username: 'alice' },
    });
    expect(routed.ok).toBe(true);
    return bridge;
  }

  it('posts the agent plan even at quiet verbosity (flushed on idle)', async () => {
    const bridge = await makeBridgeWithSession();
    calls.length = 0;

    await bridge._handleGlobalEvent({
      directory: '/proj',
      payload: {
        type: 'todo.updated',
        properties: {
          sessionID: 'ses-todo',
          todos: [
            { content: 'Set up scaffolding', status: 'completed', priority: 'high' },
            { content: 'Implement API client', status: 'in_progress', priority: 'high' },
            { content: 'Write tests', status: 'pending', priority: 'medium' },
          ],
        },
      },
    });
    // session.idle flushes the pending (debounced) todo render immediately.
    await bridge._handleGlobalEvent({
      directory: '/proj',
      payload: { type: 'session.idle', properties: { sessionID: 'ses-todo' } },
    });
    await flush();
    await flush();

    const post = calls.find(
      (c) => c.method === 'POST' && c.url.includes('/channels/chan-todo/messages') && c.body?.includes('Plan'),
    );
    expect(post).toBeTruthy();
    const content = JSON.parse(post.body).content;
    expect(content).toContain('📋 **Plan** — 1/3 done');
    expect(content).toContain('✅ ~~Set up scaffolding~~');
    expect(content).toContain('🔄 **Implement API client**');
    expect(content).toContain('⬜ Write tests');
  });

  it('ignores todo updates for sessions with no bound surface', async () => {
    const bridge = makeBridge();
    await bridge._handleGlobalEvent({
      directory: '/proj',
      payload: {
        type: 'todo.updated',
        properties: { sessionID: 'unknown-ses', todos: [{ content: 'x', status: 'pending', priority: 'low' }] },
      },
    });
    await flush();
    expect(calls.length).toBe(0);
  });
});

describe('pending interaction reconciliation (missed SSE recovery)', () => {
  let originalFetch;
  let calls;

  beforeEach(() => {
    originalFetch = globalThis.fetch;
    calls = [];
    // The approval context map is module-level (one bridge in production); clear
    // it so leftover contexts from a previous test can't trip the live-approval
    // dedupe when ids are reused across tests.
    approvalContexts.clear();
    globalThis.fetch = vi.fn(async (url, init = {}) => {
      const u = String(url);
      calls.push({ url: u, method: init.method ?? 'GET', body: init.body ?? null });
      // Pending-permissions list endpoint (GET /permission, not the reply path).
      if (u.includes('/permission') && !u.includes('/reply')) {
        return {
          ok: true,
          status: 200,
          text: async () => '[]',
          json: async () => [
            { id: 'req-missed-1', sessionID: 'ses-1', permission: 'bash', patterns: [], always: [], metadata: {} },
          ],
        };
      }
      if (u.includes('/question')) {
        return { ok: true, status: 200, text: async () => '[]', json: async () => [] };
      }
      // Discord message POST (and anything else).
      return { ok: true, status: 200, text: async () => '', json: async () => ({ id: 'discord-msg-1' }) };
    });
  });

  afterEach(() => {
    globalThis.fetch = originalFetch;
    vi.restoreAllMocks();
  });

  function makeHubWithStatus() {
    let statusCb = null;
    return {
      subscribeEvent: () => () => {},
      subscribeStatus: (cb) => {
        statusCb = cb;
        return () => {};
      },
      _emitStatus: (status) => statusCb?.(status),
    };
  }

  function makeBoundStore() {
    return {
      ...makeFakeStore(),
      list: () => [{ sessionId: 'ses-1', projectPath: '/binding/project' }],
    };
  }

  it('forwards a pending permission that was never delivered via SSE', async () => {
    const bridge = makeBridge({ globalEventHub: makeHubWithStatus(), store: makeBoundStore() });

    // Subscribing kicks an initial reconcile (fire-and-forget); let the async
    // fetch chain settle.
    bridge.ensureSubscribed();
    for (let i = 0; i < 8; i += 1) await flush();

    const post = calls.find((c) => c.method === 'POST' && c.url.includes('/channels/chan-123/messages'));
    expect(post).toBeTruthy();
    expect(JSON.parse(post.body).content).toContain('Permission Required');
    // Recorded for later Approve/Deny button routing.
    expect([...bridge.approvalContexts.values()].some((v) => v.requestID === 'req-missed-1')).toBe(true);
  });

  it('does not double-surface a permission already delivered via the live SSE path', async () => {
    const bridge = makeBridge({ globalEventHub: makeHubWithStatus(), store: makeBoundStore() });

    // Live SSE event arrives first and posts once.
    bridge._handleGlobalEvent({
      directory: '/binding/project',
      payload: {
        type: 'permission.asked',
        properties: { id: 'req-missed-1', sessionID: 'ses-1', permission: 'bash', patterns: [], always: [], metadata: {} },
      },
    });
    await flush();
    expect(calls.filter((c) => c.method === 'POST' && c.url.includes('/messages')).length).toBe(1);

    // Reconcile sees the same still-pending request and must skip it.
    bridge.ensureSubscribed();
    for (let i = 0; i < 8; i += 1) await flush();
    expect(calls.filter((c) => c.method === 'POST' && c.url.includes('/messages')).length).toBe(1);
  });

  it('does not re-surface a still-live approval after a prune/reconcile cycle', async () => {
    // The pending-permission list flips: it briefly omits the request (which
    // prunes the in-memory dedupe id) and then lists it again while it is still
    // pending. This is the exact shape that used to spawn a brand-new
    // Approve/Deny message on every reconcile cycle.
    let pendingPermissionList = [
      { id: 'req-flip', sessionID: 'ses-1', permission: 'bash', patterns: [], always: [], metadata: {} },
    ];
    globalThis.fetch = vi.fn(async (url, init = {}) => {
      const u = String(url);
      calls.push({ url: u, method: init.method ?? 'GET', body: init.body ?? null });
      if (u.includes('/permission') && !u.includes('/reply')) {
        return { ok: true, status: 200, text: async () => '[]', json: async () => pendingPermissionList };
      }
      if (u.includes('/question')) {
        return { ok: true, status: 200, text: async () => '[]', json: async () => [] };
      }
      return { ok: true, status: 200, text: async () => '', json: async () => ({ id: 'discord-msg-1' }) };
    });

    const hub = makeHubWithStatus();
    const bridge = makeBridge({ globalEventHub: hub, store: makeBoundStore() });
    const messageCount = () =>
      calls.filter((c) => c.method === 'POST' && c.url.includes('/messages')).length;

    // Initial reconcile surfaces the permission once and records its context.
    bridge.ensureSubscribed();
    for (let i = 0; i < 8; i += 1) await flush();
    expect(messageCount()).toBe(1);
    expect([...bridge.approvalContexts.values()].some((v) => v.requestID === 'req-flip')).toBe(true);

    // Snapshot momentarily drops the request → reconcile would prune its id.
    pendingPermissionList = [];
    hub._emitStatus({ type: 'connect' });
    for (let i = 0; i < 8; i += 1) await flush();

    // Request reappears while still pending → must NOT post a duplicate.
    pendingPermissionList = [
      { id: 'req-flip', sessionID: 'ses-1', permission: 'bash', patterns: [], always: [], metadata: {} },
    ];
    hub._emitStatus({ type: 'connect' });
    for (let i = 0; i < 8; i += 1) await flush();

    expect(messageCount()).toBe(1);
  });
});

describe('/shell command — agent resolution (regression: empty agent 500s)', () => {
  let originalFetch;
  let calls;

  beforeEach(() => {
    originalFetch = globalThis.fetch;
    calls = [];
    globalThis.fetch = vi.fn(async (url, init = {}) => {
      const u = String(url);
      const method = init.method ?? 'GET';
      calls.push({ url: u, method, body: init.body ?? null });
      if (u.includes('/agent')) {
        return {
          ok: true,
          status: 200,
          text: async () => '',
          json: async () => [
            { name: 'build', mode: 'primary', hidden: false },
            { name: 'explore', mode: 'subagent', hidden: false },
          ],
        };
      }
      if (u.includes('/shell')) {
        // Mirror OpenCode: 200 only when a real agent is supplied.
        return { ok: true, status: 200, text: async () => '', json: async () => ({ info: {}, parts: [] }) };
      }
      return { ok: true, status: 200, text: async () => '', json: async () => ({ id: 'discord-msg' }) };
    });
  });

  afterEach(() => {
    globalThis.fetch = originalFetch;
    vi.restoreAllMocks();
  });

  function makeShellBridge(bindingOverrides = {}) {
    const binding = {
      type: 'discord',
      token: 'bot-token',
      targetKey: 'chan-1',
      sessionId: 'ses-shell',
      projectPath: '/proj',
      projectLabel: 'proj',
      modelOverride: null,
      agentOverride: null,
      ...bindingOverrides,
    };
    return makeBridge({
      store: {
        lookup: () => binding,
        lookupBySessionId: () => [binding],
        bind: () => {},
        touch: () => {},
        setOverrides: () => {},
        getVerbosityDefault: () => null,
        getProjectDefaults: () => null,
      },
    });
  }

  const shellBody = () => {
    const call = calls.find((c) => c.method === 'POST' && c.url.includes('/shell'));
    return call ? JSON.parse(call.body) : null;
  };

  it('resolves a concrete primary agent when none is configured (never empty)', async () => {
    const bridge = makeShellBridge();
    const result = await bridge.runCommand({
      type: 'discord', token: 'bot-token', channelId: 'chan-1', threadId: null,
      commandName: 'shell', args: 'pwd',
    });
    const body = shellBody();
    expect(body).toBeTruthy();
    expect(body.command).toBe('pwd');
    expect(body.agent).toBe('build'); // a real agent, not '' (which 500s)
    expect(result.reply).toContain('Running');
  });

  it('honours an explicit surface agent override', async () => {
    const bridge = makeShellBridge({ agentOverride: 'plan' });
    await bridge.runCommand({
      type: 'discord', token: 'bot-token', channelId: 'chan-1', threadId: null,
      commandName: 'shell', args: 'ls -la',
    });
    expect(shellBody().agent).toBe('plan');
  });

  it('passes a resolved model through when configured', async () => {
    const bridge = makeShellBridge({ modelOverride: 'anthropic/claude-sonnet-4' });
    await bridge.runCommand({
      type: 'discord', token: 'bot-token', channelId: 'chan-1', threadId: null,
      commandName: 'shell', args: 'pwd',
    });
    expect(shellBody().model).toEqual({ providerID: 'anthropic', modelID: 'claude-sonnet-4' });
  });

  // `!cmd` is the natural shell prefix on Discord (matches the web chat). A
  // bang-prefixed token that isn't a console command must run as a shell
  // command — this is the exact form the user reported (`!pwd`).
  it('runs a bare `!pwd` as a shell command', async () => {
    const bridge = makeShellBridge();
    const result = await bridge.routeInbound({
      type: 'discord', token: 'bot-token', channelId: 'chan-1', threadId: null, text: '!pwd',
    });
    const body = shellBody();
    expect(body).toBeTruthy();
    expect(body.command).toBe('pwd');
    expect(body.agent).toBe('build');
    expect(result).toMatchObject({ ok: true, handledCommand: 'shell' });
  });

  it('runs `!git status` (command with args) as a shell command', async () => {
    const bridge = makeShellBridge();
    await bridge.routeInbound({
      type: 'discord', token: 'bot-token', channelId: 'chan-1', threadId: null, text: '!git status',
    });
    expect(shellBody().command).toBe('git status');
  });

  it('still treats `!status` as the console command, not a shell command', async () => {
    const bridge = makeShellBridge();
    const result = await bridge.routeInbound({
      type: 'discord', token: 'bot-token', channelId: 'chan-1', threadId: null, text: '!status',
    });
    expect(result).toMatchObject({ ok: true, handledCommand: 'status' });
    expect(calls.find((c) => c.method === 'POST' && c.url.includes('/shell'))).toBeUndefined();
  });

  it('still supports the explicit `!shell <cmd>` form', async () => {
    const bridge = makeShellBridge();
    await bridge.routeInbound({
      type: 'discord', token: 'bot-token', channelId: 'chan-1', threadId: null, text: '!shell echo hi',
    });
    expect(shellBody().command).toBe('echo hi');
  });

  it('auto-creates a session when none exists (no "send a message first")', async () => {
    // Binding with a project but NO sessionId — the user ran /shell as their
    // first action. runShell must create + bind a session instead of erroring.
    const bridge = makeShellBridge({ sessionId: null });
    const result = await bridge.routeInbound({
      type: 'discord', token: 'bot-token', channelId: 'chan-1', threadId: null, text: '!pwd',
    });
    // A session was created…
    const created = calls.find((c) => c.method === 'POST' && /\/session(\?|$)/.test(c.url));
    expect(created).toBeTruthy();
    // …and the shell command ran against it with a real agent.
    expect(shellBody().command).toBe('pwd');
    expect(shellBody().agent).toBe('build');
    expect(result).toMatchObject({ ok: true, handledCommand: 'shell' });
    // The user is never told to "send a regular message first".
    const posts = calls
      .filter((c) => c.method === 'POST' && c.url.includes('/messages'))
      .map((c) => JSON.parse(c.body).content);
    expect(posts.some((p) => /send a regular message first/i.test(p))).toBe(false);
  });
});

describe('plain message supersedes an in-flight turn', () => {
  let originalFetch;
  beforeEach(() => {
    originalFetch = globalThis.fetch;
  });
  afterEach(() => {
    globalThis.fetch = originalFetch;
    vi.restoreAllMocks();
  });

  it('aborts the running turn, defers the new prompt, then sends it on idle', async () => {
    const calls = [];
    globalThis.fetch = vi.fn(async (url, init = {}) => {
      calls.push({ url: String(url), method: init.method ?? 'GET', body: init.body });
      return { ok: true, status: 200, json: async () => ({}), text: async () => '' };
    });

    const bridge = makeBridge({
      store: {
        ...makeFakeStore(),
        lookup: ({ targetKey }) =>
          targetKey === 'chan-sup'
            ? { sessionId: 'ses-sup', projectPath: '/p', projectLabel: 'P' }
            : null,
      },
    });

    const promptCalls = () =>
      calls.filter((c) => c.method === 'POST' && c.url.includes('/session/ses-sup/prompt_async'));
    const abortCalls = () =>
      calls.filter((c) => c.method === 'POST' && c.url.includes('/session/ses-sup/abort'));

    // First message → prompt sent, session now busy.
    const first = await bridge.routeInbound({
      type: 'discord', token: 'bot-token', channelId: 'chan-sup', threadId: null, text: 'first',
    });
    expect(first.ok).toBe(true);
    expect(promptCalls()).toHaveLength(1);

    // Second message while busy → abort fired, prompt deferred (not sent yet).
    const second = await bridge.routeInbound({
      type: 'discord', token: 'bot-token', channelId: 'chan-sup', threadId: null, text: 'second',
    });
    expect(second).toMatchObject({ ok: true, superseded: true });
    expect(abortCalls()).toHaveLength(1);
    expect(promptCalls()).toHaveLength(1); // still only the first prompt

    // A short "stopped the current turn" notice is posted to the surface.
    const notices = calls
      .filter((c) => c.method === 'POST' && c.url.includes('/channels/chan-sup/messages'))
      .map((c) => JSON.parse(c.body).content);
    expect(notices.some((n) => /stopped the current turn/i.test(n))).toBe(true);

    // The aborted turn settles → the deferred message is sent.
    await bridge._handleGlobalEvent({
      directory: '/p',
      payload: { type: 'session.idle', properties: { sessionID: 'ses-sup' } },
    });
    await flush();

    const sentBodies = promptCalls().map((c) => JSON.parse(c.body).parts[0].text);
    expect(sentBodies).toContain('second');
    expect(promptCalls()).toHaveLength(2);
  });

  it('suppresses a trailing abort error from the superseded turn (no false failure)', async () => {
    const calls = [];
    globalThis.fetch = vi.fn(async (url, init = {}) => {
      calls.push({ url: String(url), method: init.method ?? 'GET', body: init.body });
      return { ok: true, status: 200, json: async () => ({}), text: async () => '' };
    });

    const bridge = makeBridge({
      store: {
        ...makeFakeStore(),
        lookup: ({ targetKey }) =>
          targetKey === 'chan-sup2'
            ? { sessionId: 'ses-sup2', projectPath: '/p', projectLabel: 'P' }
            : null,
      },
    });

    await bridge.routeInbound({
      type: 'discord', token: 'bot-token', channelId: 'chan-sup2', threadId: null, text: 'first',
    });
    await bridge.routeInbound({
      type: 'discord', token: 'bot-token', channelId: 'chan-sup2', threadId: null, text: 'second',
    });

    // The aborted turn settles via idle → the deferred prompt fires and the
    // session is marked recently-superseded.
    await bridge._handleGlobalEvent({
      directory: '/p',
      payload: { type: 'session.idle', properties: { sessionID: 'ses-sup2' } },
    });
    await flush();

    // A LATE abort error arrives for the cancelled turn (after supersede cleared).
    await bridge._handleGlobalEvent({
      directory: '/p',
      payload: {
        type: 'session.error',
        properties: { sessionID: 'ses-sup2', error: { data: { message: 'streaming response failed' } } },
      },
    });
    await flush();

    const errorLines = calls
      .filter((c) => c.method === 'POST' && c.url.includes('/channels/chan-sup2/messages'))
      .map((c) => JSON.parse(c.body).content)
      .filter((p) => p.startsWith('✗'));
    expect(errorLines).toHaveLength(0); // the abort teardown is not surfaced as a fault
  });

  it('still surfaces a genuine error once the supersede grace window passes', async () => {
    const calls = [];
    globalThis.fetch = vi.fn(async (url, init = {}) => {
      calls.push({ url: String(url), method: init.method ?? 'GET', body: init.body });
      return { ok: true, status: 200, json: async () => ({}), text: async () => '' };
    });
    const bridge = makeBridge({
      store: {
        ...makeFakeStore(),
        lookup: ({ targetKey }) =>
          targetKey === 'chan-sup3' ? { sessionId: 'ses-sup3', projectPath: '/p' } : null,
      },
    });

    await bridge.routeInbound({
      type: 'discord', token: 'bot-token', channelId: 'chan-sup3', threadId: null, text: 'go',
    });
    // A genuine, non-transient error (not an abort teardown) is always shown.
    await bridge._handleGlobalEvent({
      directory: '/p',
      payload: {
        type: 'session.error',
        properties: { sessionID: 'ses-sup3', error: { data: { message: 'Model returned an invalid tool call' } } },
      },
    });
    await flush();

    const errorLines = calls
      .filter((c) => c.method === 'POST' && c.url.includes('/channels/chan-sup3/messages'))
      .map((c) => JSON.parse(c.body).content)
      .filter((p) => p.startsWith('✗'));
    expect(errorLines).toHaveLength(1);
  });
});

describe('session.error — clean, de-duplicated, no false "done"', () => {
  let originalFetch;
  beforeEach(() => {
    originalFetch = globalThis.fetch;
  });
  afterEach(() => {
    globalThis.fetch = originalFetch;
    vi.restoreAllMocks();
  });

  it('posts one friendly DB-error line and suppresses the trailing done footer', async () => {
    const calls = [];
    globalThis.fetch = vi.fn(async (url, init = {}) => {
      calls.push({ url: String(url), method: init.method ?? 'GET', body: init.body });
      return { ok: true, status: 200, json: async () => ({}), text: async () => '' };
    });

    const bridge = makeBridge({
      store: {
        ...makeFakeStore(),
        lookup: ({ targetKey }) =>
          targetKey === 'chan-e' ? { sessionId: 'ses-e', projectPath: '/p' } : null,
      },
    });

    await bridge.routeInbound({
      type: 'discord', token: 'bot-token', channelId: 'chan-e', threadId: null, text: 'hi',
    });

    const drizzle = {
      name: 'UnknownError',
      data: { message: 'EffectDrizzleQueryError: Failed query: insert into "message" ("id", "session_id") values (?, ?) on conflict' },
    };
    // OpenCode emits the same fault several times (message + each part).
    for (const id of ['e1', 'e2', 'e3']) {
      await bridge._handleGlobalEvent({
        directory: '/p',
        payload: { type: 'session.error', properties: { sessionID: 'ses-e', error: drizzle } },
      });
    }
    // …then idles afterwards.
    await bridge._handleGlobalEvent({
      directory: '/p',
      payload: { type: 'session.idle', properties: { sessionID: 'ses-e' } },
    });
    await flush();

    const posted = calls
      .filter((c) => c.method === 'POST' && c.url.includes('/channels/chan-e/messages'))
      .map((c) => JSON.parse(c.body).content);

    const errorLines = posted.filter((p) => p.startsWith('✗'));
    expect(errorLines).toHaveLength(1); // de-duplicated
    expect(errorLines[0]).toContain('database write error');
    expect(errorLines[0]).not.toContain('insert into'); // raw SQL never leaks
    expect(posted.some((p) => p.includes('done ·'))).toBe(false); // no false footer
  });
});

describe('duplicate session.idle — single "done" footer (abort/force-stop)', () => {
  let originalFetch;
  beforeEach(() => {
    originalFetch = globalThis.fetch;
  });
  afterEach(() => {
    globalThis.fetch = originalFetch;
    vi.restoreAllMocks();
  });

  it('posts exactly one done footer when OpenCode emits session.idle twice', async () => {
    const calls = [];
    globalThis.fetch = vi.fn(async (url, init = {}) => {
      calls.push({ url: String(url), method: init.method ?? 'GET', body: init.body });
      return { ok: true, status: 200, json: async () => ({}), text: async () => '' };
    });

    const bridge = makeBridge({
      store: {
        ...makeFakeStore(),
        lookup: ({ targetKey }) =>
          targetKey === 'chan-d' ? { sessionId: 'ses-d', projectPath: '/p' } : null,
      },
    });

    await bridge.routeInbound({
      type: 'discord', token: 'bot-token', channelId: 'chan-d', threadId: null, text: 'hi',
    });

    // Force-stop / abort settles the turn, but OpenCode emits session.idle more
    // than once afterwards. The second idle must not post a bogus "done · …".
    await bridge._handleGlobalEvent({
      directory: '/p',
      payload: { type: 'session.idle', properties: { sessionID: 'ses-d' } },
    });
    await bridge._handleGlobalEvent({
      directory: '/p',
      payload: { type: 'session.idle', properties: { sessionID: 'ses-d' } },
    });
    for (let i = 0; i < 5; i++) await flush();

    const doneFooters = calls
      .filter((c) => c.method === 'POST' && c.url.includes('/channels/chan-d/messages'))
      .map((c) => JSON.parse(c.body).content)
      .filter((p) => p.includes('done ·'));

    expect(doneFooters).toHaveLength(1);
  });
});

describe('getSurfaceModelInfo — concrete model fallback', () => {
  let originalFetch;
  beforeEach(() => {
    originalFetch = globalThis.fetch;
  });
  afterEach(() => {
    globalThis.fetch = originalFetch;
    vi.restoreAllMocks();
  });

  it('reports the bound session\'s actual model instead of "OpenCode default"', async () => {
    globalThis.fetch = vi.fn(async (url) => {
      const u = String(url);
      if (u.includes('/session/ses-x') && !u.includes('/message')) {
        return {
          ok: true,
          status: 200,
          json: async () => ({ id: 'ses-x', model: { providerID: 'anthropic', id: 'claude-x', variant: 'high' } }),
          text: async () => '',
        };
      }
      return { ok: true, status: 200, json: async () => ({}), text: async () => '' };
    });

    const bridge = makeBridge({
      store: {
        ...makeFakeStore(),
        lookup: ({ targetKey }) =>
          targetKey === 'chan-x' ? { sessionId: 'ses-x', projectPath: '/p' } : null,
      },
    });

    const info = await bridge.getSurfaceModelInfo({ type: 'discord', token: 'bot-token', channelId: 'chan-x' });
    expect(info).toEqual({ model: 'anthropic/claude-x', variant: 'high', source: 'session' });
  });

  it('falls back to the latest assistant message model when the session has none', async () => {
    globalThis.fetch = vi.fn(async (url) => {
      const u = String(url);
      if (u.includes('/session/ses-y/message')) {
        return {
          ok: true,
          status: 200,
          json: async () => [
            { info: { role: 'user', id: 'm1' } },
            { info: { role: 'assistant', id: 'm2', providerID: 'openai', modelID: 'gpt-x', variant: 'low' } },
          ],
          text: async () => '',
        };
      }
      if (u.includes('/session/ses-y')) {
        return { ok: true, status: 200, json: async () => ({ id: 'ses-y' }), text: async () => '' };
      }
      return { ok: true, status: 200, json: async () => ({}), text: async () => '' };
    });

    const bridge = makeBridge({
      store: {
        ...makeFakeStore(),
        lookup: ({ targetKey }) =>
          targetKey === 'chan-y' ? { sessionId: 'ses-y', projectPath: '/p' } : null,
      },
    });

    const info = await bridge.getSurfaceModelInfo({ type: 'discord', token: 'bot-token', channelId: 'chan-y' });
    expect(info).toEqual({ model: 'openai/gpt-x', variant: 'low', source: 'session' });
  });
});

describe('project ↔ channel lifecycle endpoints', () => {
  let originalFetch;

  beforeEach(() => {
    originalFetch = globalThis.fetch;
  });

  afterEach(() => {
    globalThis.fetch = originalFetch;
    vi.restoreAllMocks();
  });

  function makeApp({ settings, persistSettings }) {
    const app = express();
    app.use(
      '/',
      createMessengerSyncRouter({
        broadcastEvent: () => {},
        readSettings: async () => settings,
        persistSettings,
        sanitizeProjects: (projects) => projects,
      }).router,
    );
    return app;
  }

  it('project-added creates a channel and persists the binding', async () => {
    globalThis.fetch = vi.fn(async (url, init) => {
      const u = String(url);
      if (u.includes('/guilds/guild-1/channels') && init?.method === 'POST') {
        return { ok: true, status: 200, json: async () => ({ id: 'chan-new', name: 'my-proj' }), text: async () => '' };
      }
      if (u.includes('/guilds/guild-1/channels')) {
        return { ok: true, status: 200, json: async () => [], text: async () => '' };
      }
      return { ok: false, status: 404, json: async () => ({}), text: async () => 'not found' };
    });
    const persistSettings = vi.fn(async () => {});
    const app = makeApp({
      settings: { discord: { botToken: 'old', guildId: 'guild-1', defaultChannelId: 'general' } },
      persistSettings,
    });

    const res = await request(app)
      .post('/bridge/project-added')
      .send({ project: { id: 'p1', path: '/p/my-proj', label: 'My Proj' }, discord: { token: 'bot', guildId: 'guild-1' } })
      .expect(200);

    expect(res.body.ok).toBe(true);
    expect(res.body.results[0]).toMatchObject({ channelId: 'chan-new', channelName: 'my-proj', created: true });
    expect(persistSettings).toHaveBeenCalledWith({
      discord: expect.objectContaining({
        defaultChannelId: 'general',
        projectBindings: [{ channelId: 'chan-new', projectPath: '/p/my-proj', projectLabel: 'My Proj' }],
      }),
    });
  });

  it('project-added reuses an existing channel by slug instead of creating one', async () => {
    globalThis.fetch = vi.fn(async (url, init) => {
      const u = String(url);
      if (u.includes('/guilds/guild-1/channels') && init?.method === 'POST') {
        throw new Error('should not create when channel exists');
      }
      if (u.includes('/guilds/guild-1/channels')) {
        return {
          ok: true,
          status: 200,
          json: async () => [{ id: 'chan-x', name: 'my-proj', type: 0 }],
          text: async () => '',
        };
      }
      return { ok: false, status: 404, json: async () => ({}), text: async () => 'not found' };
    });
    const persistSettings = vi.fn(async () => {});
    const app = makeApp({
      settings: { discord: { botToken: 'old', guildId: 'guild-1' } },
      persistSettings,
    });

    const res = await request(app)
      .post('/bridge/project-added')
      .send({ project: { id: 'p1', path: '/p/my-proj', label: 'My Proj' }, discord: { token: 'bot', guildId: 'guild-1' } })
      .expect(200);

    expect(res.body.results[0]).toMatchObject({ channelId: 'chan-x', created: false });
    const createCalls = globalThis.fetch.mock.calls.filter(
      ([url, init]) => String(url).includes('/guilds/guild-1/channels') && init?.method === 'POST',
    );
    expect(createCalls).toHaveLength(0);
  });

  it('project-renamed renames the channel and updates the binding label', async () => {
    globalThis.fetch = vi.fn(async (url, init) => {
      const u = String(url);
      if (u.includes('/channels/chan-x') && init?.method === 'PATCH') {
        return { ok: true, status: 200, json: async () => ({ id: 'chan-x', name: 'new-name' }), text: async () => '' };
      }
      if (u.includes('/channels/chan-x')) {
        return { ok: true, status: 200, json: async () => ({ id: 'chan-x', name: 'old' }), text: async () => '' };
      }
      return { ok: false, status: 404, json: async () => ({}), text: async () => 'not found' };
    });
    const persistSettings = vi.fn(async () => {});
    const app = makeApp({
      settings: {
        discord: {
          botToken: 'old',
          guildId: 'guild-1',
          projectBindings: [{ channelId: 'chan-x', projectPath: '/p/old', projectLabel: 'Old' }],
        },
      },
      persistSettings,
    });

    const res = await request(app)
      .post('/bridge/project-renamed')
      .send({ project: { id: 'p1', path: '/p/old', label: 'New Name' }, discord: { token: 'bot', guildId: 'guild-1' } })
      .expect(200);

    expect(res.body).toMatchObject({ ok: true, channelId: 'chan-x', renamed: true });
    expect(persistSettings).toHaveBeenCalledWith({
      discord: expect.objectContaining({
        projectBindings: [{ channelId: 'chan-x', projectPath: '/p/old', projectLabel: 'New Name' }],
      }),
    });
  });

  it('project-renamed skips the Discord PATCH when the name already matches', async () => {
    globalThis.fetch = vi.fn(async (url, init) => {
      const u = String(url);
      if (u.includes('/channels/chan-x') && init?.method === 'PATCH') {
        throw new Error('should not PATCH when name already matches slug');
      }
      if (u.includes('/channels/chan-x')) {
        return { ok: true, status: 200, json: async () => ({ id: 'chan-x', name: 'new-name' }), text: async () => '' };
      }
      return { ok: false, status: 404, json: async () => ({}), text: async () => 'not found' };
    });
    const persistSettings = vi.fn(async () => {});
    const app = makeApp({
      settings: {
        discord: {
          botToken: 'old',
          guildId: 'guild-1',
          projectBindings: [{ channelId: 'chan-x', projectPath: '/p/old', projectLabel: 'Old' }],
        },
      },
      persistSettings,
    });

    const res = await request(app)
      .post('/bridge/project-renamed')
      .send({ project: { id: 'p1', path: '/p/old', label: 'New Name' }, discord: { token: 'bot', guildId: 'guild-1' } })
      .expect(200);

    expect(res.body.renamed).toBe(false);
    const patchCalls = globalThis.fetch.mock.calls.filter(
      ([url, init]) => String(url).includes('/channels/chan-x') && init?.method === 'PATCH',
    );
    expect(patchCalls).toHaveLength(0);
  });

  it('project-removed deletes the channel and drops the binding', async () => {
    globalThis.fetch = vi.fn(async (url, init) => {
      const u = String(url);
      if (u.includes('/channels/chan-x') && init?.method === 'DELETE') {
        return { ok: true, status: 200, json: async () => ({ id: 'chan-x' }), text: async () => '' };
      }
      return { ok: false, status: 404, json: async () => ({}), text: async () => 'not found' };
    });
    const persistSettings = vi.fn(async () => {});
    const app = makeApp({
      settings: {
        discord: {
          botToken: 'old',
          guildId: 'guild-1',
          projectBindings: [{ channelId: 'chan-x', projectPath: '/p/old', projectLabel: 'Old' }],
        },
      },
      persistSettings,
    });

    const res = await request(app)
      .post('/bridge/project-removed')
      .send({ project: { id: 'p1', path: '/p/old' }, discord: { token: 'bot' } })
      .expect(200);

    expect(res.body).toMatchObject({ ok: true, channelId: 'chan-x', deleted: true });
    expect(persistSettings).toHaveBeenCalledWith({
      discord: expect.objectContaining({ projectBindings: undefined }),
    });
  });
});

describe('two-way channel events (Discord → bridge)', () => {
  let originalFetch;

  beforeEach(() => {
    originalFetch = globalThis.fetch;
    globalThis.fetch = vi.fn(async () => ({ ok: true, status: 200, json: async () => ({}), text: async () => '' }));
  });

  afterEach(() => {
    globalThis.fetch = originalFetch;
    vi.restoreAllMocks();
  });

  function makeChannelBridge({ settings, persistSettings, broadcastEvent }) {
    return createMessengerOpencodeBridge({
      globalEventHub: { subscribeEvent: () => () => {} },
      buildOpenCodeUrl: (p) => `http://opencode${p}`,
      getOpenCodeAuthHeaders: () => ({}),
      broadcastEvent,
      store: { ...makeFakeStore(), unbind: () => {} },
      listProjects: async () => [],
      readSettings: async () => settings,
      persistSettings,
    });
  }

  it('handleChannelDeleted drops the binding and broadcasts an unlink', async () => {
    const persistSettings = vi.fn(async () => {});
    const broadcastEvent = vi.fn();
    const bridge = makeChannelBridge({
      settings: {
        discord: {
          projectBindings: [
            { channelId: 'c1', projectPath: '/a', projectLabel: 'A' },
            { channelId: 'c2', projectPath: '/b', projectLabel: 'B' },
          ],
        },
      },
      persistSettings,
      broadcastEvent,
    });

    const result = await bridge.handleChannelDeleted({ channelId: 'c1', token: 'bot' });
    expect(result).toMatchObject({ ok: true, matched: true, projectPath: '/a' });
    expect(persistSettings).toHaveBeenCalledWith({
      discord: expect.objectContaining({
        projectBindings: [{ channelId: 'c2', projectPath: '/b', projectLabel: 'B' }],
      }),
    });
    expect(broadcastEvent).toHaveBeenCalledWith(
      'messenger.bridge.project_channel_removed',
      expect.objectContaining({ source: 'discord', channelId: 'c1', projectPath: '/a' }),
    );
  });

  it('handleChannelRenamed updates the label and broadcasts', async () => {
    const persistSettings = vi.fn(async () => {});
    const broadcastEvent = vi.fn();
    const bridge = makeChannelBridge({
      settings: { discord: { projectBindings: [{ channelId: 'c1', projectPath: '/a', projectLabel: 'A' }] } },
      persistSettings,
      broadcastEvent,
    });

    const result = await bridge.handleChannelRenamed({ channelId: 'c1', name: 'cool-project' });
    expect(result).toMatchObject({ ok: true, matched: true, changed: true });
    expect(persistSettings).toHaveBeenCalledWith({
      discord: expect.objectContaining({
        projectBindings: [{ channelId: 'c1', projectPath: '/a', projectLabel: 'Cool Project' }],
      }),
    });
    expect(broadcastEvent).toHaveBeenCalledWith(
      'messenger.bridge.project_channel_renamed',
      expect.objectContaining({ source: 'discord', channelId: 'c1', projectLabel: 'Cool Project' }),
    );
  });

  it('handleChannelRenamed is a no-op when the name still slugs to the current label', async () => {
    const persistSettings = vi.fn(async () => {});
    const broadcastEvent = vi.fn();
    const bridge = makeChannelBridge({
      settings: { discord: { projectBindings: [{ channelId: 'c1', projectPath: '/a', projectLabel: 'Cool Project' }] } },
      persistSettings,
      broadcastEvent,
    });

    const result = await bridge.handleChannelRenamed({ channelId: 'c1', name: 'cool-project' });
    expect(result).toMatchObject({ ok: true, matched: true, changed: false });
    expect(persistSettings).not.toHaveBeenCalled();
    expect(broadcastEvent).not.toHaveBeenCalledWith(
      'messenger.bridge.project_channel_renamed',
      expect.anything(),
    );
  });
});

describe('resolveMessengerTarget — async token lookup (regression)', () => {
  const store = {
    lookupBySessionId: (id) =>
      id === 'ses-bound'
        ? [{ type: 'discord', targetKey: 'thread-x', projectPath: '/proj' }]
        : [],
  };

  // The bug: readSettings is async, so calling it without `await` left the bot
  // token undefined and this returned null. Guard that it now awaits and
  // surfaces the token.
  it('awaits async readSettings and returns the bot token + thread binding', async () => {
    const readSettings = vi.fn(async () => ({ discord: { botToken: 'bot-token' } }));
    const target = await resolveMessengerTarget({ store, readSettings, sessionId: 'ses-bound' });
    expect(readSettings).toHaveBeenCalledTimes(1);
    expect(target).toMatchObject({
      type: 'discord',
      token: 'bot-token',
      targetKey: 'thread-x',
      threadId: null,
      projectPath: '/proj',
    });
  });

  it('reads the token from a legacy discordConnections[0] shape too', async () => {
    const readSettings = async () => ({ discordConnections: [{ botToken: 'legacy-token' }] });
    const target = await resolveMessengerTarget({ store, readSettings, sessionId: 'ses-bound' });
    expect(target?.token).toBe('legacy-token');
  });

  it('returns null when settings carry no bot token', async () => {
    const target = await resolveMessengerTarget({
      store,
      readSettings: async () => ({ discord: {} }),
      sessionId: 'ses-bound',
    });
    expect(target).toBeNull();
  });

  it('returns null for a session with no binding', async () => {
    const target = await resolveMessengerTarget({
      store,
      readSettings: async () => ({ discord: { botToken: 'bot-token' } }),
      sessionId: 'ses-unbound',
    });
    expect(target).toBeNull();
  });
});

describe('session deletion → Discord thread cleanup', () => {
  let originalFetch;

  beforeEach(() => {
    originalFetch = globalThis.fetch;
  });

  afterEach(() => {
    globalThis.fetch = originalFetch;
    vi.restoreAllMocks();
  });

  function makeDeleteStore({ unbind }) {
    const binding = {
      type: 'discord',
      targetKey: 'thread-del',
      botTokenHash: 'hash-1',
      sessionId: 'ses-del',
      projectPath: '/p',
    };
    return {
      ...makeFakeStore(),
      lookupBySessionId: (id) => (id === 'ses-del' ? [binding] : []),
      findByTargetKey: ({ targetKey }) => (targetKey === 'thread-del' ? [binding] : []),
      unbind,
    };
  }

  // Regression: shift-delete (hard delete) of an *idle* session — one with no
  // live in-memory context — must still delete its Discord thread. The bot
  // token is resolved through `lookupMessengerTarget`, which reads settings
  // from disk asynchronously. A previous bug left that lookup non-awaited, so
  // the token was always undefined and the thread was orphaned.
  it('deletes the bound Discord thread for an idle session via the async token lookup', async () => {
    const deleteCalls = [];
    globalThis.fetch = vi.fn(async (url, init) => {
      if (init?.method === 'DELETE') deleteCalls.push(String(url));
      return { ok: true, status: 200, json: async () => ({}), text: async () => '' };
    });

    const unbind = vi.fn();
    const broadcastEvent = vi.fn();
    // Async, exactly like the real makeLookupMessengerTarget after the fix.
    const lookupMessengerTarget = vi.fn(async (sessionId) =>
      sessionId === 'ses-del'
        ? { type: 'discord', token: 'bot-token', targetKey: 'thread-del', threadId: null, projectPath: '/p' }
        : null,
    );

    const bridge = makeBridge({
      store: makeDeleteStore({ unbind }),
      lookupMessengerTarget,
      broadcastEvent,
    });

    await bridge._handleGlobalEvent({
      directory: '/p',
      payload: { type: 'session.deleted', properties: { sessionID: 'ses-del' } },
    });
    await flush();
    await flush();

    expect(lookupMessengerTarget).toHaveBeenCalledWith('ses-del');
    expect(deleteCalls.some((u) => u.includes('/channels/thread-del'))).toBe(true);
    expect(unbind).toHaveBeenCalledWith(
      expect.objectContaining({ type: 'discord', targetKey: 'thread-del', botTokenHash: 'hash-1' }),
    );
    expect(broadcastEvent).toHaveBeenCalledWith(
      'messenger.bridge.thread_deleted_from_session',
      expect.objectContaining({ type: 'discord', threadId: 'thread-del', sessionId: 'ses-del' }),
    );
  });

  it('also handles the session.removed alias', async () => {
    const deleteCalls = [];
    globalThis.fetch = vi.fn(async (url, init) => {
      if (init?.method === 'DELETE') deleteCalls.push(String(url));
      return { ok: true, status: 200, json: async () => ({}), text: async () => '' };
    });

    const bridge = makeBridge({
      store: makeDeleteStore({ unbind: vi.fn() }),
      lookupMessengerTarget: async () => ({
        type: 'discord',
        token: 'bot-token',
        targetKey: 'thread-del',
        threadId: null,
        projectPath: '/p',
      }),
    });

    await bridge._handleGlobalEvent({
      directory: '/p',
      payload: { type: 'session.removed', properties: { sessionID: 'ses-del' } },
    });
    await flush();
    await flush();

    expect(deleteCalls.some((u) => u.includes('/channels/thread-del'))).toBe(true);
  });

  // Defensive: when no token can be resolved (no live context AND the lookup
  // can't find one) we must not pretend the thread was deleted — the binding is
  // still dropped, but no Discord DELETE is issued and no success event fires.
  it('does not issue a Discord delete (or success event) when no token can be resolved', async () => {
    const deleteCalls = [];
    globalThis.fetch = vi.fn(async (url, init) => {
      if (init?.method === 'DELETE') deleteCalls.push(String(url));
      return { ok: true, status: 200, json: async () => ({}), text: async () => '' };
    });

    const unbind = vi.fn();
    const broadcastEvent = vi.fn();
    const bridge = makeBridge({
      store: makeDeleteStore({ unbind }),
      lookupMessengerTarget: async () => null,
      broadcastEvent,
    });

    await bridge._handleGlobalEvent({
      directory: '/p',
      payload: { type: 'session.deleted', properties: { sessionID: 'ses-del' } },
    });
    await flush();
    await flush();

    expect(deleteCalls).toHaveLength(0);
    expect(unbind).toHaveBeenCalled();
    expect(broadcastEvent).not.toHaveBeenCalledWith(
      'messenger.bridge.thread_deleted_from_session',
      expect.anything(),
    );
  });
});
