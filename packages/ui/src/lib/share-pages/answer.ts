import { z } from 'zod';

import type { Message } from '@/lib/opencode/model';


export type ShareAnswer = {
  callId: string;
  recipientId: string;
  label: string;
  title: string;
  summary: string | null;
  output: string;
};

const metadataSchema = z.object({
  source: z.literal('openchamber-share-answer'),
  callId: z.string().min(1),
  recipientId: z.string().min(1),
  label: z.string(),
  title: z.string().catch(''),
});

const ENVELOPE = /^\s*<openchamber-share-answer\b[^>]*>\n?([\s\S]*?)\n?<\/openchamber-share-answer>\s*$/;
const SUMMARY_LINE = /^Summary: (.*)$/m;
const DATA_LINE = /^Data: (.*)$/m;

const jsonLine = <T extends z.ZodType>(schema: T) => z.string().transform((text, context) => {
  try {
    return JSON.parse(text)
  } catch {
    context.addIssue({ code: 'custom', message: 'not JSON' });
    return z.NEVER;
  }
}).pipe(schema);

const summaryLineSchema = jsonLine(z.string().trim().min(1));
const dataLineSchema = jsonLine(z.json());

export function readShareAnswer(message: Message): ShareAnswer | undefined {
  if (message.role !== 'synthetic') return undefined;
  const parsed = metadataSchema.safeParse(message.metadata ?? {});
  if (!parsed.success) return undefined;
  const { callId, recipientId, label, title } = parsed.data;
  const body = message.text.match(ENVELOPE)?.[1] ?? message.text;
  const summary = summaryLineSchema.safeParse(SUMMARY_LINE.exec(body)?.[1]);
  const data = dataLineSchema.safeParse(DATA_LINE.exec(body)?.[1]);
  return {
    callId,
    recipientId,
    label,
    title,
    summary: summary.success ? summary.data : null,
    output: data.success ? `\`\`\`json\n${JSON.stringify(data.data, null, 2)}\n\`\`\`` : body,
  };
}
