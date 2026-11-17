import fs from 'node:fs/promises';
import { afterEach, expect, it, vi } from 'vitest';
import { createMessageQueueRuntime } from '../message-queue/runtime.js';
import { botNoticeIds } from '../message-queue/bot-notice.js';
import path from 'node:path';
import { createBotHostSessions } from './host-sessions.js';

const cleanups = [];
afterEach(async () => { vi.useRealTimers(); for (const cleanup of cleanups.splice(0).reverse()) await cleanup(); });

async function fixture(botTransport) {
  const dataDir = await fs.mkdtemp('/tmp/opencode/bot-host-notice-recovery-');
  cleanups.push(() => fs.rm(dataDir, { recursive: true, force: true }));
  const queue = createMessageQueueRuntime({ dataDir, botTransport, dispatchQuietMs: 1, retryDelayMs: () => 50,
    globalEventHub: { subscribeEvent: () => () => {}, subscribeStatus: () => () => {} },
    buildOpenCodeUrl: () => { throw new Error('No owner project HTTP fallback'); }, getOpenCodeAuthHeaders: () => ({}),
    assertBotDispatch: async () => ({ includeMemorySaveRule: true }),
    sessionKnowledgeRuntime: { sync: async () => {} }, broadcastGlobalUiEvent: () => {} });
  cleanups.push(async () => { queue.stop(); await queue.flush(); });
  await queue.load(); queue.start();
  const notice = { source: 'openchamber-notice', kind: 'bot', projectId: 'project', itemId: 'item', eventId: 'reply' };
  const ids = botNoticeIds(notice);
  await queue.enqueue('ses_fixed', '/captured/checkout', { id: ids.itemId, messageId: ids.messageId,
    content: 'Reply', text: 'Reply', notice, origin: { kind: 'bot', id: 'item' } });
  await queue.flush();
  return queue;
}

it('retries unknown typed activity without requiring a reconnect or idle event', async () => {
  vi.useFakeTimers(); let available = false;
  const deliverNotice = vi.fn(async () => {});
  const isIdle = vi.fn(async () => { if (!available) throw new Error('Agent unavailable'); return true; });
  const queue = await fixture({ isIdle, deliverNotice });
  await vi.advanceTimersByTimeAsync(1);
  expect(isIdle).toHaveBeenCalledOnce(); expect(deliverNotice).not.toHaveBeenCalled();
  expect(queue.sessionSnapshot('ses_fixed').items).toHaveLength(1);
  available = true;
  await vi.advanceTimersByTimeAsync(51);
  await vi.waitFor(() => expect(deliverNotice).toHaveBeenCalledOnce());
  expect(queue.sessionSnapshot('ses_fixed').items).toHaveLength(0);
});

it('retains a typed 409 refusal rather than treating it as synthetic-message duplication', async () => {
  vi.useFakeTimers(); let allowed = false;
  const deliverNotice = vi.fn(async () => { if (!allowed) throw Object.assign(new Error('Archived captured session'), { status: 409, code: 'BOT_EXECUTION_SESSION_ARCHIVED' }); });
  const queue = await fixture({ isIdle: async () => true, deliverNotice });
  await vi.advanceTimersByTimeAsync(1);
  await vi.waitFor(() => expect(deliverNotice).toHaveBeenCalledOnce());
  expect(queue.sessionSnapshot('ses_fixed').items).toHaveLength(1);
  allowed = true;
  await vi.advanceTimersByTimeAsync(51);
  await vi.waitFor(() => expect(deliverNotice).toHaveBeenCalledTimes(2));
  expect(queue.sessionSnapshot('ses_fixed').items).toHaveLength(0);
});

it('drains an active typed host send and its settled queue write before session shutdown resolves', async () => {
  const dataDir = await fs.mkdtemp('/tmp/opencode/bot-host-notice-drain-');
  cleanups.push(() => fs.rm(dataDir, { recursive: true, force: true }));
  vi.useFakeTimers();
  let started; const sending = new Promise((resolve) => { started = resolve; });
  let release; const held = new Promise((resolve) => { release = resolve; });
  const sessions = createBotHostSessions({ dataDir, broadcast: () => {}, assertDispatch: async () => ({ includeMemorySaveRule: true }),
    hostExecution: { isWorking: async () => false, syncKnowledge: async () => {}, deliverNotice: async () => { started(); await held; } } });
  const entry = { projectId: 'project', botId: 'bot', itemId: 'item', sessionId: 'ses_fixed', directory: '/captured/checkout', isolated: false, stage: 'fixing' };
  sessions.track(entry); await sessions.restore((_entry, error) => { throw error; });
  const queue = await sessions.queueFor(entry);
  const notice = { source: 'openchamber-notice', kind: 'bot', projectId: 'project', itemId: 'item', eventId: 'reply' };
  const ids = botNoticeIds(notice);
  await queue.enqueue(entry.sessionId, entry.directory, { id: ids.itemId, messageId: ids.messageId, content: 'Reply', text: 'Reply', notice, origin: { kind: 'bot', id: 'item' } });
  await queue.flush(); await vi.advanceTimersByTimeAsync(501); await sending;
  let stopped = false;
  const stopping = sessions.stop().then(() => { stopped = true; });
  try {
    await queue.flush();
    expect(stopped).toBe(false);
  } finally { release(); await stopping; }
  const stored = JSON.parse(await fs.readFile(path.join(dataDir, 'bots/host-queues', entry.sessionId, 'message-queue.json'), 'utf8'));
  expect(stored.sessions[entry.sessionId]?.items ?? []).toEqual([]);
  expect(queue.sessionSnapshot(entry.sessionId).items).toEqual([]);
});
