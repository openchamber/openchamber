import { EventEmitter } from 'node:events';
import { afterEach, expect, test, vi } from 'vitest';
import { createOwnerBotGateway } from './bot-owner-gateway.js';
import { BOT_SERVICE_OPERATIONS } from './bot-service-contract.js';
import { createBotAgentGatewayTransport } from '../bots/agent-gateway-transport.js';

const cleanups = [];
afterEach(async () => {
  for (const cleanup of cleanups.splice(0).reverse()) await cleanup();
  vi.useRealTimers();
});
const settle = async () => { for (let i = 0; i < 100; i++) await Promise.resolve(); };
const deferred = () => { let resolve; const promise = new Promise((done) => { resolve = done; }); return { promise, resolve }; };

function fixture({ holdAdmission = false } = {}) {
  const scope = { project: { id: 'project', path: '/disposable/project' },
    bot: { id: 'bot', name: 'Bot', mission: 'Fix bugs', identity: { discord: { identityId: 'discord' } } },
    item: { id: 'item', botId: 'bot', source: { kind: 'manual', id: 'item' } } };
  const sockets = []; const calls = []; const errors = []; const records = []; const delivered = [];
  const held = deferred(); let cursor = null; const pending = [];
  const transport = createBotAgentGatewayTransport({ resolveCredential: async () => ({
    authority: { providerAccountId: '123456' }, definition: { applicationId: '234567', botToken: 'disposable' },
    assertCurrent: async () => {}, request: async () => ({ url: 'wss://gateway.discord.gg/', session_start_limit: { remaining: 10 } }),
  }), createSocket: () => {
    const socket = new EventEmitter(); socket.sent = [];
    socket.terminate = vi.fn(() => socket.emit('close', 1006));
    socket.send = (value, done) => {
      const frame = JSON.parse(value); socket.sent.push(frame);
      if (frame.op === 1) emit(socket, { op: 11, d: null });
      done();
    };
    sockets.push(socket); return socket;
  } });
  const call = async (operation, input, options) => {
    calls.push({ operation, input });
    const contract = BOT_SERVICE_OPERATIONS[operation];
    const result = await transport[operation.slice('gateway-'.length)](contract.input.parse(input), options);
    return contract.reply.parse(result);
  };
  const eventStore = { read: async () => ({ cursor }), record: async (_scope, page) => {
      if (holdAdmission && page.events.length) await held.promise;
      expect(page.expectedCursor).toEqual(cursor); records.push(page); cursor = page.cursor; pending.push(...page.events);
    }, drain: async (_scope, deliver) => {
      while (pending.length) { await deliver(pending[0]); pending.shift(); }
    } };
  const deliver = vi.fn(async (event) => { await held.promise; delivered.push(event.id); });
  const gateway = createOwnerBotGateway({ call, scope, identityId: 'discord', identityRevision: 1,
    people: ['678901'], random: () => 1, onError: (error) => errors.push(error.code), eventStore, deliver });
  cleanups.push(async () => { held.resolve(); await gateway.stop(); transport.stop(); });
  return { gateway, transport, sockets, calls, errors, records, delivered, held, scope, deliver };
}
const emit = (socket, frame) => socket.emit('message', Buffer.from(JSON.stringify(frame)));
const hello = (socket) => {
  socket.emit('open');
  emit(socket, { op: 10, d: { heartbeat_interval: 100 } });
};
const ready = (socket) => {
  hello(socket);
  emit(socket, { op: 0, s: 1, t: 'READY', d: { session_id: 'ready', resume_gateway_url: 'wss://gateway.discord.gg/',
    user: { id: '123456', bot: true }, application: { id: '234567' } } });
};
const message = (socket, sequence) => emit(socket, { op: 0, s: sequence, t: 'MESSAGE_CREATE', d: {
  id: String(345678 + sequence), channel_id: '456789', author: { id: '678901', bot: false }, content: 'Help', mentions: [],
} });

test.each([false, true])('held durable work across heartbeat intervals still observes ACKs without acknowledging pending messages, admission=%s', async (holdAdmission) => {
  vi.useFakeTimers(); const f = fixture({ holdAdmission }); await f.gateway.start(); const socket = f.sockets[0];
  ready(socket); message(socket, 2); message(socket, 3); await settle();
  expect(f.records.map((entry) => entry.cursor.sequence)).toEqual(holdAdmission ? [1] : [1, 2]);
  await vi.advanceTimersByTimeAsync(300);
  expect(socket.terminate).not.toHaveBeenCalled();
  expect(socket.sent.filter((frame) => frame.op === 1)).toHaveLength(3);
  expect(f.delivered).toEqual([]);
  expect(f.calls.filter((entry) => entry.operation === 'gateway-pull').every((entry) => entry.input.after < 3)).toBe(true);
  f.held.resolve(); await settle();
  expect(f.delivered).toEqual(['discord:345680', 'discord:345681']);
  expect(f.records.map((entry) => entry.cursor.sequence)).toEqual([1, 2, 3]);
  await vi.advanceTimersByTimeAsync(100);
  expect(f.errors).toEqual([]);
  expect(f.calls.filter((entry) => entry.operation === 'gateway-pull').at(-1).input.after).toBeGreaterThanOrEqual(4);
});

test('heartbeat requests behind a held message in the same page are handled immediately', async () => {
  vi.useFakeTimers(); const f = fixture(); await f.gateway.start(); const socket = f.sockets[0];
  ready(socket); message(socket, 2); emit(socket, { op: 11, d: null }); emit(socket, { op: 1, d: null });
  await settle();
  expect(socket.sent.filter((frame) => frame.op === 1)).toHaveLength(1);
  expect(f.delivered).toEqual([]);
  await vi.advanceTimersByTimeAsync(200);
  expect(socket.terminate).not.toHaveBeenCalled();
  expect(f.errors).toEqual([]);
});

test.each(['reconnect', 'invalid-resumable', 'invalid-reset', 'close-resumable', 'close-reset'])(
  'pending messages stay ordered across %s and reconnect only after delivery', async (kind) => {
    vi.useFakeTimers(); const f = fixture(); await f.gateway.start(); const socket = f.sockets[0];
    ready(socket); await settle(); message(socket, 2); message(socket, 3); await settle();
    if (kind === 'reconnect') emit(socket, { op: 7, d: null });
    else if (kind.startsWith('invalid')) emit(socket, { op: 9, d: kind === 'invalid-resumable' });
    else socket.emit('close', kind === 'close-reset' ? 4009 : 1006);
    await settle(); await vi.advanceTimersByTimeAsync(2000);
    expect(f.sockets).toHaveLength(1);
    expect(f.delivered).toEqual([]);
    f.held.resolve(); await settle(); await vi.advanceTimersByTimeAsync(1500);
    expect(f.delivered).toEqual(['discord:345680', 'discord:345681']);
    expect(f.sockets).toHaveLength(2);
    const opened = f.calls.filter((entry) => entry.operation === 'gateway-open').at(-1).input;
    const reset = kind.endsWith('reset');
    expect(opened.cursor).toEqual(reset ? null : { sessionId: 'ready', sequence: 3, resumeUrl: 'wss://gateway.discord.gg/' });
    hello(f.sockets[1]); await settle();
    expect(f.sockets[1].sent[0].op).toBe(reset ? 2 : 6);
    expect(f.errors).toEqual([]);
  });

test('stop aborts the outstanding pull and waits for ordered pending delivery', async () => {
  vi.useFakeTimers(); const f = fixture(); await f.gateway.start(); const socket = f.sockets[0];
  ready(socket); message(socket, 2); message(socket, 3); await settle();
  let stopped = false; const stopping = f.gateway.stop().then(() => { stopped = true; });
  await settle(); expect(stopped).toBe(false);
  f.held.resolve(); await stopping;
  expect(f.delivered).toEqual(['discord:345680', 'discord:345681']);
  await vi.advanceTimersByTimeAsync(5000);
  expect(f.sockets).toHaveLength(1);
  expect(socket.sent.filter((frame) => frame.op === 1)).toHaveLength(0);
  expect(f.errors).toEqual([]);
});

test('failed delivery leaves the frame unacknowledged and drains the journal before resuming', async () => {
  vi.useFakeTimers(); const f = fixture();
  f.deliver.mockRejectedValueOnce(Object.assign(new Error('fixture failure'), { code: 'DELIVERY_FAILED' }));
  await f.gateway.start(); const socket = f.sockets[0]; ready(socket); message(socket, 2); message(socket, 3);
  await settle();
  expect(f.errors).toEqual(['DELIVERY_FAILED']);
  expect(f.calls.filter((entry) => entry.operation === 'gateway-pull').every((entry) => entry.input.after < 3)).toBe(true);
  await vi.advanceTimersByTimeAsync(1500); expect(f.sockets).toHaveLength(1);
  f.held.resolve(); await settle();
  expect(f.delivered).toEqual(['discord:345680']);
  expect(f.sockets).toHaveLength(2);
  expect(f.calls.filter((entry) => entry.operation === 'gateway-open').at(-1).input.cursor.sequence).toBe(2);
  hello(f.sockets[1]); message(f.sockets[1], 3); await settle();
  expect(f.delivered).toEqual(['discord:345680', 'discord:345681']);
});

test('observation does not release the bounded agent backlog or permit invalid acknowledgements', async () => {
  const f = fixture(); const input = { scope: f.scope, connectionId: 'bounded', identityId: 'discord', identityRevision: 1, cursor: null };
  await f.transport.open(input); const socket = f.sockets[0]; socket.emit('open');
  for (let i = 0; i < 128; i++) emit(socket, { op: 11, d: null });
  expect((await f.transport.pull({ ...input, after: 0, observed: 127 })).frames.map((entry) => entry.id)).toEqual([128]);
  expect((await f.transport.pull({ ...input, after: 0 })).frames.map((entry) => entry.id)).toEqual(Array.from({ length: 16 }, (_, i) => i + 1));
  await expect(f.transport.pull({ ...input, after: 2, observed: 1 })).rejects.toMatchObject({ code: 'BOT_DISCORD_GATEWAY_CHANGED' });
  await expect(f.transport.pull({ ...input, after: 0, observed: 129 })).rejects.toMatchObject({ code: 'BOT_DISCORD_GATEWAY_CHANGED' });
  const aborted = AbortSignal.abort(new Error('cancelled'));
  await expect(f.transport.pull({ ...input, after: 0, observed: 128 }, { signal: aborted })).rejects.toThrow('cancelled');
  emit(socket, { op: 11, d: null }); expect(socket.terminate).toHaveBeenCalledOnce();
  expect((await f.transport.pull({ ...input, after: 0 })).frames).toHaveLength(16);
  expect((await f.transport.pull({ ...input, after: 128, observed: 128 })).frames).toEqual([]);
  await expect(f.transport.pull({ ...input, after: 0 })).rejects.toMatchObject({ code: 'BOT_DISCORD_GATEWAY_CHANGED' });
});

test('fatal Discord authorization close halts the owner after pending delivery settles', async () => {
  vi.useFakeTimers(); const f = fixture(); await f.gateway.start(); const socket = f.sockets[0];
  ready(socket); await settle(); message(socket, 2); await settle(); socket.emit('close', 4004); await settle();
  expect(f.gateway.halted()).toBe(false);
  f.held.resolve(); await settle();
  expect(f.delivered).toEqual(['discord:345680']);
  expect(f.errors).toEqual(['BOT_SERVICE_AUTH_REQUIRED']);
  expect(f.gateway.halted()).toBe(true);
  await vi.advanceTimersByTimeAsync(5000);
  expect(f.sockets).toHaveLength(1);
});
