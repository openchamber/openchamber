import { z } from 'zod';
import { stableReplyInputId } from '../uiBlocks/answer';
import type { A2uiJson, A2uiObject } from './protocol';

const jsonValue: z.ZodType<A2uiJson> = z.lazy(() =>
  z.union([
    z.string(),
    z.number(),
    z.boolean(),
    z.null(),
    z.array(jsonValue),
    z.record(z.string(), jsonValue),
  ]),
);

export const a2uiAnswerDataSchema = z.object({
  action: z.string(),
  surfaceId: z.string(),
  context: z.record(z.string(), jsonValue),
  note: z.string().optional(),
});

export type A2uiAnswerData = z.infer<typeof a2uiAnswerDataSchema>;

export interface A2uiPageSubmission {
  summary: string;
  data: A2uiAnswerData;
}

export const a2uiReplyDraftSchema = z.object({
  dataModel: jsonValue,
  note: z.string(),
});

export type A2uiReplyDraft = z.infer<typeof a2uiReplyDraftSchema>;

export const A2UI_ANSWER_METADATA_KEY = 'openchamberA2uiAnswer';

export const a2uiAnswerRecordSchema = z.object({
  messageId: z.string(),
  block: z.string(),
  answer: a2uiAnswerDataSchema,
});

export function a2uiBlockKey(source: string): string {
  let hash = 0x811c9dc5;
  for (let index = 0; index < source.length; index++) {
    hash ^= source.charCodeAt(index);
    hash = Math.imul(hash, 0x01000193);
  }
  return (hash >>> 0).toString(36);
}

export { stableReplyInputId };

/**
 * Formats an A2UI userAction submission as concise, structured text so the agent
 * receives every selection and note in one synthetic turn without needing to
 * re-parse prose.
 */
export function describeA2uiReplyAnswer(answer: A2uiAnswerData): string {
  const lines = [`The user submitted action "${answer.action}" on A2UI surface "${answer.surfaceId}":`];
  const ctx: A2uiObject = answer.context;

  if (typeof ctx.answers === 'object' && ctx.answers !== null && !Array.isArray(ctx.answers)) {
    const notes = typeof ctx.notes === 'object' && ctx.notes !== null && !Array.isArray(ctx.notes)
      ? ctx.notes
      : {};
    for (const [id, value] of Object.entries(ctx.answers)) {
      if (value === null || value === '' || (Array.isArray(value) && value.length === 0)) continue;
      const formatted = Array.isArray(value) ? value.join(', ') : String(value);
      lines.push(`- ${id}: ${formatted}`);
      const itemNote = notes[id];
      if (typeof itemNote === 'string' && itemNote.trim()) {
        lines.push(`  Note: ${itemNote.trim()}`);
      }
    }
    if (Array.isArray(ctx.unanswered) && ctx.unanswered.length > 0) {
      lines.push(`Unanswered: ${ctx.unanswered.map(String).join(', ')}`);
    }
  } else {
    lines.push('```json');
    lines.push(JSON.stringify(ctx, null, 2));
    lines.push('```');
  }

  if (answer.note?.trim()) {
    lines.push(`Overall note: ${answer.note.trim()}`);
  }
  return lines.join('\n');
}
