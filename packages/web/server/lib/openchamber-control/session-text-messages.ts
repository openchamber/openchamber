import { z } from 'zod';
import { asNonEmptyString } from '../shared/guards.js';

const isText = (value: unknown): value is string => typeof value === 'string';
const isFiniteNumber = (value: unknown): value is number => Number.isFinite(value);

export interface MessageRecord {
  id: string;
  type: string;
  text?: unknown;
  content?: { type: string; text?: unknown }[];
  model?: { providerID?: unknown; id?: unknown };
  metadata?: unknown;
  time: { created: number; completed?: number };
}
export interface TextMessage {
  id: string;
  role: string;
  createdAt: number | null;
  completedAt: number | null;
  model: string | null;
  text: string;
  attached?: true;
}

const messageText = (record: MessageRecord) => {
  if (record.type === 'user' || record.type === 'synthetic') return isText(record.text) ? record.text.trim() : '';
  return (Array.isArray(record.content) ? record.content : [])
    .filter((item) => item?.type === 'text' && isText(item.text))
    .map((item) => item.text)
    .join('')
    .trim();
};

const USER_SYNTHETIC_METADATA_KEYS = ['openchamberContext', 'openchamberLeadAnswer', 'openchamberUiBlockAnswer'];
const USER_SYNTHETIC_SOURCES = new Set(['openchamber-page-answer']);
const userSyntheticSchema = z.object({ type: z.literal('synthetic'), metadata: z.record(z.string(), z.unknown()) });

const isFromUser = (record: MessageRecord) => {
  const metadata = userSyntheticSchema.safeParse(record).data?.metadata;
  if (!metadata) return false;
  return USER_SYNTHETIC_METADATA_KEYS.some((key) => Object.hasOwn(metadata, key)) || USER_SYNTHETIC_SOURCES.has(String(metadata.source));
};

const byTimeThenId = (left: TextMessage, right: TextMessage) => (
  (left.createdAt || 0) - (right.createdAt || 0) || (left.id < right.id ? -1 : left.id > right.id ? 1 : 0)
);

export const extractTextMessages = (messages: MessageRecord[], role = 'all') => {
  const result: TextMessage[] = [];
  for (const record of Array.isArray(messages) ? messages : []) {
    const attached = isFromUser(record);
    const messageRole = attached ? 'user' : record?.type;
    if ((messageRole !== 'user' && messageRole !== 'assistant') || (role !== 'all' && role !== messageRole)) continue;
    const text = messageText(record);
    if (!text) continue;
    const providerID = asNonEmptyString(record.model?.providerID);
    const modelID = asNonEmptyString(record.model?.id);
    const message: TextMessage = {
      id: asNonEmptyString(record.id) || '',
      role: messageRole,
      createdAt: isFiniteNumber(record?.time?.created) ? record.time.created : null,
      completedAt: isFiniteNumber(record?.time?.completed) ? record.time.completed : null,
      model: providerID && modelID ? `${providerID}/${modelID}` : null,
      text,
    };
    if (attached) message.attached = true;
    result.push(message);
  }
  return result.sort(byTimeThenId);
};
