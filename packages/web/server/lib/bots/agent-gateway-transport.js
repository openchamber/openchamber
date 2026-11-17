import WebSocket from 'ws';
import { z } from 'zod';
import { createCredentialResolver } from './services/credentials.js';
import { createProviderHttp } from './services/http.js';
import { botBoundaryError, botDiscordFrameSchema, botGatewayUrlSchema, botGatewayMessageSchema, botGatewayReadySchema } from '../agent-server/bot-service-contract.js';

const identityOf = (input) => ({ projectId: input.scope.project.id, projectPath: input.scope.project.path,
  botId: input.scope.bot.id, itemId: input.scope.item.id });
const canonicalUrl = (value) => { const url = new URL(botGatewayUrlSchema.parse(value)); url.search = '?v=10&encoding=json'; return url.href; };

/** Credential-bearing protocol endpoint. Heartbeats, cursors and reconnects belong to the owner. */
export function createBotAgentGatewayTransport({ identities, fetchImpl, policyOptions, resolveCredential,
  createSocket = (url, options) => new WebSocket(url, options) }) {
  const resolve = resolveCredential ?? createCredentialResolver({ identities, http: createProviderHttp({ fetchImpl, policyOptions }) });
  const connections = new Map();
  let stopped = false;
  const fail = () => { throw botBoundaryError('BOT_DISCORD_GATEWAY_CHANGED', 409); };
  const find = (input) => {
    const connection = connections.get(input.connectionId);
    if (!connection || JSON.stringify(connection.owner) !== JSON.stringify(identityOf(input))) fail();
    return connection;
  };
  const notify = (connection) => { for (const wake of connection.waiters) wake(); connection.waiters.clear(); };
  const open = async (input, { signal } = {}) => {
    signal?.throwIfAborted();
    if (stopped) throw botBoundaryError('BOT_EXECUTION_STOPPED', 503);
    if (input.scope.bot.identity.discord?.identityId !== input.identityId) fail();
    if (connections.has(input.connectionId)) {
      const existing = find(input);
      if (existing.identityId !== input.identityId || existing.identityRevision !== input.identityRevision) fail();
      return { connectionId: input.connectionId, botUserId: existing.botUserId, applicationId: existing.applicationId };
    }
    if (connections.size >= 100) throw botBoundaryError('BOT_DISCORD_GATEWAY_LIMIT', 409);
    const credential = await resolve({ identityId: input.identityId, identityRevision: input.identityRevision,
      service: 'discord', target: { guildId: 'dm', channelId: '000000' } });
    const gateway = z.object({ url: botGatewayUrlSchema, session_start_limit: z.object({ remaining: z.number().int().nonnegative() }) })
      .parse(await credential.request({ path: '/api/v10/gateway/bot' }));
    if (!input.cursor && gateway.session_start_limit.remaining === 0) throw botBoundaryError('BOT_DISCORD_SESSION_LIMIT', 409);
    signal?.throwIfAborted();
    if (stopped) throw botBoundaryError('BOT_EXECUTION_STOPPED', 503);
    // Resolve races at the effect boundary before allocating a second socket.
    if (connections.has(input.connectionId)) return open(input, { signal });
    const socket = createSocket(canonicalUrl(input.cursor?.resumeUrl ?? gateway.url),
      { followRedirects: false, maxPayload: 128 * 1024, handshakeTimeout: 15_000 });
    const connection = { owner: identityOf(input), identityId: input.identityId, identityRevision: input.identityRevision, credential,
      botUserId: credential.authority.providerAccountId, applicationId: credential.definition.applicationId,
      socket, state: 'connecting', frames: [], sequence: 0, acknowledged: 0, closeCode: null, waiters: new Set() };
    connections.set(input.connectionId, connection);
    socket.on('open', () => { connection.state = 'open'; notify(connection); });
    socket.on('message', (bytes) => {
      try {
        if (Buffer.byteLength(bytes) > 128 * 1024) throw botBoundaryError('BOT_DISCORD_FRAME_TOO_LARGE');
        const raw = JSON.parse(String(bytes));
        // Unused dispatch snapshots retain their sequence only. READY and user
        // messages have explicit credential-free field projections.
        const data = raw.op === 0 ? raw.t === 'READY' ? botGatewayReadySchema.parse(raw.d)
          : raw.t === 'MESSAGE_CREATE' ? botGatewayMessageSchema.parse(raw.d) : null : raw.d;
        const frame = botDiscordFrameSchema.parse({ op: raw.op, s: raw.s, t: raw.t, d: data });
        if (connection.frames.length >= 128) throw botBoundaryError('BOT_DISCORD_GATEWAY_BACKLOG_LIMIT');
        connection.frames.push({ id: ++connection.sequence, frame }); notify(connection);
      } catch (error) {
        connection.errorCode = error.code === 'BOT_DISCORD_FRAME_TOO_LARGE' ? error.code : 'BOT_DISCORD_GATEWAY_INVALID_FRAME';
        socket.terminate(); notify(connection);
      }
    });
    socket.on('error', (error) => {
      connection.errorCode = error.code === 'WS_ERR_UNSUPPORTED_MESSAGE_LENGTH' ? 'BOT_DISCORD_FRAME_TOO_LARGE' : 'BOT_DISCORD_GATEWAY_FAILED';
      socket.terminate(); notify(connection);
    });
    socket.on('close', (code) => { connection.state = 'closed'; connection.closeCode = code; notify(connection); });
    return { connectionId: input.connectionId, botUserId: connection.botUserId, applicationId: connection.applicationId };
  };
  const pull = async (input, { signal } = {}) => {
    const connection = find(input);
    const observed = input.observed ?? input.after;
    if (input.after < connection.acknowledged || observed < input.after || observed > connection.sequence) fail();
    connection.acknowledged = input.after;
    connection.frames = connection.frames.filter((entry) => entry.id > input.after);
    if (!connection.frames.some((entry) => entry.id > observed) && connection.state !== 'closed') {
      await new Promise((resolve, reject) => {
        const wake = () => { signal?.removeEventListener('abort', abort); connection.waiters.delete(wake); resolve(); };
        const abort = () => { connection.waiters.delete(wake); reject(signal.reason); };
        connection.waiters.add(wake); signal?.addEventListener('abort', abort, { once: true });
        if (signal?.aborted) abort();
      });
    }
    const result = { connectionId: input.connectionId, frames: connection.frames.filter((entry) => entry.id > observed).slice(0, 16), state: connection.state,
      closeCode: connection.closeCode };
    if (connection.errorCode) result.errorCode = connection.errorCode;
    return result;
  };
  const send = async (input) => {
    const connection = find(input);
    await connection.credential.assertCurrent();
    if (connection.state !== 'open') throw botBoundaryError('BOT_DISCORD_GATEWAY_CLOSED', 409);
    const token = connection.credential.definition.botToken;
    const { frame } = input;
    const value = frame.kind === 'heartbeat' ? { op: 1, d: frame.sequence }
      : frame.kind === 'resume' ? { op: 6, d: { token, session_id: frame.sessionId, seq: frame.sequence } }
        : { op: 2, d: { token, intents: 512 | 4096, properties: { os: process.platform, browser: 'OpenChamber', device: 'OpenChamber' } } };
    await new Promise((resolveSend, reject) => connection.socket.send(JSON.stringify(value), (error) => error ? reject(error) : resolveSend()));
    return { ok: true };
  };
  const close = (input) => {
    if (!connections.has(input.connectionId)) return { ok: true };
    const connection = find(input); connections.delete(input.connectionId);
    connection.state = 'closed'; connection.socket.terminate(); notify(connection);
    return { ok: true };
  };
  return { open, pull, send, close, stop() { stopped = true; for (const [connectionId, connection] of connections) close({ connectionId,
    scope: { project: { id: connection.owner.projectId, path: connection.owner.projectPath }, bot: { id: connection.owner.botId }, item: { id: connection.owner.itemId } } }); } };
}
