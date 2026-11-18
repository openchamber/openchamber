
import { z } from 'zod';
import { readToolEnvelope } from '../openchamber-control/tool-envelope.js';
import { isRecord, isString } from '../shared/object-guards.js';

interface ShellToolInput {
  native?: unknown;
  state?: unknown;
  name?: unknown;
}

export const PART_SHELLS_HEADER = 'x-openchamber-part-shells';

export const CONTENT_SHELL_METADATA_KEY = 'openchamberContentShell';

const ALWAYS_WHOLE_TOOLS = new Set(['subagent', 'task', 'edit', 'write', 'patch']);

export const parsePartShellsHeader = (value: string | string[] | undefined) => {
  if (!isString(value)) return null;
  const [version, ...tools] = value.split(',').map((token) => token.trim());
  if (version !== 'v1') return null;
  return new Set(tools.filter(Boolean));
};

const textLength = (content: unknown[]) => {
  let chars = 0;
  for (const item of content) {
    if (isRecord(item) && item.type === 'text' && isString(item.text)) chars += item.text.length;
  }
  return chars;
};

const isEnvelopeTool = <Name>(name: Name) => name === 'execute' || String(name).startsWith('openchamber');
const MAX_ENVELOPE_CHARS = 256 * 1024;
const ACTIONS_THE_CHAT_DRAWS_FROM_THEIR_RESULT = new Set(['workflow.run', 'image.generate']);

const singleTextSchema = z.tuple([z.object({ type: z.literal('text'), text: z.string().max(MAX_ENVELOPE_CHARS) })]);

const envelopeSummary = (content: unknown[]) => {
  const single = singleTextSchema.safeParse(content);
  if (!single.success) return undefined;
  const { text } = single.data[0];
  const head = text.trimStart();
  if ((head[0] !== '{' && head[0] !== '"') || !head.slice(0, 48).includes('schemaVersion')) return undefined;
  const envelope = readToolEnvelope(text);
  return envelope ? { ok: envelope.ok, action: envelope.action } : undefined;
};

const shellTool = (part: ShellToolInput, keepWhole: ReadonlySet<string>) => {
  const { native: _native, ...tool } = part;
  const state = tool.state;
  if (!isRecord(state) || (state.status !== 'completed' && state.status !== 'error')) return tool;
  if (isString(tool.name) && (keepWhole.has(tool.name) || ALWAYS_WHOLE_TOOLS.has(tool.name))) return tool;
  const content = Array.isArray(state.content) ? state.content : [];
  const metadata = isRecord(state.metadata) ? state.metadata : {};
  const { output: _output, ...keptMetadata } = metadata;
  if (content.length === 0 && _output === undefined) return tool;
  const envelope = isEnvelopeTool(tool.name) ? envelopeSummary(content) : undefined;
  if (envelope?.ok && ACTIONS_THE_CHAT_DRAWS_FROM_THEIR_RESULT.has(envelope.action)) return tool;
  const marker = envelope ? { chars: textLength(content), envelope } : { chars: textLength(content) };
  return {
    ...tool,
    state: {
      ...state,
      content: [{ type: 'text', text: '' }],
      metadata: { ...keptMetadata, [CONTENT_SHELL_METADATA_KEY]: marker },
    },
  };
};

const shellPart = <Part>(part: Part, keepWhole: ReadonlySet<string>) => {
  if (!isRecord(part)) return part;
  if (part.type === 'tool') return shellTool(part, keepWhole);
  if ((part.type === 'reasoning' || part.type === 'text') && 'native' in part) {
    const { native: _native, ...rest } = part;
    return rest;
  }
  return part;
};

const shellMessage = <Message>(message: Message, keepWhole: ReadonlySet<string>) => {
  if (!isRecord(message)) return message;
  const { native: _native, rawFinish: _rawFinish, snapshot: _snapshot, ...kept } = message;
  if (!Array.isArray(kept.content)) return kept;
  return { ...kept, content: kept.content.map((part) => shellPart(part, keepWhole)) };
};

export const shellMessagePage = <Payload>(payload: Payload, keepWhole: ReadonlySet<string>) => {
  if (!isRecord(payload) || !Array.isArray(payload.data)) return payload;
  return { ...payload, data: payload.data.map((message) => shellMessage(message, keepWhole)) };
};
