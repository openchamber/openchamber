import { z } from 'zod';
import type { BlockField } from './catalog';

const fieldValue = z.union([z.string(), z.array(z.string())]);
export type UiBlockFieldValue = z.infer<typeof fieldValue>;

/** What a block sends when the user presses a Button: its label and every field's value. */
export const uiBlockAnswerData = z.object({
  button: z.string(),
  /** What the pressed button is about, when buttons repeat across cards. */
  value: z.string().optional(),
  values: z.record(z.string(), fieldValue),
  /** What the user added to their answer in the note every waiting form offers. */
  note: z.string().optional(),
});
export type UiBlockAnswerData = z.infer<typeof uiBlockAnswerData>;
export type UiBlockAnswer = { summary: string; data: UiBlockAnswerData };

/** A decision's answer: the pressed button, the user's note on it, or both. */
const pick = z.object({ button: z.string().optional(), value: z.string().optional(), note: z.string().optional() });

/**
 * What a block in a reply sends once the user has chosen: one pick per
 * decision (a decision is the buttons that share a value), the fields, and
 * the decisions the user left without a choice when they sent early.
 */
const uiBlockReplyAnswerData = z.object({
  picks: z.array(pick),
  values: z.record(z.string(), fieldValue),
  skipped: z.array(z.string()),
});
export type UiBlockReplyAnswerData = z.infer<typeof uiBlockReplyAnswerData>;

/**
 * Where the answer to a reply's block is kept: the metadata of the synthetic
 * input that carried it to the agent. `messageId` and `block` find the block
 * again, so it shows the choices after a reload.
 */
export const UI_BLOCK_ANSWER_METADATA_KEY = 'openchamberUiBlockAnswer';
export const uiBlockAnswerRecord = z.object({
  messageId: z.string(),
  block: z.string(),
  answer: uiBlockReplyAnswerData,
});

/** A short stable key for one block's source within its message. */
export function uiBlockKey(source: string): string {
  let hash = 0x811c9dc5;
  for (let index = 0; index < source.length; index++) {
    hash ^= source.charCodeAt(index);
    hash = Math.imul(hash, 0x01000193);
  }
  return (hash >>> 0).toString(36);
}

/** What the agent reads: the choices in its own words, one per line. */
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
  // A decision without a value is the block's own buttons.
  const skipped = data.skipped.map((decision) => decision || 'the buttons that name no item');
  if (skipped.length) lines.push(`They sent it without a choice for: ${skipped.join(', ')}.`);
  return lines.join('\n');
}

/**
 * A page's answer in words: the button, then each filled field as
 * "label: value", then the user's note under `noteLabel`. It is the summary
 * shown under a page that waited.
 */
export function describeUiBlockAnswer(fields: BlockField[], data: UiBlockAnswerData, noteLabel: string): string {
  const lines = [data.value ? `${data.button} · ${data.value}` : data.button];
  for (const field of fields) {
    const value = data.values[field.name];
    const text = Array.isArray(value) ? value.join(', ') : value?.trim();
    // A label that is a question or ends with a colon takes the value after a space.
    if (text) lines.push(/[?:]$/.test(field.label) ? `${field.label} ${text}` : `${field.label}: ${text}`);
  }
  if (data.note) lines.push(`${noteLabel}: ${data.note}`);
  return lines.join('\n');
}

// The server takes a page answer's summary up to this length (render-page.js);
// the full values travel in the answer's data.
const MAX_PAGE_SUMMARY_LENGTH = 500;

export const pageAnswerSummary = (summary: string): string => (
  summary.length > MAX_PAGE_SUMMARY_LENGTH ? `${summary.slice(0, MAX_PAGE_SUMMARY_LENGTH - 1)}…` : summary
);
