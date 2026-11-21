import { z } from 'zod';
import type { BlockField } from './catalog';

const fieldValue = z.union([z.string(), z.array(z.string())]);
export type UiBlockFieldValue = z.infer<typeof fieldValue>;

export const uiBlockReplyDraft = z.object({
  values: z.record(z.string(), fieldValue),
  chosen: z.array(z.tuple([z.string(), z.string().nullable()])),
  notes: z.array(z.tuple([z.string(), z.string()])),
  note: z.string(),
});
export type UiBlockReplyDraft = z.infer<typeof uiBlockReplyDraft>;

type InputIdStorage = Pick<Storage, 'getItem' | 'setItem'>;

const readStored = (storage: InputIdStorage | undefined, key: string): string | null => {
  try {
    return storage?.getItem(key) ?? null;
  } catch {
    return null;
  }
};

const writeStored = (storage: InputIdStorage | undefined, key: string, value: string): boolean => {
  try {
    storage?.setItem(key, value);
    return true;
  } catch {
    return false;
  }
};

export function stableReplyInputId(key: string, storage: InputIdStorage | undefined, memory: Map<string, string>, create: () => string): string {
  const storageKey = `oc.ui-block.reply-input.v1:${key}`;
  const known = memory.get(key) ?? readStored(storage, storageKey);
  const id = known ?? create();
  if (!known) writeStored(storage, storageKey, id);
  memory.set(key, id);
  return id;
}

export const uiBlockAnswerData = z.object({
  button: z.string(),
  value: z.string().optional(),
  values: z.record(z.string(), fieldValue),
  note: z.string().optional(),
});
export type UiBlockAnswerData = z.infer<typeof uiBlockAnswerData>;
export type UiBlockAnswer = { summary: string; data: UiBlockAnswerData };

const pick = z.object({ button: z.string().optional(), value: z.string().optional(), note: z.string().optional() });

const uiBlockReplyAnswerData = z.object({
  picks: z.array(pick),
  values: z.record(z.string(), fieldValue),
  skipped: z.array(z.string()),
});
export type UiBlockReplyAnswerData = z.infer<typeof uiBlockReplyAnswerData>;

export const UI_BLOCK_ANSWER_METADATA_KEY = 'openchamberUiBlockAnswer';
export const uiBlockAnswerRecord = z.object({
  messageId: z.string(),
  block: z.string(),
  answer: uiBlockReplyAnswerData,
});

export function uiBlockKey(source: string): string {
  let hash = 0x811c9dc5;
  for (let index = 0; index < source.length; index++) {
    hash ^= source.charCodeAt(index);
    hash = Math.imul(hash, 0x01000193);
  }
  return (hash >>> 0).toString(36);
}

export function describeUiBlockReplyAnswer(fields: BlockField[], data: UiBlockReplyAnswerData): string {
  const lines = ['The user answered the UI block in your previous reply:'];
  for (const choice of data.picks) {
    const answer = choice.button ?? 'no option chosen';
    lines.push(choice.value ? `- ${choice.value}: ${answer}` : `- ${answer}`);
    if (choice.note) lines.push(`  Their note: ${choice.note}`);
  }
  for (const field of fields) {
    const value = data.values[field.name];
    const text = Array.isArray(value) ? value.join(', ') : value?.trim();
    if (text) lines.push(/[?:]$/.test(field.label) ? `- ${field.label} ${text}` : `- ${field.label}: ${text}`);
  }
  const skipped = data.skipped.map((decision) => decision || 'the buttons that name no item');
  if (skipped.length) lines.push(`They sent it without a choice for: ${skipped.join(', ')}.`);
  return lines.join('\n');
}

export function describeUiBlockAnswer(fields: BlockField[], data: UiBlockAnswerData, noteLabel: string, withButton = true): string {
  const lines = withButton ? [data.value ? `${data.button} · ${data.value}` : data.button] : [];
  for (const field of fields) {
    const value = data.values[field.name];
    const text = Array.isArray(value) ? value.join(', ') : value?.trim();
    if (text) lines.push(/[?:]$/.test(field.label) ? `${field.label} ${text}` : `${field.label}: ${text}`);
  }
  if (data.note) lines.push(`${noteLabel}: ${data.note}`);
  return lines.join('\n');
}

export const pageAnswerNamesButton = (decisionCount: number, fieldCount: number): boolean => (
  decisionCount > 1 || (decisionCount === 1 && fieldCount === 0)
);

const MAX_PAGE_SUMMARY_LENGTH = 500;

export const pageAnswerSummary = (summary: string): string => (
  summary.length > MAX_PAGE_SUMMARY_LENGTH ? `${summary.slice(0, MAX_PAGE_SUMMARY_LENGTH - 1)}…` : summary
);
