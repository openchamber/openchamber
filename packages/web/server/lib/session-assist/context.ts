const TURN_LIMIT = 3;
const PAGE_SIZE = 50;
const MAX_PAGES = 8;
const USER_CHAR_LIMIT = 8_000;
const ANSWER_CHAR_LIMIT = 16_000;

const QUOTE_FIELDS = new Map([
  ['code-comment', 'code'], ['file-quote', 'quote'], ['chat-quote', 'quote'],
  ['browser-annotation', 'prompt'], ['pr-comment', 'body'], ['pr-check', 'output'],
  ['terminal', 'output'],
]);
const LINK_KINDS = new Set([
  'repository-issue', 'repository-discussion', 'change-request', 'tracker-item', 'github-issue', 'github-pr', 'linear-issue',
]);

export function excerpt(text: string, limit: number) {
  if (text.length <= limit) return text;
  const marker = '\n[Content omitted]\n';
  if (limit <= marker.length) return text.slice(0, Math.max(0, limit));
  const head = Math.ceil((limit - marker.length) / 2);
  const tail = limit - marker.length - head;
  return text.slice(0, head) + marker + (tail > 0 ? text.slice(-tail) : '');
}

type AssistRecord = Pick<SessionMessageAssistant, 'id' | 'metadata'> & {
  type: SessionMessagesResponse['data'][number]['type'];
  time?: { created?: number; completed?: number };
  outcome?: string;
  text?: string;
  model?: SessionMessageAssistant['model'];
  content?: ReadonlyArray<{ type: string; text?: string }>;
  snapshot?: SessionMessageAssistant['snapshot'];
  finish?: SessionMessageAssistant['finish'];
  error?: SessionMessageAssistant['error'];
};

export interface PageReader {
  readPage: (options: { limit: number; cursor: string | undefined }) => Promise<{
    data: readonly AssistRecord[];
    cursor?: SessionMessagesResponse['cursor'];
  }>;
  signal: AbortSignal;
}

const isAttachment = (value: JsonValue | undefined): value is { [key: string]: JsonValue; kind: string } =>
  isRecord(value) && isString(value.kind);

const isComment = (value: JsonValue): value is { comment?: JsonValue; preview?: JsonValue; path?: JsonValue } =>
  isRecord(value);

function trimAttachment(value: JsonValue | undefined) {
  if (!isString(value)) throw new TypeError('Attachment text must be a string');
  return value.trim();
}

function attachedText(message: AssistRecord) {
  const rawContext = message.metadata?.openchamberContext;
  const context = isAttachment(rawContext) ? rawContext : null;
  const field = context ? QUOTE_FIELDS.get(context.kind) : undefined;
  if (context && field !== undefined) {
    const source = trimAttachment(context[field] ?? '');
    const authored = trimAttachment(context.text ?? '');
    const label = excerpt(trimAttachment(context.fileLabel ?? context.label ?? context.pageUrl ?? context.terminalLabel ?? ''), 300);
    const location = Number.isInteger(context.startLine) ? `, lines ${context.startLine}-${context.endLine ?? context.startLine}` : '';
    const quote = excerpt(source, 4_000).split('\n').map((line) => `> ${line}`).join('\n');
    return { text: `Attached ${context.kind}${label ? ` (${label}${location})` : ''}:\n${quote}\n\nUser comment:\n${excerpt(authored, USER_CHAR_LIMIT)}`, authored };
  }
  if (context && LINK_KINDS.has(context.kind)) return { text: excerpt(message.text ?? '', USER_CHAR_LIMIT), authored: '' };
  const comment = message.metadata?.opencodeComment;
  if (comment) {
    if (!isComment(comment)) throw new TypeError('Attachment text must be a string');
    const authored = trimAttachment(comment.comment);
    const source = trimAttachment(comment.preview ?? '');
    const label = excerpt(trimAttachment(comment.path ?? ''), 300);
    return { text: `Attached file context (${label}):\n${excerpt(source, 4_000)}\n\nUser comment:\n${excerpt(authored, USER_CHAR_LIMIT)}`, authored };
  }
  return null;
}

const TRANSPARENT_TYPES = new Set(['agent-switched', 'model-switched', 'location-switched']);

function isTransparent(record: AssistRecord | undefined) {
  if (record?.type === 'idle') return record.outcome === 'succeeded';
  return record != null && TRANSPARENT_TYPES.has(record.type);
}

export function newestContentId(records: SessionMessagesResponse['data'] | undefined) {
  const page: SessionMessagesResponse['data'] = Array.isArray(records) ? records : [];
  for (const record of page) {
    if (!record?.id || isTransparent(record)) continue;
    return record.id;
  }
  return null;
}

function readMessage(message: AssistRecord): AssistMessage {
  const role = message.type;
  const blocks = [];
  const authored = [];

  if (role === 'user') {
    const attached = attachedText(message);
    if (attached) {
      blocks.push(attached.text);
      authored.push(attached.authored);
    } else if (isString(message.text)) {
      blocks.push(message.text);
      authored.push(message.text.replace(/\n*<terminal_context>\n[\s\S]*?\n<\/terminal_context>\s*$/, ''));
    }
  } else if (role === 'assistant') {
    const content: NonNullable<AssistRecord['content']> = Array.isArray(message.content) ? message.content : [];
    for (const part of content) {
      if (part?.type === 'text' && isString(part.text)) blocks.push(part.text);
    }
  } else if (role === 'synthetic') {
    const attached = attachedText(message);
    if (attached) {
      blocks.push(attached.text);
      authored.push(attached.authored);
    } else if (isString(message.text)) {
      blocks.push(message.text);
    }
  }

  return {
    id: message.id,
    role,
    created: Number.isFinite(message.time?.created) ? message.time?.created ?? null : null,
    completed: Number.isFinite(message.time?.completed) ? message.time?.completed ?? null : null,
    transparent: isTransparent(message),
    providerID: message.model?.providerID,
    modelID: message.model?.id,
    snapshotFiles: role === 'assistant' && Array.isArray(message.snapshot?.files) ? message.snapshot.files : null,
    complete: role === 'assistant'
      && message.finish === 'stop'
      && Boolean(message.time?.completed)
      && !message.error,
    text: excerpt(blocks.join('\n\n').trim(), role === 'user' ? USER_CHAR_LIMIT : ANSWER_CHAR_LIMIT),
    authored: excerpt(authored.filter(Boolean).join('\n\n').trim(), USER_CHAR_LIMIT),
  };
}

function collectTurns(messages: AssistMessage[]) {
  const turns: AssistTurn[] = [];
  let active: AssistTurn | null = null;
  let attached: AssistMessage[] = [];
  for (const message of messages) {
    if (message.transparent) continue;
    if (message.role === 'synthetic') {
      if (message.text) attached.push(message);
      continue;
    }
    if (message.role === 'user') {
      const text = [...attached.map((entry) => entry.text), message.text].filter(Boolean).join('\n\n');
      const authored = [...attached.map((entry) => entry.authored), message.authored].filter(Boolean).join('\n\n');
      attached = [];
      if (!text) continue;
      active = { user: { ...message, text, authored }, assistant: null, complete: false, changedFiles: null };
      turns.push(active);
      continue;
    }
    attached = [];
    if (!active || message.role !== 'assistant') continue;
    if (message.snapshotFiles) active.changedFiles = new Set([...(active.changedFiles ?? []), ...message.snapshotFiles]);
    if (message.text) active.assistant = message;
    active.complete = message.complete && Boolean(message.text);
  }
  return turns.slice(-TURN_LIMIT);
}

function hasCompletedTail(turns: AssistTurn[], last: AssistMessage): turns is CompletedAssistTurns {
  const finalTurn = turns.at(-1);
  return finalTurn?.complete === true && finalTurn.assistant?.id === last.id;
}

export async function loadAssistContext({ readPage, signal }: PageReader): Promise<AssistContext | null> {
  let messages: AssistMessage[] = [];
  let cursor: string | undefined;
  const cursors = new Set<string>();
  const ids = new Set<string>();
  for (let pageNumber = 0; pageNumber < MAX_PAGES; pageNumber++) {
    signal.throwIfAborted();
    const page = await readPage({ limit: PAGE_SIZE, cursor });
    signal.throwIfAborted();
    if (!Array.isArray(page?.data)) throw new Error('Session message page is unavailable');
    const older: AssistMessage[] = [];
    const records: readonly AssistRecord[] = page.data;
    for (const record of records) {
      if (!record?.id || ids.has(record.id)) continue;
      ids.add(record.id);
      older.push(readMessage(record));
    }
    older.reverse();
    messages = older.concat(messages);
    const next = isString(page.cursor?.next) ? page.cursor.next : null;
    const last = messages.findLast((message) => !message.transparent);
    if (!last) {
      if (!next || pageNumber === MAX_PAGES - 1) return null;
    } else {
      if (!last.complete || !last.text) return null;
      const turns = collectTurns(messages);
      if (turns.length === TURN_LIMIT || !next || pageNumber === MAX_PAGES - 1) {
        if (!hasCompletedTail(turns, last)) return null;
        return { turns, last };
      }
    }
    if (cursors.has(next)) throw new Error('Session message pagination made no progress');
    cursors.add(next);
    cursor = next;
  }
  return null;
}
import type { JsonValue, SessionMessageAssistant, SessionMessagesResponse } from '@opencode/client';
import { isRecord, isString } from '../shared/guards.js';
import type { AssistContext, AssistMessage, AssistTurn, CompletedAssistTurns } from './contracts.js';
