import WebSocket from 'ws';
import { z } from 'zod';
import { createProviderHttp } from './services/http.js';
import { createCredentialResolver } from './services/credentials.js';
import { BotServiceError, parse, providerResult, revision, snowflake } from './services/contracts.js';

const channelSchema = z.object({ guildId: snowflake, channelId: snowflake }).strict();
const configSchema = z.object({
  identityId: z.string().min(1), identityRevision: revision,
  channels: z.array(channelSchema).max(100), people: z.array(snowflake).max(500),
}).strict();
const messageSchema = z.object({ id: snowflake, channel_id: snowflake, guild_id: snowflake.optional(),
  author: z.object({ id: snowflake, bot: z.boolean().optional() }), content: z.string().max(60_000),
  mentions: z.array(z.object({ id: snowflake })).max(100),
  message_reference: z.object({ message_id: snowflake.optional() }).optional(),
});
const frameSchema = z.object({ op: z.number().int(), s: z.number().int().nonnegative().nullable().optional(),
  t: z.string().nullable().optional(), d: z.unknown() });
const gatewayUrl = (value) => {
  let url;
  try { url = new URL(value); } catch { throw new BotServiceError('BOT_DISCORD_GATEWAY_INVALID', 'The Discord Gateway URL is invalid.'); }
  if (url.protocol !== 'wss:' || url.username || url.password || url.port || url.hash
    || !/^(?:gateway(?:-[a-z0-9-]+)?|[a-z0-9-]+\.gateway)\.discord\.gg$/.test(url.hostname)
    || url.pathname !== '/' || [...url.searchParams.keys()].some((key) => !['v', 'encoding'].includes(key))) {
    throw new BotServiceError('BOT_DISCORD_GATEWAY_INVALID', 'The Discord Gateway URL is invalid.');
  }
  url.search = '?v=10&encoding=json';
  return url.href;
};

// Messages in servers and direct messages. The server intent is left out: it
// makes Discord send every channel and role of a server in one frame, which
// this owner never reads and which exceeds the frame limit on a real server.
const MESSAGE_INTENTS = 512 | 4096;
const SOCKET_OPTIONS = { followRedirects: false, maxPayload: 128 * 1024, handshakeTimeout: 15_000 };
// A session that ends sooner keeps the reconnect delay growing. Discord allows
// 1,000 session starts a day and resets the bot token beyond that.
const STABLE_SESSION_MS = 60_000;

/** No inbound listener. Event acknowledgements follow durable engine admission. */
export function createBotDiscordGateway({ identities, identityId, identityRevision, channels = [], people = [],
  eventStore, deliver, onError, fetchImpl, policyOptions,
  createSocket = (url, options) => new WebSocket(url, options),
  random = Math.random, now = Date.now,
}) {
  const config = parse(configSchema, { identityId, identityRevision, channels, people });
  const scope = { provider: 'discord', identityId, identityRevision, channels: config.channels, people: config.people };
  const resolve = createCredentialResolver({ identities, http: createProviderHttp({ fetchImpl, policyOptions }) });
  let socket = null;
  let heartbeat = null;
  let reconnectTimer = null;
  let stopped = true;
  let fatal = false;
  let failures = 0;
  let establishedAt = null;
  let awaitingHeartbeat = false;
  let cursor = null;
  let botUserId = null;
  let token = null;
  let processing = Promise.resolve();
  let queued = 0;
  let generation = 0;
  const report = (error) => onError?.(error instanceof BotServiceError ? error
    : new BotServiceError('BOT_DISCORD_GATEWAY_FAILED', 'Discord event delivery stopped.'));
  const clearHeartbeat = () => { clearTimeout(heartbeat); heartbeat = null; awaitingHeartbeat = false; };
  const send = (frame) => {
    if (socket?.readyState === WebSocket.OPEN) socket.send(JSON.stringify(frame));
  };
  const ping = () => {
    if (awaitingHeartbeat) { socket?.terminate(); return; }
    awaitingHeartbeat = true;
    send({ op: 1, d: cursor?.sequence ?? null });
  };
  const saveCursor = async (next, events = []) => {
    await eventStore.record(scope, { expectedCursor: cursor, cursor: next, events });
    cursor = next;
    await eventStore.drain(scope, deliver);
  };
  const handle = async (frame) => {
    const receiving = socket;
    if (frame.op === 10) {
      const hello = providerResult(z.object({ heartbeat_interval: z.number().int().min(100).max(120_000) }), frame.d);
      clearHeartbeat();
      const tick = () => {
        ping();
        heartbeat = setTimeout(tick, hello.heartbeat_interval);
        heartbeat.unref?.();
      };
      heartbeat = setTimeout(tick, Math.floor(random() * hello.heartbeat_interval));
      heartbeat.unref?.();
      send(cursor ? { op: 6, d: { token, session_id: cursor.sessionId, seq: cursor.sequence } }
        : { op: 2, d: { token, intents: MESSAGE_INTENTS,
          properties: { os: process.platform, browser: 'OpenChamber', device: 'OpenChamber' } } });
      return;
    }
    if (frame.op === 11) { awaitingHeartbeat = false; return; }
    if (frame.op === 1) { awaitingHeartbeat = false; ping(); return; }
    if (frame.op === 7) { socket?.terminate(); return; }
    if (frame.op === 9) {
      if (frame.d !== true) await saveCursor(null);
      socket?.terminate();
      return;
    }
    if (frame.op !== 0 || frame.s == null) return;
    if (frame.t === 'READY') {
      const ready = providerResult(z.object({ session_id: z.string().min(1).max(512), resume_gateway_url: z.string(),
        user: z.object({ id: snowflake, bot: z.literal(true) }), application: z.object({ id: snowflake }) }), frame.d);
      const identity = await identities.resolve(identityId, identityRevision);
      if (ready.user.id !== botUserId || ready.application.id !== identity.definition.applicationId) {
        fatal = true;
        throw new BotServiceError('BOT_SERVICE_AUTH_REQUIRED', 'Discord identified a different bot application.');
      }
      await saveCursor({ sessionId: ready.session_id, sequence: frame.s, resumeUrl: gatewayUrl(ready.resume_gateway_url) });
      // The socket may have closed during the save; that session never became stable.
      if (socket === receiving) establishedAt = now();
      return;
    }
    if (!cursor || frame.s <= cursor.sequence) return;
    const next = { ...cursor, sequence: frame.s };
    const events = [];
    if (frame.t === 'MESSAGE_CREATE') {
      const message = providerResult(messageSchema, frame.d);
      const channelMention = message.guild_id && config.channels.some((channel) => channel.guildId === message.guild_id
        && channel.channelId === message.channel_id) && message.mentions.some((person) => person.id === botUserId);
      const directMessage = !message.guild_id && config.people.includes(message.author.id);
      if (!message.author.bot && message.author.id !== botUserId && (channelMention || directMessage)) {
        const event = { id: `discord:${message.id}`, provider: 'discord', identityId,
          authorId: message.author.id, body: message.content, channelId: message.channel_id,
          guildId: message.guild_id ?? 'dm',
        };
        if (message.message_reference?.message_id) event.threadId = message.message_reference.message_id;
        events.push(event);
      }
    }
    await saveCursor(next, events);
    if (frame.t === 'RESUMED' && socket === receiving) establishedAt = now();
  };
  const scheduleReconnect = () => {
    if (stopped || fatal || reconnectTimer) return;
    const delay = Math.min(60_000, 1_000 * 2 ** Math.min(failures++, 6)) + Math.floor(random() * 500);
    reconnectTimer = setTimeout(() => {
      reconnectTimer = null;
      connect().catch((error) => {
        if (['BOT_SERVICE_AUTH_REQUIRED', 'BOT_IDENTITY_UNAVAILABLE'].includes(error.code)) fatal = true;
        report(error); scheduleReconnect();
      });
    }, delay);
    reconnectTimer.unref?.();
  };
  const connect = async () => {
    const localGeneration = ++generation;
    await eventStore.drain(scope, deliver);
    const credential = await resolve({ identityId, identityRevision, service: 'discord', target: { guildId: 'dm', channelId: '000000' } });
    const gateway = providerResult(z.object({ url: z.string(), session_start_limit: z.object({ remaining: z.number().int().nonnegative() }) }),
      await credential.request({ path: '/api/v10/gateway/bot' }));
    const saved = await eventStore.read(scope);
    if (saved.cursor !== null && (!saved.cursor.sessionId || !Number.isSafeInteger(saved.cursor.sequence))) {
      throw new BotServiceError('BOT_EVENT_CURSOR_INVALID', 'The Discord resume cursor is invalid.');
    }
    if (!saved.cursor && gateway.session_start_limit.remaining === 0) {
      fatal = true;
      throw new BotServiceError('BOT_DISCORD_SESSION_LIMIT', 'Discord session starts are exhausted. Wait for its reset before reconnecting.');
    }
    if (stopped || localGeneration !== generation) return;
    cursor = saved.cursor;
    token = credential.definition.botToken;
    botUserId = credential.authority.providerAccountId;
    const current = createSocket(gatewayUrl(cursor?.resumeUrl ?? gateway.url), SOCKET_OPTIONS);
    socket = current;
    current.on('message', (data) => {
      if (stopped || current !== socket) return;
      // A slow durable delivery must not delay heartbeat acknowledgements.
      let frame;
      try { frame = providerResult(frameSchema, JSON.parse(String(data))); }
      catch (error) { fatal = true; report(error); current.terminate(); return; }
      if (frame.op === 11) { awaitingHeartbeat = false; return; }
      if (frame.op === 1) { awaitingHeartbeat = false; ping(); return; }
      if (++queued > 128) { queued -= 1; current.terminate(); return; }
      processing = processing.then(async () => {
        if (stopped || current !== socket) return;
        await handle(frame);
      }).catch((error) => {
        report(error);
        if (error.state === 'needs-you' && !['BOT_SERVICE_UNAVAILABLE', 'BOT_DISCORD_GATEWAY_FAILED'].includes(error.code)) fatal = true;
        current.terminate();
      }).finally(() => { queued -= 1; });
    });
    current.on('error', (error) => {
      // Reconnecting would receive the same frame again and spend a session start each time.
      if (error?.code === 'WS_ERR_UNSUPPORTED_MESSAGE_LENGTH' && current === socket) {
        fatal = true;
        report(new BotServiceError('BOT_DISCORD_FRAME_TOO_LARGE', 'Discord sent a frame larger than the bot accepts.', 'needs-you'));
        // Resuming this session after a restart would replay the same frame.
        processing = processing.then(() => saveCursor(null)).catch(() => {});
      }
      current.terminate();
    });
    current.on('close', (code) => {
      if (current !== socket) return;
      clearHeartbeat();
      socket = null;
      token = null;
      if (establishedAt !== null && now() - establishedAt >= STABLE_SESSION_MS) failures = 0;
      establishedAt = null;
      if ([4004, 4010, 4011, 4012, 4013, 4014].includes(code)) {
        fatal = true;
        report(new BotServiceError('BOT_SERVICE_AUTH_REQUIRED', 'Reconnect or authorize the Discord bot application.'));
      }
      // Discord cannot resume invalid sequence or expired sessions.
      processing = processing.then(async () => {
        if ([1000, 1001, 4007, 4009].includes(code)) await saveCursor(null);
        scheduleReconnect();
      }).catch((error) => { fatal = true; report(error); });
    });
  };
  return Object.freeze({
    /** True once the owner gave up and will not reconnect by itself. */
    halted: () => !stopped && fatal,
    async start() {
      if (!stopped) return;
      stopped = false;
      fatal = false;
      try { await connect(); }
      catch (error) {
        if (error.state === 'needs-you') fatal = true;
        report(error);
        if (!fatal) scheduleReconnect();
        throw error;
      }
    },
    async stop() {
      stopped = true;
      generation += 1;
      clearTimeout(reconnectTimer); reconnectTimer = null;
      clearHeartbeat();
      const current = socket;
      socket = null;
      current?.terminate();
      await processing;
      token = null;
    },
  });
}
