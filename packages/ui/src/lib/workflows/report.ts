import { z } from 'zod';

import type { Message } from '@/lib/opencode/model';


export type WorkflowReportState = 'completed' | 'failed' | 'stopped' | 'declined';

export type WorkflowReport = {
  runId: string;
  name: string;
  state: WorkflowReportState;
  output: string;
};

const metadataSchema = z.object({
  source: z.literal('openchamber-workflow'),
  runId: z.string().min(1),
  name: z.string(),
  state: z.enum(['completed', 'failed', 'stopped', 'declined']),
});

const ENVELOPE = /^\s*<openchamber-workflow\b[^>]*>\n?([\s\S]*?)\n?<\/openchamber-workflow>\s*$/;

export function readWorkflowReport(message: Message): WorkflowReport | undefined {
  if (message.role !== 'synthetic') return undefined;
  const parsed = metadataSchema.safeParse(message.metadata ?? {});
  if (!parsed.success) return undefined;
  const envelope = message.text.match(ENVELOPE);
  return {
    runId: parsed.data.runId,
    name: parsed.data.name,
    state: parsed.data.state,
    output: envelope ? envelope[1] : message.text,
  };
}
