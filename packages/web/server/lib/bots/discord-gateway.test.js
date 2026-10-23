import fs from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import { WebSocket, WebSocketServer } from 'ws';
import { afterEach, expect, it } from 'vitest';
import { createBotIdentityStore } from './identities.js';
import { createBotProviderEventStore } from './provider-events.js';
import { createBotDiscordGateway } from './discord-gateway.js';
import { controlledUpstream, disconnectedPolicy } from './services/http.test-support.js';

const cleanups = [];
afterEach(async () => { for (const cleanup of cleanups.splice(0).reverse()) await cleanup(); });
const deferred = () => {
  let resolve;
  const promise = new Promise((done) => { resolve = done; });
  return { promise, resolve };
};
const send = (socket, op, d, t = null, s = null) => socket.send(JSON.stringify({ op, d, t, s }));
const ready = (socket) => send(socket, 0, { session_id: 'session-one', resume_gateway_url: 'wss://gateway-us-east1-b.discord.gg/',
  user: { id: '87654321', bot: true }, application: { id: '12345678' },
}, 'READY', 1);
const message = (id, overrides = {}) => ({ id, channel_id: '22222222', guild_id: '11111111',
  author: { id: '44444444', bot: false }, content: 'A question for the bot', mentions: [{ id: '87654321' }], ...overrides,
});
const setup = async ({ connection, deliver, onError }) => {
  const dataDir = await fs.mkdtemp(path.join(os.tmpdir(), 'bot-gateway-test-'));
  cleanups.push(() => fs.rm(dataDir, { recursive: true, force: true }));
  const upstream = await controlledUpstream((request) => ({ body: request.path.endsWith('/oauth2/applications/@me')
    ? { id: '12345678', bot: { id: '87654321', bot: true } }
    : { url: 'wss://gateway.discord.gg/', session_start_limit: { remaining: 100 } } }));
  cleanups.push(() => upstream.close());
  const server = new WebSocketServer({ host: '127.0.0.1', port: 0 });
  await new Promise((resolve) => server.once('listening', resolve));
  cleanups.push(() => new Promise((resolve) => { for (const client of server.clients) client.terminate(); server.close(resolve); }));
  const urls = [];
  const clientMessages = [];
  server.on('connection', (socket) => {
    socket.on('message', (raw) => { clientMessages.push(JSON.parse(String(raw))); });
    connection(socket, clientMessages);
  });
  const identities = createBotIdentityStore({ dataDir });
  const identity = await identities.create({ kind: 'discord-app', label: 'App', applicationId: '12345678', botToken: 'private-bot-token' });
  const eventStore = createBotProviderEventStore({ dataDir });
  const gateway = createBotDiscordGateway({ identities, identityId: identity.id, identityRevision: 1,
    channels: [{ guildId: '11111111', channelId: '22222222' }], people: ['44444444'],
    eventStore, deliver, onError, fetchImpl: upstream.fetchImpl, policyOptions: disconnectedPolicy, random: () => 0,
    createSocket: (url) => { urls.push(url); return new WebSocket(`ws://127.0.0.1:${server.address().port}`); },
  });
  cleanups.push(() => gateway.stop());
  return { gateway, clientMessages, urls, dataDir, identity };
};

it('accepts only configured channel mentions and known-person DMs, durably deduplicating Gateway replays', async () => {
  const done = deferred();
  const events = [];
  const errors = [];
  const h = await setup({ onError: (error) => errors.push(error), deliver: async (event) => {
    events.push(event); if (events.length === 3) done.resolve();
  }, connection: (socket) => {
    send(socket, 10, { heartbeat_interval: 30_000 });
    socket.on('message', (raw) => {
      const frame = JSON.parse(String(raw));
      if (frame.op === 1) send(socket, 11, null);
      if (frame.op !== 2) return;
      ready(socket);
      send(socket, 0, message('10000001', { mentions: [] }), 'MESSAGE_CREATE', 2);
      send(socket, 0, message('10000002', { guild_id: '99999999' }), 'MESSAGE_CREATE', 3);
      send(socket, 0, message('10000003'), 'MESSAGE_CREATE', 4);
      send(socket, 0, message('10000004', { guild_id: undefined, author: { id: '99999999' } }), 'MESSAGE_CREATE', 5);
      send(socket, 0, message('10000005', { guild_id: undefined }), 'MESSAGE_CREATE', 6);
      send(socket, 0, message('10000006', { author: { id: '87654321', bot: true } }), 'MESSAGE_CREATE', 7);
      send(socket, 0, message('10000003'), 'MESSAGE_CREATE', 8);
      send(socket, 0, message('10000007'), 'MESSAGE_CREATE', 9);
    });
  } });
  await h.gateway.start();
  await done.promise;
  await h.gateway.stop();
  expect(errors).toEqual([]);
  expect(events.map((event) => event.id)).toEqual(['discord:10000003', 'discord:10000005', 'discord:10000007']);
  expect(events[1].guildId).toBe('dm');
  expect(h.clientMessages.find((frame) => frame.op === 2).d.intents).toBe(1 | 512 | 4096);
  const stored = JSON.parse(await fs.readFile(path.join(h.dataDir, 'bot-provider-events.json'), 'utf8'));
  expect(Object.values(stored.streams)[0].cursor.sequence).toBe(9);
  expect(JSON.stringify(stored)).not.toContain('private-bot-token');
});

it('resumes from the saved sequence and provider resume origin after an outbound reconnect', async () => {
  const done = deferred();
  const events = [];
  const errors = [];
  let connections = 0;
  const h = await setup({ onError: (error) => errors.push(error), deliver: async (event) => {
    events.push(event); if (events.length === 2) done.resolve();
  }, connection: (socket) => {
    connections += 1;
    send(socket, 10, { heartbeat_interval: 30_000 });
    socket.on('message', (raw) => {
      const frame = JSON.parse(String(raw));
      if (frame.op === 1) send(socket, 11, null);
      if (frame.op === 2) {
        ready(socket);
        send(socket, 0, message('10000001'), 'MESSAGE_CREATE', 2);
        // Reconnect follows an event that must be saved before Resume.
        send(socket, 7, null);
      }
      if (frame.op === 6) {
        expect(frame.d).toMatchObject({ session_id: 'session-one', seq: 2 });
        send(socket, 0, {}, 'RESUMED', 3);
        send(socket, 0, message('10000001'), 'MESSAGE_CREATE', 4);
        send(socket, 0, message('10000002'), 'MESSAGE_CREATE', 5);
      }
    });
  } });
  await h.gateway.start();
  await done.promise;
  await h.gateway.stop();
  expect(errors).toEqual([]);
  expect(connections).toBe(2);
  expect(h.urls[1]).toBe('wss://gateway-us-east1-b.discord.gg/?v=10&encoding=json');
  expect(events.map((event) => event.id)).toEqual(['discord:10000001', 'discord:10000002']);
});

it('reports expired bot authorization as needs-you and sends no further Identify', async () => {
  const failed = deferred();
  const h = await setup({ deliver: async () => { throw new Error('must not deliver'); }, onError: failed.resolve,
    connection: (socket) => {
      send(socket, 10, { heartbeat_interval: 30_000 });
      socket.on('message', (raw) => { if (JSON.parse(String(raw)).op === 2) socket.close(4004, 'Invalid token'); });
    },
  });
  await h.gateway.start();
  const error = await failed.promise;
  expect(error).toMatchObject({ code: 'BOT_SERVICE_AUTH_REQUIRED', state: 'needs-you' });
  await h.gateway.stop();
  expect(h.clientMessages.filter((frame) => frame.op === 2)).toHaveLength(1);
});
