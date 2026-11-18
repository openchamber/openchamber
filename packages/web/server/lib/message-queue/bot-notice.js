import { createHash } from 'node:crypto';
import { z } from 'zod';

const identity = z.string().trim().min(1);
const noticeSchema = z.object({
  source: z.literal('openchamber-notice'), kind: z.literal('bot'),
  projectId: identity, itemId: identity, eventId: identity,
}).strict();

export function parseBotNotice(value, itemId) {
  const parsed = noticeSchema.safeParse(value);
  if (!parsed.success || parsed.data.itemId !== itemId) throw new TypeError('invalid bot notice');
  if (JSON.stringify(parsed.data).length > 64 * 1024) throw new TypeError('bot notice is too large');
  return parsed.data;
}

/** Event identity survives both queue removal and a lost coordinator receipt. */
export function botNoticeIds({ projectId, itemId, eventId }) {
  const digest = createHash('sha256').update(JSON.stringify([projectId, itemId, eventId])).digest('hex');
  return { itemId: `queued-bot-${digest}`, messageId: `msg_${digest}` };
}
