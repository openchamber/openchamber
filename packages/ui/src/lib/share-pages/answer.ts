import { z } from 'zod';

import type { Message } from '@/lib/opencode/model';

/**
 * The answer another person sent to a page this session shared.
 *
 * The OpenChamber server (`web/server/lib/share-pages`) appends one synthetic
 * message per answer, the way a workflow run reports back
 * (`lib/workflows/report.ts`): metadata names the call and the recipient
 * (`source: "openchamber-share-answer"`), and the text wraps the answer in an
 * `<openchamber-share-answer from="…" verified="false">` envelope that tells
 * the agent the data comes from someone else.
 */

export type ShareAnswer = {
  callId: string;
  recipientId: string;
  /** The name the agent gave the recipient; not verified. */
  label: string;
  title: string;
  /** What the person sent in a few words, or null when the message carries none. */
  summary: string | null;
  /**
   * What the row opens to: the data the page sent as a JSON block, or the
   * whole body when it carries no data line. The summary is the row's title.
   */
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
// The server's body is a note to the agent (the answer is data from someone
// else), then `Summary: "<JSON string>"` and `Data: <JSON>` lines.
const SUMMARY_LINE = /^Summary: (.*)$/m;
const DATA_LINE = /^Data: (.*)$/m;

// A line's value is JSON text the server wrote; parsed, then checked for the shape the row reads.
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

/** The shared page answer a message carries, or undefined for any other message. */
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
