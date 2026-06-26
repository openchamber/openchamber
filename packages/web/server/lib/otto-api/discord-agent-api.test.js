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
  return {
    store: {
      list: vi.fn(() => sessions),
    },
  };
}

function createApp({ readSettings, bridge = null, broadcastEvent = null } = {}) {
  const app = express();
  app.use(express.json());
  app.use(
    '/api/otto/messenger/agent',
    createDiscordAgentRouter({
      readSettings,
      bridge,
      broadcastEvent,
      getLocalApiBaseUrl: () => 'http://127.0.0.1:3001',
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
    const res = await request(app).get('/api/otto/messenger/agent/help');
    expect(res.status).toBe(200);
    expect(res.body.ok).toBe(true);
    expect(res.body.endpoints).toHaveProperty('POST /agent/post');
  });

  it('GET /targets returns 503 when Discord is not configured', async () => {
    const app = createApp({ readSettings: async () => ({}) });
    const res = await request(app).get('/api/otto/messenger/agent/targets');
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
    const res = await request(app).get('/api/otto/messenger/agent/targets');
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
      .post('/api/otto/messenger/agent/resolve')
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
      .post('/api/otto/messenger/agent/resolve')
      .send({ session: 'ses_abc' });
    expect(res.status).toBe(200);
    expect(res.body.target.kind).toBe('session');
    expect(res.body.target.channelId).toBe(SESSION_THREAD);
  });

  it('POST /resolve accepts a raw channel id and a discord URL', async () => {
    const app = createApp({ readSettings: async () => makeSettings() });

    const byId = await request(app)
      .post('/api/otto/messenger/agent/resolve')
      .send({ channel: PROJECT_CHANNEL });
    expect(byId.status).toBe(200);
    expect(byId.body.target.channelId).toBe(PROJECT_CHANNEL);

    const byUrl = await request(app)
      .post('/api/otto/messenger/agent/resolve')
      .send({ channel: `https://discord.com/channels/${GUILD}/${SESSION_THREAD}` });
    expect(byUrl.status).toBe(200);
    expect(byUrl.body.target.channelId).toBe(SESSION_THREAD);
    expect(byUrl.body.target.guildId).toBe(GUILD);
  });

  it('POST /resolve errors when nothing matches or nothing is provided', async () => {
    const app = createApp({ readSettings: async () => makeSettings() });

    const none = await request(app).post('/api/otto/messenger/agent/resolve').send({});
    expect(none.status).toBe(400);

    const missing = await request(app)
      .post('/api/otto/messenger/agent/resolve')
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
      .post('/api/otto/messenger/agent/post')
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
      .post('/api/otto/messenger/agent/post')
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
      .post('/api/otto/messenger/agent/post')
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
      .post('/api/otto/messenger/agent/post')
      .send({ project: 'my-app', text: 'hello' });

    expect(res.status).toBe(200);
    expect(res.body.url).toBe(
      `https://discord.com/channels/${GUILD}/${PROJECT_CHANNEL}/777`,
    );
  });
});
