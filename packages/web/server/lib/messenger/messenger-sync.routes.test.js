import { describe, expect, it, vi, afterEach } from 'vitest';
import express from 'express';
import request from 'supertest';

import { createMessengerSyncRouter } from './messenger-sync.js';

// These tests lock in the "connected but this browser has no token" fix:
// a second device / cleared storage sends no token, and the routes must fall
// back to the saved settings.json token instead of 400-ing. They also cover
// the per-server "Send test" path where /send resolves a channel from guildId.

const SETTINGS_TOKEN = 'settings-bot-token';
const GUILD = '111111111111111111';
const CHANNEL = '222222222222222222';

function createApp({ readSettings } = {}) {
  const app = express();
  const { router } = createMessengerSyncRouter({ readSettings });
  // The router mounts its own express.json() parser, matching production.
  app.use('/api/messenger', router);
  return app;
}

function jsonResponse(data, { ok = true, status = 200 } = {}) {
  return {
    ok,
    status,
    json: async () => data,
    text: async () => (typeof data === 'string' ? data : JSON.stringify(data)),
  };
}

let fetchCalls = [];
let originalFetch;
function stubFetch(handler) {
  fetchCalls = [];
  originalFetch = globalThis.fetch;
  globalThis.fetch = vi.fn(async (url, init = {}) => {
    fetchCalls.push({ url: String(url), init });
    return handler(String(url), init);
  });
}

afterEach(() => {
  if (originalFetch) globalThis.fetch = originalFetch;
  originalFetch = undefined;
  vi.restoreAllMocks();
});

describe('messenger /send token fallback + guild resolution', () => {
  it('falls back to the saved settings token when the body omits it', async () => {
    const readSettings = vi.fn(async () => ({ discord: { botToken: SETTINGS_TOKEN } }));
    stubFetch((url) => {
      if (url.includes(`/channels/${CHANNEL}/messages`)) return jsonResponse({ id: 'msg-1' });
      throw new Error(`unexpected url ${url}`);
    });

    const res = await request(createApp({ readSettings }))
      .post('/api/messenger/send')
      .send({ type: 'discord', target: CHANNEL, text: 'hi' });

    expect(res.status).toBe(200);
    expect(res.body.ok).toBe(true);
    const sendCall = fetchCalls.find((c) => c.url.includes('/messages'));
    expect(sendCall.init.headers.Authorization).toBe(`Bot ${SETTINGS_TOKEN}`);
  });

  it('resolves the first text channel from guildId when no target is given', async () => {
    const readSettings = vi.fn(async () => ({ discord: { botToken: SETTINGS_TOKEN } }));
    stubFetch((url) => {
      if (url.includes(`/guilds/${GUILD}/channels`)) {
        return jsonResponse([
          { id: 'category', type: 4, position: 0 },
          { id: CHANNEL, type: 0, position: 1 },
          { id: 'later', type: 0, position: 2 },
        ]);
      }
      if (url.includes(`/channels/${CHANNEL}/messages`)) return jsonResponse({ id: 'msg-2' });
      throw new Error(`unexpected url ${url}`);
    });

    const res = await request(createApp({ readSettings }))
      .post('/api/messenger/send')
      .send({ type: 'discord', guildId: GUILD, text: 'hi' });

    expect(res.status).toBe(200);
    expect(res.body.ok).toBe(true);
    expect(res.body.messageId).toBe('msg-2');
    expect(fetchCalls.some((c) => c.url.includes(`/channels/${CHANNEL}/messages`))).toBe(true);
  });

  it('returns 400 when neither the body nor settings has a token', async () => {
    const readSettings = vi.fn(async () => ({ discord: {} }));
    stubFetch(() => {
      throw new Error('must not hit Discord without a token');
    });

    const res = await request(createApp({ readSettings }))
      .post('/api/messenger/send')
      .send({ type: 'discord', target: CHANNEL, text: 'hi' });

    expect(res.status).toBe(400);
  });

  it('returns 400 when a guildId resolves to no text channel', async () => {
    const readSettings = vi.fn(async () => ({ discord: { botToken: SETTINGS_TOKEN } }));
    stubFetch((url) => {
      if (url.includes(`/guilds/${GUILD}/channels`)) return jsonResponse([]);
      throw new Error(`unexpected url ${url}`);
    });

    const res = await request(createApp({ readSettings }))
      .post('/api/messenger/send')
      .send({ type: 'discord', guildId: GUILD, text: 'hi' });

    // No channel found is surfaced as a soft error, not a delivery.
    expect(res.body.ok).toBe(false);
    expect(String(res.body.error)).toMatch(/text channel/i);
  });
});

describe('messenger /discord/sync-projects token fallback', () => {
  it('falls back to the saved settings token when the body omits it', async () => {
    const readSettings = vi.fn(async () => ({
      discord: { botToken: SETTINGS_TOKEN },
      projects: [],
    }));
    stubFetch((url) => {
      if (url.includes(`/guilds/${GUILD}/channels`)) return jsonResponse([]);
      throw new Error(`unexpected url ${url}`);
    });

    const res = await request(createApp({ readSettings }))
      .post('/api/messenger/discord/sync-projects')
      .send({ type: 'discord', guildId: GUILD, projects: [] });

    expect(res.status).toBe(200);
    expect(res.body.ok).toBe(true);
    const listCall = fetchCalls.find((c) => c.url.includes(`/guilds/${GUILD}/channels`));
    expect(listCall.init.headers.Authorization).toBe(`Bot ${SETTINGS_TOKEN}`);
  });

  it('returns 400 when neither the body nor settings has a token', async () => {
    const readSettings = vi.fn(async () => ({ discord: {} }));
    stubFetch(() => {
      throw new Error('must not hit Discord without a token');
    });

    const res = await request(createApp({ readSettings }))
      .post('/api/messenger/discord/sync-projects')
      .send({ type: 'discord', guildId: GUILD, projects: [] });

    expect(res.status).toBe(400);
  });
});
