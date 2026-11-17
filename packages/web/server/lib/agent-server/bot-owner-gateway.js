import { randomUUID } from 'node:crypto';
import { z } from 'zod';
import { BotServiceError } from '../bots/services/contracts.js';
import { botGatewayUrlSchema } from './bot-service-contract.js';

const fatalCodes = new Set(['BOT_IDENTITY_UNAVAILABLE', 'BOT_IDENTITY_CHANGED', 'BOT_SERVICE_AUTH_REQUIRED',
  'BOT_DISCORD_FRAME_TOO_LARGE', 'BOT_DISCORD_SESSION_LIMIT', 'BOT_DISCORD_GATEWAY_INVALID_FRAME']);

/** Owner lifecycle around the agent's credential-free Discord protocol transport. */
export function createOwnerBotGateway({ call, scope, identityId, identityRevision, channels = [], people = [],
  eventStore, deliver, onError, random = Math.random, now = Date.now }) {
  const eventScope = { provider: 'discord', identityId, identityRevision, channels, people };
  let stopped = true; let fatal = false; let running = null; let controller = null;
  let connectionId = null; let heartbeat = null; let awaitingHeartbeat = false; let cursor = null; let failures = 0;
  const clearHeartbeat = () => { clearTimeout(heartbeat); heartbeat = null; awaitingHeartbeat = false; };
  const report = (error) => onError?.(new BotServiceError(error?.code ?? 'BOT_DISCORD_GATEWAY_FAILED', 'Discord event delivery stopped.'));
  const saveCursor = async (next, events = []) => {
    await eventStore.record(eventScope, { expectedCursor: cursor, cursor: next, events });
    cursor = next;
    await eventStore.drain(eventScope, deliver);
  };
  const close = async () => {
    clearHeartbeat();
    if (!connectionId) return;
    const id = connectionId; connectionId = null;
    await call('gateway-close', { scope, connectionId: id });
  };
  const send = (frame) => {
    if (!connectionId) throw new BotServiceError('BOT_DISCORD_GATEWAY_CLOSED', 'The Discord connection closed.');
    return call('gateway-send', { scope, connectionId, frame });
  };
  const ping = async () => {
    if (awaitingHeartbeat) { await close(); return; }
    awaitingHeartbeat = true;
    await send({ kind: 'heartbeat', sequence: cursor?.sequence ?? null });
  };
  const wait = (ms, signal) => new Promise((resolve, reject) => {
    const abort = () => { clearTimeout(timer); reject(signal.reason); };
    const timer = setTimeout(() => { signal.removeEventListener('abort', abort); resolve(); }, ms);
    timer.unref?.(); signal.addEventListener('abort', abort, { once: true });
    if (signal.aborted) abort();
  });
  const connectLoop = async (started) => {
    while (!stopped && !fatal) {
      let establishedAt = null;
      let work = Promise.resolve(); let workError = null;
      try {
        await eventStore.drain(eventScope, deliver);
        cursor = (await eventStore.read(eventScope)).cursor;
        connectionId = randomUUID();
        const identity = await call('gateway-open', { scope, connectionId, identityId, identityRevision, cursor }, { signal: controller.signal });
        started.resolve();
        let after = 0; let observed = 0;
        const enqueue = (frameId, apply = async () => {}) => {
          work = work.then(async () => {
            if (workError) return;
            await apply();
            after = frameId;
          }).catch(async (error) => { workError = error; await close().catch(report); });
        };
        while (!stopped && connectionId) {
          const id = connectionId;
          const timeout = AbortSignal.timeout(20_000);
          let page;
          try { page = await call('gateway-pull', { scope, connectionId: id, after, observed }, { signal: AbortSignal.any([controller.signal, timeout]) }); }
          catch (error) { if (timeout.aborted && !stopped) continue; throw error; }
          if (connectionId !== id) break;
          for (const { id: frameId, frame } of page.frames) {
            if (stopped || connectionId !== id) break;
            if (frame.op === 10) {
              const hello = z.object({ heartbeat_interval: z.number().int().min(100).max(120_000) }).parse(frame.d);
              clearHeartbeat();
              const tick = async () => {
                try { await ping(); }
                catch (error) { report(error); await close(); }
                if (connectionId === id && !stopped) { heartbeat = setTimeout(tick, hello.heartbeat_interval); heartbeat.unref?.(); }
              };
              heartbeat = setTimeout(tick, Math.floor(random() * hello.heartbeat_interval)); heartbeat.unref?.();
              await send(cursor ? { kind: 'resume', sessionId: cursor.sessionId, sequence: cursor.sequence } : { kind: 'identify' });
            } else if (frame.op === 11) awaitingHeartbeat = false;
            else if (frame.op === 1) { awaitingHeartbeat = false; await ping(); }
            else if (frame.op === 7) await close();
            else if (frame.op === 9) { if (frame.d !== true) enqueue(frameId, () => saveCursor(null)); await close(); }
            if (frame.op === 0 && frame.s != null) enqueue(frameId, async () => {
              if (frame.t === 'READY') {
                const ready = frame.d;
                if (ready.user.id !== identity.botUserId || ready.application.id !== identity.applicationId) {
                  throw new BotServiceError('BOT_SERVICE_AUTH_REQUIRED', 'Discord identified a different Bot application.');
                }
                await saveCursor({ sessionId: ready.session_id, sequence: frame.s, resumeUrl: botGatewayUrlSchema.parse(ready.resume_gateway_url) });
                establishedAt = now();
              } else if (cursor && frame.s > cursor.sequence) {
                const events = [];
                if (frame.t === 'MESSAGE_CREATE') {
                  const message = frame.d;
                  const channelMention = message.guild_id && channels.some((entry) => entry.guildId === message.guild_id && entry.channelId === message.channel_id)
                    && message.mentions.some((person) => person.id === identity.botUserId);
                  const directMessage = !message.guild_id && people.includes(message.author.id);
                  if (!message.author.bot && message.author.id !== identity.botUserId && (channelMention || directMessage)) {
                    const event = { id: `discord:${message.id}`, provider: 'discord', identityId, authorId: message.author.id,
                      body: message.content, channelId: message.channel_id, guildId: message.guild_id ?? 'dm' };
                    if (message.message_reference?.message_id) event.threadId = message.message_reference.message_id;
                    events.push(event);
                  }
                }
                await saveCursor({ ...cursor, sequence: frame.s }, events);
                if (frame.t === 'RESUMED') establishedAt = now();
              }
            });
            else if (frame.op !== 9 || frame.d === true) enqueue(frameId);
            // Reading ahead keeps protocol control live. Only the ordered durable
            // worker advances acknowledgement, so the agent still bounds backlog.
            observed = frameId;
          }
          if (page.state === 'closed') clearHeartbeat();
          if (page.errorCode) throw new BotServiceError(page.errorCode, 'Discord event delivery stopped.');
          if (page.state === 'closed' && page.frames.length < 16) {
            await work;
            if (workError) throw workError;
            if ([4004, 4010, 4011, 4012, 4013, 4014].includes(page.closeCode)) throw new BotServiceError('BOT_SERVICE_AUTH_REQUIRED', 'Authorize the Discord Bot application.');
            if ([1000, 1001, 4007, 4009].includes(page.closeCode)) await saveCursor(null);
            break;
          }
        }
        await work;
        if (workError) throw workError;
      } catch (error) {
        await work;
        error = workError ?? error;
        if (!stopped) {
          if (fatalCodes.has(error.code)) fatal = true;
          if (error.code === 'BOT_DISCORD_FRAME_TOO_LARGE') await saveCursor(null);
          report(error); started.reject(error);
        }
      } finally { await close().catch(report); }
      if (stopped || fatal) break;
      if (establishedAt !== null && now() - establishedAt >= 60_000) failures = 0;
      const delay = Math.min(60_000, 1000 * 2 ** Math.min(failures++, 6)) + Math.floor(random() * 500);
      try { await wait(delay, controller.signal); } catch { break; }
    }
    started.resolve();
  };
  return {
    halted: () => !stopped && fatal,
    start() {
      if (!stopped) return Promise.resolve();
      stopped = false; fatal = false; controller = new AbortController();
      let resolve; let reject; const ready = new Promise((yes, no) => { resolve = yes; reject = no; });
      running = connectLoop({ resolve, reject }).catch((error) => { if (!stopped) report(error); });
      return ready;
    },
    async stop() {
      stopped = true; controller?.abort(); clearHeartbeat();
      await close(); await running; running = null;
    },
  };
}
