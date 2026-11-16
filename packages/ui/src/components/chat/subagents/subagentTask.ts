import { z } from 'zod';

import type { Message, Part } from '@/lib/opencode/model';
import { isSubagentTool, subagentSessionId } from '@/lib/opencode/tools';

const subagentCallInputSchema = z.object({ prompt: z.string().trim().min(1) });

export const findSubagentTask = (
  parentMessages: readonly Message[] | undefined,
  childMessages: readonly Message[] | undefined,
  partsByMessage: Readonly<Record<string, Part[] | undefined>>,
  childId: string,
): string | null => {
  for (const message of parentMessages ?? []) {
    if (message.role !== 'assistant') continue;
    for (const part of partsByMessage[message.id] ?? []) {
      if (part.type !== 'tool' || !isSubagentTool(part.tool) || part.state.status === 'pending') continue;
      if (subagentSessionId(part.state.metadata) !== childId) continue;
      const call = subagentCallInputSchema.safeParse(part.state.input);
      if (call.success) return call.data.prompt;
    }
  }
  const first = childMessages?.find((message) => message.role === 'user');
  if (!first) return null;
  const text = (partsByMessage[first.id] ?? [])
    .flatMap((part) => (part.type === 'text' ? [part.text] : []))
    .join('\n')
    .trim();
  return text || null;
};
