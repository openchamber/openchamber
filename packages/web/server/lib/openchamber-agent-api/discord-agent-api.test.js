import { describe, expect, it, vi, beforeEach, afterEach } from 'vitest';
import express from 'express';
import request from 'supertest';

import {
  createDiscordAgentRouter,
  parseDiscordUrl,
  buildDiscordUrl,
  chunkForDiscord,
} from './discord-agent-api.js';

const TOKEN = 'bot-token-xyz';
const GUILD = '111111111111111111';
const PROJECT_CHANNEL = '222222222222222222';
const SESSION_THREAD = '333333333333333333';

function makeSettings(overrides = {}) {
  return {
    discord: {
      botToken: TOKEN,
      guildId: GUILD,
      projectBindings: [
        { channelId: PROJECT_CHANNEL, projectPath: '/home/me/my-app', projectLabel: 'My App' },
      ],
      ...overrides,
    },
  };
}

function makeBridge(sessions = []) {
  const rows = sessions.map((session) => ({
    type: 'discord',
    targetKey: session.targetKey,
    sessionId: session.sessionId,
    projectPath: session.projectPath ?? null,
    projectLabel: session.projectLabel ?? null,
  }));
  return {
    store: {
      list: vi.fn(() => rows),
      lookupBySessionId: vi.fn((sessionId) =>
        rows.filter((row) => row.sessionId === sessionId).map((row) => ({
          type: row.type,
          targetKey: row.targetKey,
          projectPath: row.projectPath,
          projectLabel: row.projectLabel,
        })),
      ),
      findByTargetKey: vi.fn(({ targetKey }) =>
        rows
          .filter((row) => row.targetKey === targetKey)
          .map((row) => ({ sessionId: row.sessionId, projectPath: row.projectPath })),
      ),
    },
  };
}

function createApp({
  readSettings,
  bridge = null,
  broadcastEvent = null,
  bootstrapProject = null,
  autoCreateProjectChannel = null,
  listProjects = null,
  opencodeFetch = null,
} = {}) {
  const app = express();
  app.use(express.json());
  app.use(
    '/api/openchamber-agent/messenger/agent',
    createDiscordAgentRouter({
      readSettings,
      bridge,
      broadcastEvent,
      getLocalApiBaseUrl: () => 'http://127.0.0.1:3001',
      bootstrapProject,
      autoCreateProjectChannel,
      listProjects,
      opencodeFetch,
    }),
  );
  return app;
}

describe('discord-agent-api — pure helpers', () => {
  it('parseDiscordUrl with real snowflakes', () => {
    expect(
      parseDiscordUrl(`https://discord.com/channels/${GUILD}/${PROJECT_CHANNEL}`),
    ).toEqual({ guildId: GUILD, channelId: PROJECT_CHANNEL, messageId: null });

    expect(
      parseDiscordUrl(`https://discord.com/channels/${GUILD}/${PROJECT_CHANNEL}/444444444444444444`),
    ).toEqual({ guildId: GUILD, channelId: PROJECT_CHANNEL, messageId: '444444444444444444' });

    expect(parseDiscordUrl(`https://discord.com/channels/@me/${PROJECT_CHANNEL}`)).toEqual({
      guildId: null,
      channelId: PROJECT_CHANNEL,
      messageId: null,
    });

    expect(parseDiscordUrl('not a url')).toBeNull();
    expect(parseDiscordUrl(null)).toBeNull();
  });

  it('buildDiscordUrl renders guild, @me, and message variants', () => {
    expect(buildDiscordUrl({ guildId: GUILD, channelId: PROJECT_CHANNEL })).toBe(
      `https://discord.com/channels/${GUILD}/${PROJECT_CHANNEL}`,
    );
    expect(buildDiscordUrl({ channelId: PROJECT_CHANNEL })).toBe(
      `https://discord.com/channels/@me/${PROJECT_CHANNEL}`,
    );
    expect(
      buildDiscordUrl({ guildId: GUILD, channelId: PROJECT_CHANNEL, messageId: '999' }),
    ).toBe(`https://discord.com/channels/${GUILD}/${PROJECT_CHANNEL}/999`);
    expect(buildDiscordUrl({})).toBeNull();
  });

  it('chunkForDiscord keeps short text as one chunk and splits long text', () => {
    expect(chunkForDiscord('hello')).toEqual(['hello']);
    expect(chunkForDiscord('')).toEqual([]);
    const long = 'a'.repeat(2500);
    const chunks = chunkForDiscord(long);
    expect(chunks.length).toBe(2);
    expect(chunks.every((c) => c.length <= 2000)).toBe(true);
    expect(chunks.join('')).toBe(long);
  });
});

describe('discord-agent-api — routes', () => {
  let fetchMock;

  beforeEach(() => {
    fetchMock = vi.fn();
    vi.stubGlobal('fetch', fetchMock);
  });

  afterEach(() => {
    vi.unstubAllGlobals();
    vi.restoreAllMocks();
  });

  it('GET /help describes the endpoints', async () => {
    const app = createApp({ readSettings: async () => makeSettings() });
    const res = await request(app).get('/api/openchamber-agent/messenger/agent/help');
    expect(res.status).toBe(200);
    expect(res.body.ok).toBe(true);
    expect(res.body.endpoints).toHaveProperty('POST /agent/post');
  });

  it('GET /targets returns 503 when Discord is not configured', async () => {
    const app = createApp({ readSettings: async () => ({}) });
    const res = await request(app).get('/api/openchamber-agent/messenger/agent/targets');
    expect(res.status).toBe(503);
    expect(res.body.ok).toBe(false);
  });

  it('GET /targets lists project channels and live session threads with URLs', async () => {
    const bridge = makeBridge([
      {
        sessionId: 'ses_abc',
        targetKey: SESSION_THREAD,
        projectPath: '/home/me/my-app',
        projectLabel: 'My App',
        lastUsedAt: '2026-01-01T00:00:00Z',
      },
      // session with empty sessionId is a pre-bind placeholder and must be skipped
      { sessionId: '', targetKey: '999', projectPath: '/x' },
    ]);
    const app = createApp({ readSettings: async () => makeSettings(), bridge });
    const res = await request(app).get('/api/openchamber-agent/messenger/agent/targets');
    expect(res.status).toBe(200);
    expect(res.body.guildId).toBe(GUILD);
    expect(res.body.projects).toHaveLength(1);
    expect(res.body.projects[0].url).toBe(
      `https://discord.com/channels/${GUILD}/${PROJECT_CHANNEL}`,
    );
    expect(res.body.sessions).toHaveLength(1);
    expect(res.body.sessions[0].sessionId).toBe('ses_abc');
    expect(res.body.sessions[0].url).toBe(
      `https://discord.com/channels/${GUILD}/${SESSION_THREAD}`,
    );
  });

  it('POST /resolve resolves by project label', async () => {
    const app = createApp({ readSettings: async () => makeSettings() });
    const res = await request(app)
      .post('/api/openchamber-agent/messenger/agent/resolve')
      .send({ project: 'My App' });
    expect(res.status).toBe(200);
    expect(res.body.target.channelId).toBe(PROJECT_CHANNEL);
    expect(res.body.target.url).toBe(`https://discord.com/channels/${GUILD}/${PROJECT_CHANNEL}`);
    // no fetch needed — guild id came from settings
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('POST /resolve resolves by session id', async () => {
    const bridge = makeBridge([
      { sessionId: 'ses_abc', targetKey: SESSION_THREAD, projectPath: '/home/me/my-app' },
    ]);
    const app = createApp({ readSettings: async () => makeSettings(), bridge });
    const res = await request(app)
      .post('/api/openchamber-agent/messenger/agent/resolve')
      .send({ session: 'ses_abc' });
    expect(res.status).toBe(200);
    expect(res.body.target.kind).toBe('session');
    expect(res.body.target.channelId).toBe(SESSION_THREAD);
  });

  it('POST /resolve accepts a raw channel id and a discord URL', async () => {
    const app = createApp({ readSettings: async () => makeSettings() });

    const byId = await request(app)
      .post('/api/openchamber-agent/messenger/agent/resolve')
      .send({ channel: PROJECT_CHANNEL });
    expect(byId.status).toBe(200);
    expect(byId.body.target.channelId).toBe(PROJECT_CHANNEL);

    const byUrl = await request(app)
      .post('/api/openchamber-agent/messenger/agent/resolve')
      .send({ channel: `https://discord.com/channels/${GUILD}/${SESSION_THREAD}` });
    expect(byUrl.status).toBe(200);
    expect(byUrl.body.target.channelId).toBe(SESSION_THREAD);
    expect(byUrl.body.target.guildId).toBe(GUILD);
  });

  it('POST /resolve errors when nothing matches or nothing is provided', async () => {
    const app = createApp({ readSettings: async () => makeSettings() });

    const none = await request(app).post('/api/openchamber-agent/messenger/agent/resolve').send({});
    expect(none.status).toBe(400);

    const missing = await request(app)
      .post('/api/openchamber-agent/messenger/agent/resolve')
      .send({ project: 'does-not-exist' });
    expect(missing.status).toBe(400);
    expect(missing.body.error).toContain('No Discord channel');
  });

  it('POST /post sends a message and returns the message URL', async () => {
    fetchMock.mockResolvedValueOnce({
      ok: true,
      json: async () => ({ id: '555555555555555555' }),
    });
    const broadcastEvent = vi.fn();
    const app = createApp({ readSettings: async () => makeSettings(), broadcastEvent });

    const res = await request(app)
      .post('/api/openchamber-agent/messenger/agent/post')
      .send({ project: 'my-app', text: 'Build is green' });

    expect(res.status).toBe(200);
    expect(res.body.ok).toBe(true);
    expect(res.body.messageIds).toEqual(['555555555555555555']);
    expect(res.body.url).toBe(
      `https://discord.com/channels/${GUILD}/${PROJECT_CHANNEL}/555555555555555555`,
    );

    // exactly one POST to the channel messages endpoint
    expect(fetchMock).toHaveBeenCalledTimes(1);
    const [url, init] = fetchMock.mock.calls[0];
    expect(url).toContain(`/channels/${PROJECT_CHANNEL}/messages`);
    expect(init.method).toBe('POST');
    expect(JSON.parse(init.body).content).toBe('Build is green');
    expect(broadcastEvent).toHaveBeenCalledWith(
      'messenger.discord.sent',
      expect.objectContaining({ via: 'agent-api' }),
    );
  });

  it('POST /post requires non-empty text', async () => {
    const app = createApp({ readSettings: async () => makeSettings() });
    const res = await request(app)
      .post('/api/openchamber-agent/messenger/agent/post')
      .send({ project: 'my-app', text: '   ' });
    expect(res.status).toBe(400);
    expect(res.body.error).toContain('text is required');
  });

  it('POST /post surfaces Discord API errors', async () => {
    fetchMock.mockResolvedValueOnce({
      ok: false,
      status: 403,
      text: async () => 'Missing Access',
    });
    const app = createApp({ readSettings: async () => makeSettings() });
    const res = await request(app)
      .post('/api/openchamber-agent/messenger/agent/post')
      .send({ channel: PROJECT_CHANNEL, text: 'hi' });
    expect(res.status).toBe(200);
    expect(res.body.ok).toBe(false);
    expect(res.body.error).toContain('403');
  });

  it('POST /post fills a missing guild id via REST for the deep link', async () => {
    // settings without a guildId → /post resolves the channel's guild via REST.
    const settings = makeSettings();
    delete settings.discord.guildId;
    settings.discord.projectBindings = [
      { channelId: PROJECT_CHANNEL, projectPath: '/home/me/my-app', projectLabel: 'My App' },
    ];

    fetchMock
      // 1) the message POST
      .mockResolvedValueOnce({ ok: true, json: async () => ({ id: '777' }) })
      // 2) ensureGuildId GET /channels/:id
      .mockResolvedValueOnce({ ok: true, json: async () => ({ guild_id: GUILD }) });

    const app = createApp({ readSettings: async () => settings });
    const res = await request(app)
      .post('/api/openchamber-agent/messenger/agent/post')
      .send({ project: 'my-app', text: 'hello' });

    expect(res.status).toBe(200);
    expect(res.body.url).toBe(
      `https://discord.com/channels/${GUILD}/${PROJECT_CHANNEL}/777`,
    );
  });
});

describe('discord-agent-api — POST /create-project', () => {
  const NEW_CHANNEL = '444444444444444444';
  const NEW_PROJECT = { id: 'proj_1', path: '/home/me/new-app', label: 'New App' };

  it('returns 503 when project bootstrap is not wired', async () => {
    const app = createApp({ readSettings: async () => makeSettings() });
    const res = await request(app)
      .post('/api/openchamber-agent/messenger/agent/create-project')
      .send({ action: 'new', label: 'New App' });
    expect(res.status).toBe(503);
    expect(res.body.ok).toBe(false);
  });

  it('rejects unknown actions', async () => {
    const app = createApp({
      readSettings: async () => makeSettings(),
      bootstrapProject: vi.fn(),
    });
    const res = await request(app)
      .post('/api/openchamber-agent/messenger/agent/create-project')
      .send({ action: 'destroy' });
    expect(res.status).toBe(400);
    expect(res.body.error).toContain("'new' | 'clone' | 'path'");
  });

  it('creates the project and the Discord channel, returning both', async () => {
    const bootstrapProject = vi.fn(async () => ({ ok: true, project: NEW_PROJECT }));
    const autoCreateProjectChannel = vi.fn(async () => [
      { type: 'discord', ok: true, channelId: NEW_CHANNEL, channelName: 'new-app', created: true },
    ]);
    const app = createApp({
      readSettings: async () => makeSettings(),
      bootstrapProject,
      autoCreateProjectChannel,
    });

    const res = await request(app)
      .post('/api/openchamber-agent/messenger/agent/create-project')
      .send({ action: 'path', path: '/home/me/new-app', label: 'New App' });

    expect(res.status).toBe(200);
    expect(res.body.ok).toBe(true);
    expect(res.body.project).toEqual(NEW_PROJECT);
    expect(res.body.discord).toEqual({
      ok: true,
      channelId: NEW_CHANNEL,
      channelName: 'new-app',
      created: true,
      url: `https://discord.com/channels/${GUILD}/${NEW_CHANNEL}`,
    });
    expect(bootstrapProject).toHaveBeenCalledWith({
      action: 'path',
      url: undefined,
      path: '/home/me/new-app',
      label: 'New App',
    });
    expect(autoCreateProjectChannel).toHaveBeenCalledWith(NEW_PROJECT);
  });

  it('reports project success with an explicit discord error when Discord is not configured', async () => {
    const bootstrapProject = vi.fn(async () => ({ ok: true, project: NEW_PROJECT }));
    // autoCreateProjectChannel returns null → Discord not configured
    const app = createApp({
      readSettings: async () => ({}),
      bootstrapProject,
      autoCreateProjectChannel: vi.fn(async () => null),
    });

    const res = await request(app)
      .post('/api/openchamber-agent/messenger/agent/create-project')
      .send({ action: 'new', label: 'New App' });

    expect(res.status).toBe(200);
    expect(res.body.ok).toBe(true);
    expect(res.body.project).toEqual(NEW_PROJECT);
    expect(res.body.discord.ok).toBe(false);
    expect(res.body.discord.error).toContain('not configured');
  });

  it('keeps the project when the Discord channel creation fails', async () => {
    const bootstrapProject = vi.fn(async () => ({ ok: true, project: NEW_PROJECT }));
    const autoCreateProjectChannel = vi.fn(async () => [
      { type: 'discord', ok: false, error: 'Discord: 403 — Bot has no access' },
    ]);
    const app = createApp({
      readSettings: async () => makeSettings(),
      bootstrapProject,
      autoCreateProjectChannel,
    });

    const res = await request(app)
      .post('/api/openchamber-agent/messenger/agent/create-project')
      .send({ action: 'new', label: 'New App' });

    expect(res.status).toBe(200);
    expect(res.body.ok).toBe(true);
    expect(res.body.project).toEqual(NEW_PROJECT);
    expect(res.body.discord.ok).toBe(false);
    expect(res.body.discord.error).toContain('403');
  });

  it('propagates bootstrap failure without touching Discord', async () => {
    const bootstrapProject = vi.fn(async () => ({ ok: false, error: 'path already exists and is non-empty: /x' }));
    const autoCreateProjectChannel = vi.fn();
    const app = createApp({
      readSettings: async () => makeSettings(),
      bootstrapProject,
      autoCreateProjectChannel,
    });

    const res = await request(app)
      .post('/api/openchamber-agent/messenger/agent/create-project')
      .send({ action: 'path', path: '/x' });

    expect(res.status).toBe(200);
    expect(res.body.ok).toBe(false);
    expect(res.body.error).toContain('already exists');
    expect(autoCreateProjectChannel).not.toHaveBeenCalled();
  });

  it('GET /help documents the create-project endpoint', async () => {
    const app = createApp({ readSettings: async () => makeSettings() });
    const res = await request(app).get('/api/openchamber-agent/messenger/agent/help');
    expect(res.status).toBe(200);
    expect(res.body.endpoints).toHaveProperty('POST /agent/create-project');
    expect(res.body.endpoints).toHaveProperty('POST /agent/read-session');
  });

  it('POST /read-session returns a transcript for a resolved session', async () => {
    const bridge = makeBridge([
      {
        sessionId: 'ses_a',
        targetKey: SESSION_THREAD,
        projectPath: '/home/me/my-app',
        projectLabel: 'My App',
      },
    ]);
    const opencodeFetch = vi.fn(async (path) => {
      if (path.startsWith('/session/ses_a/message')) {
        return {
          ok: true,
          json: async () => [
            { info: { role: 'user', time: { created: 1 } }, parts: [{ type: 'text', text: 'Hello' }] },
          ],
        };
      }
      if (path.startsWith('/session/ses_a')) {
        return {
          ok: true,
          json: async () => ({ id: 'ses_a', title: 'Alpha', directory: '/home/me/my-app' }),
        };
      }
      return { ok: false, json: async () => null };
    });
    const app = createApp({
      readSettings: async () => makeSettings(),
      bridge,
      listProjects: async () => [{ path: '/home/me/my-app' }],
      opencodeFetch,
    });

    const res = await request(app)
      .post('/api/openchamber-agent/messenger/agent/read-session')
      .send({ reference: 'ses_a' });

    expect(res.status).toBe(200);
    expect(res.body.ok).toBe(true);
    expect(res.body.messageCount).toBe(1);
    expect(res.body.transcript).toContain('Hello');
  });

  it('GET /session-reference/:sessionId returns a copyable reference', async () => {
    const bridge = makeBridge([
      {
        sessionId: 'ses_a',
        targetKey: SESSION_THREAD,
        projectPath: '/home/me/my-app',
        projectLabel: 'My App',
      },
    ]);
    const opencodeFetch = vi.fn(async (path) => {
      if (path.startsWith('/session/ses_a')) {
        return {
          ok: true,
          json: async () => ({ id: 'ses_a', title: 'Alpha', directory: '/home/me/my-app' }),
        };
      }
      return { ok: false, json: async () => null };
    });
    const app = createApp({
      readSettings: async () => makeSettings(),
      bridge,
      listProjects: async () => [{ path: '/home/me/my-app' }],
      opencodeFetch,
    });

    const res = await request(app).get('/api/openchamber-agent/messenger/agent/session-reference/ses_a');
    expect(res.status).toBe(200);
    expect(res.body.reference).toContain(SESSION_THREAD);
    expect(res.body.sessionId).toBe('ses_a');
  });
});
