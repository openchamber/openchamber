import express from 'express';
import { z } from 'zod';
import { createBotAdapterState } from './adapter-state.js';
import { digestMutationInput } from '../source-control/mutation-executor.js';
import { BotServiceError } from './services/contracts.js';
import { BOT_TOOL_ACTIONS } from './tool.js';

const text = z.string().min(1).max(200);
const requestSchema = z.object({ sessionId: text, callId: text, action: z.enum(BOT_TOOL_ACTIONS.map((entry) => entry.action)), input: z.json() }).strict();
const replySchema = z.discriminatedUnion('ok', [
  z.object({ ok: z.literal(true), result: z.json() }).strict(),
  z.object({ ok: z.literal(false), error: z.object({ code: text, status: z.number().int().min(400).max(599), state: z.enum(['needs-you', 'outcome-unknown', 'failed', 'refused']) }).strict() }).strict(),
]);
const pendingSchema = z.object({ id: z.string().regex(/^[a-f0-9]{64}$/), request: requestSchema }).strict();
const recordSchema = z.discriminatedUnion('state', [
  pendingSchema.extend({ state: z.literal('pending') }).strict(),
  pendingSchema.extend({ state: z.literal('settled'), reply: replySchema }).strict(),
]);
export const isolatedBotToolPageSchema = z.object({ requests: z.array(pendingSchema).max(100) }).strict();
const settlementSchema = z.object({ id: z.string().regex(/^[a-f0-9]{64}$/), request: requestSchema, reply: replySchema }).strict();
export const isolatedBotToolReceiptSchema = z.discriminatedUnion('state', [
  pendingSchema.extend({ state: z.literal('dispatching') }).strict(),
  pendingSchema.extend({ state: z.literal('settled'), reply: replySchema }).strict(),
]);
const keyFor = ({ sessionId, callId }) => ({ sessionId, callId });

/** Runs only on the child server. All host authority stays outside this inbox. */
export function createBotIsolatedToolInbox({ dataDir, onPending }) {
  if (!(onPending instanceof Function)) throw new TypeError('The child tool inbox requires a session-event wake owner');
  const records = createBotAdapterState({ dataDir, name: 'isolated-tool-inbox', schema: recordSchema });
  const waiters = new Map();
  const request = async (raw, { signal } = {}) => {
    signal?.throwIfAborted();
    const parsed = requestSchema.parse(raw); const key = keyFor(parsed); const id = digestMutationInput(key);
    const saved = await records.own(key, async () => {
      const previous = await records.read(key);
      if (previous && digestMutationInput(previous.request) !== digestMutationInput(parsed)) throw new BotServiceError('BOT_ISOLATED_TOOL_CHANGED', 'A child tool call changed its captured input.');
      return previous ?? records.write(key, { id, request: parsed, state: 'pending' });
    });
    const unwrap = (reply) => {
      if (!reply.ok) throw new BotServiceError(reply.error.code, 'The isolated bot operation needs host attention.', reply.error.state, reply.error.status);
      return reply.result;
    };
    if (saved.state === 'settled') return unwrap(saved.reply);
    let wake; let abort;
    const settled = new Promise((resolve, reject) => {
      wake = resolve;
      abort = () => reject(signal.reason);
      signal?.addEventListener('abort', abort, { once: true });
      const group = waiters.get(id) ?? new Set(); group.add(wake); waiters.set(id, group);
      if (signal?.aborted) abort();
    });
    try {
      // Publish only after the durable request exists. The host observes this
      // session event on its existing space stream and pulls this inbox.
      await Promise.race([Promise.resolve(onPending({ sessionId: parsed.sessionId, requestId: id })), settled]);
      const latest = await records.read(key);
      if (latest.state === 'settled') return unwrap(latest.reply);
      return unwrap(await settled);
    } finally {
      signal?.removeEventListener('abort', abort);
      const group = waiters.get(id); group?.delete(wake); if (!group?.size) waiters.delete(id);
    }
  };
  const pending = async (sessionId) => ({ requests: (await records.list()).filter((entry) => entry.state === 'pending' && entry.request.sessionId === text.parse(sessionId)).map(({ id, request }) => ({ id, request })) });
  const settle = async (raw) => {
    const value = settlementSchema.parse(raw); const key = keyFor(value.request);
    if (digestMutationInput(key) !== value.id) throw new BotServiceError('BOT_ISOLATED_TOOL_CHANGED', 'The child tool receipt names another request.');
    await records.own(key, async () => {
      const previous = await records.read(key);
      if (!previous || digestMutationInput(previous.request) !== digestMutationInput(value.request)
        || previous.state === 'settled' && digestMutationInput(previous.reply) !== digestMutationInput(value.reply)) throw new BotServiceError('BOT_ISOLATED_TOOL_CHANGED', 'The child tool receipt differs from its durable request.');
      if (previous.state === 'pending') await records.write(key, { ...previous, state: 'settled', reply: value.reply });
    });
    for (const wake of waiters.get(value.id) ?? []) wake(value.reply);
    return { settled: true };
  };
  return { request, pending, settle };
}

/** Mount after the child server's existing UI-auth gate. Never mount on the host. */
export function registerBotIsolatedToolRoutes(app, { inbox, isInsideSpace }) {
  if (!(isInsideSpace instanceof Function)) throw new TypeError('Child tool routes require the server-owned space boundary');
  const allowed = (_req, res, next) => isInsideSpace() ? next() : res.status(403).json({ code: 'BOT_ISOLATED_CHILD_REQUIRED' });
  const failure = (res, error) => res.status(error instanceof BotServiceError ? error.status : 400).json({ code: error instanceof BotServiceError ? error.code : 'BOT_ISOLATED_TOOL_INVALID' });
  app.get('/api/openchamber/bots/isolated-tools', allowed, async (req, res) => {
    try { res.json(await inbox.pending(text.parse(req.query.sessionId))); }
    catch (error) { failure(res, error); }
  });
  app.post('/api/openchamber/bots/isolated-tools/settle', allowed, express.json({ limit: '1mb' }), async (req, res) => {
    try { res.json(await inbox.settle(req.body)); }
    catch (error) { failure(res, error); }
  });
}
