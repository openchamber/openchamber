import { getLastConversationMessage, type Message, type Part, type SessionStatus, type ToolPart } from '@/lib/opencode/model';
import { structuredErrorText } from '@/lib/opencode/projection';
import { commandPreview, PANEL_COMMAND_LENGTH } from '@/lib/opencode/toolRowPreview';
import { isExecuteTool, isShellTool, toolDescription, type ToolDescription } from '@/lib/opencode/tools';
import { getToolMetadata } from '@/lib/toolHelpers';

export const SUBAGENT_SILENCE_MS = 90_000;

type ToolCall = { tool: string | null; detail: string | null };

export type SubagentActivity =
  | { kind: 'retry'; attempt: number | null; at: number | null; error: string | null }
  | ({ kind: 'tool'; since: number } & ToolCall)
  | { kind: 'thinking' }
  | { kind: 'writing' }
  | { kind: 'waiting'; since: number; last: ToolCall | null };

const baseName = (path: string): string => {
  const trimmed = path.replace(/[\\/]+$/, '');
  const index = Math.max(trimmed.lastIndexOf('/'), trimmed.lastIndexOf('\\'));
  return index >= 0 ? trimmed.slice(index + 1) : trimmed;
};

const describeDetail = (description: ToolDescription | null): string | null => {
  if (!description) return null;
  switch (description.kind) {
    case 'path':
      return baseName(description.value) || description.value;
    case 'text':
      return description.value;
    case 'files':
      return description.files.map(baseName).join(', ');
    case 'tools':
      return description.calls.map((call) => call.name).join(', ');
    case 'questions':
      return null;
  }
};

const callsByPart = new WeakMap<ToolPart, ToolCall>();

const describeTool = (part: ToolPart): ToolCall => {
  const cached = callsByPart.get(part);
  if (cached) return cached;
  const metadata = 'metadata' in part.state ? part.state.metadata : undefined;
  const description = toolDescription(part.tool, part.state.input, metadata);
  const isCommand = isShellTool(part.tool) || isExecuteTool(part.tool);
  const detail = description?.kind === 'text' && isCommand
    ? commandPreview(description.value, PANEL_COMMAND_LENGTH)
    : describeDetail(description);
  const call = isShellTool(part.tool) && detail ? { tool: null, detail } : { tool: getToolMetadata(part.tool).displayName, detail };
  callsByPart.set(part, call);
  return call;
};

export const toolCallText = (call: ToolCall): string => [call.tool, call.detail].filter(Boolean).join(' ');

const partEnd = (part: Part): number | null => {
  if (part.type === 'tool') return part.state.status === 'completed' || part.state.status === 'error' ? part.state.time.end : null;
  if (part.type === 'reasoning') return part.time.end ?? null;
  if (part.type === 'text') return part.time?.end ?? null;
  return null;
};

export const readSubagentActivity = (
  messages: readonly Message[] | undefined,
  partsByMessage: Readonly<Record<string, Part[] | undefined>>,
  status: SessionStatus | undefined,
): SubagentActivity | null => {
  if (status?.type === 'retry') {
    return { kind: 'retry', attempt: status.attempt ?? null, at: status.next ?? null, error: status.message || null };
  }
  if (!messages || messages.length === 0) return null;

  const latest = getLastConversationMessage(messages);
  if (!latest) return null;
  if (latest.role !== 'assistant') {
    return { kind: 'waiting', since: latest.time.created, last: null };
  }
  if (latest.retry) {
    return { kind: 'retry', attempt: latest.retry.attempt, at: latest.retry.at, error: structuredErrorText(latest.retry.error) || null };
  }

  const parts = partsByMessage[latest.id] ?? [];
  for (let index = parts.length - 1; index >= 0; index -= 1) {
    const part = parts[index];
    if (part.type !== 'tool') continue;
    if (part.state.status === 'running') return { kind: 'tool', ...describeTool(part), since: part.state.time.start };
    if (part.state.status === 'pending') return { kind: 'tool', ...describeTool(part), since: latest.time.created };
  }

  const tail = parts[parts.length - 1];
  if (tail?.type === 'reasoning' && tail.time.end === undefined) return { kind: 'thinking' };
  if (tail?.type === 'text' && tail.time && tail.time.end === undefined) return { kind: 'writing' };

  let since = latest.time.completed ?? latest.time.created;
  for (const part of parts) {
    const end = partEnd(part);
    if (end !== null && end > since) since = end;
  }
  return { kind: 'waiting', since, last: findLastTool(messages, partsByMessage) };
};

const LAST_TOOL_LOOKBACK = 4;

const findLastTool = (
  messages: readonly Message[],
  partsByMessage: Readonly<Record<string, Part[] | undefined>>,
): ToolCall | null => {
  let steps = 0;
  for (let index = messages.length - 1; index >= 0 && steps < LAST_TOOL_LOOKBACK; index -= 1) {
    const message = messages[index];
    if (message.role === 'user') break;
    if (message.role !== 'assistant') continue;
    steps += 1;
    const parts = partsByMessage[message.id] ?? [];
    for (let partIndex = parts.length - 1; partIndex >= 0; partIndex -= 1) {
      const part = parts[partIndex];
      if (part.type === 'tool') return describeTool(part);
    }
  }
  return null;
};

export const subagentAlertInputs = (activity: SubagentActivity | null): SubagentActivity | null => {
  if (activity?.kind === 'retry') return activity;
  if (activity?.kind === 'waiting') return { kind: 'waiting', since: activity.since, last: null };
  return null;
};

export const encodeSubagentActivity = (activity: SubagentActivity | null): string => (activity ? JSON.stringify(activity) : '');

export const decodeSubagentActivity = (encoded: string): SubagentActivity | null => {
  if (!encoded) return null;
  const activity: SubagentActivity = JSON.parse(encoded);
  return activity;
};

const REPORT_LINE_MAX = 200;

const plainLines = (output: string): string[] => output.split('\n').flatMap((raw) => {
  const trimmed = raw.trim();
  if (/^(?:-{3,}|\*{3,}|_{3,}|```.*|~~~.*)$/.test(trimmed)) return [];
  const line = trimmed
    .replace(/^#{1,6}\s+/, '')
    .replace(/^(?:[-*+]|\d+[.)])\s+/, '')
    .replace(/^>\s*/, '')
    .replace(/(\*\*|__|`)/g, '')
    .trim();
  return line ? [line] : [];
});

export const reportFirstLine = (output: string): string | null => {
  const [first, second] = plainLines(output);
  if (!first) return null;
  const line = first.endsWith(':') && second ? `${first} ${second}` : first;
  return line.length > REPORT_LINE_MAX ? `${line.slice(0, REPORT_LINE_MAX)}…` : line;
};
