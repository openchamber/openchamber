import { isSubagentTool, subagentSessionId } from '@/lib/opencode/tools';
import type { State } from './types';

/** Explicit foreground dependencies of the latest unfinished assistant step. */
export function currentSubagentWaits(state: Pick<State, 'message' | 'part'> | undefined, sessionID: string): readonly string[] {
  const messages = state?.message[sessionID];
  if (!messages) return [];
  for (let index = messages.length - 1; index >= 0; index -= 1) {
    const message = messages[index];
    if (message.role === 'synthetic') continue;
    if (message.role !== 'assistant') return [];
    if (message.time.streamed === undefined || message.time.completed !== undefined || message.error || message.closedLocally) return [];
    const waits: string[] = [];
    for (const part of state?.part[message.id] ?? []) {
      if ((part.type === 'text' || part.type === 'reasoning') && part.time?.end === undefined) return [];
      if (part.type !== 'tool') continue;
      if (part.state.status === 'pending') return [];
      if (part.state.status !== 'running') continue;
      // An unfinished unrelated tool is independent work. A completed background
      // call never makes its still-running child a dependency of this step.
      if (!isSubagentTool(part.tool) || part.state.input.background === true) return [];
      const child = subagentSessionId(part.state.metadata);
      if (!child) return [];
      waits.push(child);
    }
    return waits;
  }
  return [];
}
