import path from 'node:path';
import { z } from 'zod';
import { botItemSchema, TERMINAL_ITEM_STATES } from './schema.js';
import { botNoticeIds, parseBotNotice } from '../message-queue/bot-notice.js';

const text = z.string().trim().min(1);
const deliverySchema = z.object({ projectId: text, item: z.object({ id: text }), eventId: text, text: z.string().max(200_000).refine((value) => value.trim().length > 0) });
const sessionSchema = z.object({
  id: text, directory: text, isolated: z.boolean(), archived: z.boolean().optional(),
  metadata: z.object({ openchamber: z.object({ automation: z.object({
    source: z.literal('bot'), projectId: text, botId: text, itemId: text,
    stage: z.enum(['investigation', 'fixing', 'judge']),
  }) }) }),
});

const refuse = (code) => { throw Object.assign(new Error(code), { code, status: 409 }); };
const spaceRoot = (directory) => /^\/spaces\/([a-f0-9]{12})(?:\/|$)/.exec(directory)?.[1] ?? null;

/** readSession and queueFor must resolve the recorded runtime at call time. */
export function createBotNotices({ store, config, readSession, queueFor }) {
  for (const value of [store?.read, config?.read, readSession, queueFor]) {
    if (!(value instanceof Function)) throw new TypeError('Bot notices require item, config, session and queue owners');
  }
  const targetFor = async (projectId, itemId) => {
    const candidate = (await store.read(projectId)).items.find((entry) => entry.id === itemId);
    if (!candidate) refuse('BOT_NOTICE_ITEM_MISSING');
    const item = botItemSchema.parse(candidate);
    if (TERMINAL_ITEM_STATES.includes(item.state)) refuse('BOT_NOTICE_ITEM_FINISHED');
    const bot = (await config.read(projectId)).definitions.find((entry) => entry.id === item.botId);
    if (!bot?.enabled) refuse('BOT_NOTICE_BOT_UNAVAILABLE');
    // Feedback normally returns to correction. Before correction exists, use
    // the persisted investigation or judge session of the current stage.
    const stage = item.sessions.fixing ? 'fixing'
      : item.state === 'judging' ? 'judge' : item.sessions.investigation ? 'investigation' : 'judge';
    const sessionId = item.sessions[stage];
    if (!sessionId || !item.worktree) refuse('BOT_NOTICE_SESSION_MISSING');
    const session = sessionSchema.parse(await readSession({ projectId, item, bot, stage, sessionId }));
    const marker = session.metadata.openchamber.automation;
    if (session.id !== sessionId || session.archived || marker.projectId !== projectId || marker.itemId !== itemId
      || marker.botId !== item.botId || marker.stage !== stage) refuse('BOT_NOTICE_SESSION_MISMATCH');
    const directory = path.posix.normalize(session.directory);
    const isolated = session.isolated;
    if (isolated ? !spaceRoot(directory) : spaceRoot(directory) || directory !== path.posix.normalize(item.worktree)) {
      refuse('BOT_NOTICE_ISOLATION_MISMATCH');
    }
    return { projectId, itemId, sessionId, directory, isolated, stage };
  };
  const assertDispatch = async ({ sessionId, directory, origin, notice, isolated = false }) => {
    if (origin?.kind !== 'bot') refuse('BOT_NOTICE_ORIGIN_MISMATCH');
    const parsed = parseBotNotice(notice, origin.id);
    const target = await targetFor(parsed.projectId, parsed.itemId);
    if (target.sessionId !== sessionId || target.directory !== directory || target.isolated !== isolated) {
      refuse('BOT_NOTICE_TARGET_CHANGED');
    }
    return { includeMemorySaveRule: target.stage === 'fixing' };
  };
  const deliver = async (input) => {
    const request = deliverySchema.parse(input);
    // The caller's detached item supplies identity only. Disk supplies authority.
    const target = await targetFor(request.projectId, request.item.id);
    const notice = { source: 'openchamber-notice', kind: 'bot', projectId: request.projectId, itemId: request.item.id, eventId: request.eventId };
    const ids = botNoticeIds(notice);
    const queue = await queueFor(target);
    if (!(queue?.enqueue instanceof Function)) refuse('BOT_NOTICE_QUEUE_UNAVAILABLE');
    const result = await queue.enqueue(target.sessionId, target.directory, {
      id: ids.itemId, messageId: ids.messageId, content: request.text, text: request.text,
      origin: { kind: 'bot', id: request.item.id }, notice,
    });
    if (result?.itemId !== ids.itemId) refuse('BOT_NOTICE_ADMISSION_UNCONFIRMED');
    return { itemId: ids.itemId, messageId: ids.messageId, sessionId: target.sessionId };
  };
  return { deliver, assertDispatch };
}
