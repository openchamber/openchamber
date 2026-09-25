const TURN_LIMIT = 3;
const PAGE_SIZE = 50;
const MAX_PAGES = 8;
const USER_CHAR_LIMIT = 8_000;
const ANSWER_CHAR_LIMIT = 16_000;

// Mirrors the persisted context contract owned by UI lib/messages/contextParts.ts.
// Read only the fields needed for model context; malformed attached text fails
// this generation instead of silently dropping the user's comment.
const QUOTE_FIELDS = new Map([
  ['code-comment', 'code'], ['file-quote', 'quote'], ['chat-quote', 'quote'],
  ['browser-annotation', 'prompt'], ['pr-comment', 'body'], ['pr-check', 'output'],
  ['terminal', 'output'],
]);
const LINK_KINDS = new Set(['github-issue', 'github-pr', 'linear-issue']);

export function excerpt(text, limit) {
  if (text.length <= limit) return text;
  const marker = '\n[Content omitted]\n';
  if (limit <= marker.length) return text.slice(0, Math.max(0, limit));
  const head = Math.ceil((limit - marker.length) / 2);
  const tail = limit - marker.length - head;
  return text.slice(0, head) + marker + (tail > 0 ? text.slice(-tail) : '');
}

function attachedText(message) {
  const context = message.metadata?.openchamberContext;
  if (QUOTE_FIELDS.has(context?.kind)) {
    const source = (context[QUOTE_FIELDS.get(context.kind)] ?? '').trim();
    const authored = (context.text ?? '').trim();
    const label = excerpt((context.fileLabel ?? context.label ?? context.pageUrl ?? context.terminalLabel ?? '').trim(), 300);
    const location = Number.isInteger(context.startLine) ? `, lines ${context.startLine}-${context.endLine ?? context.startLine}` : '';
    const quote = excerpt(source, 4_000).split('\n').map((line) => `> ${line}`).join('\n');
    return { text: `Attached ${context.kind}${label ? ` (${label}${location})` : ''}:\n${quote}\n\nUser comment:\n${excerpt(authored, USER_CHAR_LIMIT)}`, authored };
  }
  if (LINK_KINDS.has(context?.kind)) return { text: excerpt(message.text ?? '', USER_CHAR_LIMIT), authored: '' };
  const comment = message.metadata?.opencodeComment;
  if (comment) {
    const authored = comment.comment.trim();
    const source = (comment.preview ?? '').trim();
    const label = excerpt((comment.path ?? '').trim(), 300);
    return { text: `Attached file context (${label}):\n${excerpt(source, 4_000)}\n\nUser comment:\n${excerpt(authored, USER_CHAR_LIMIT)}`, authored };
  }
  return null;
}

// Records OpenCode appends around a turn that carry no conversation content:
// the `idle` marker that closes every turn and the agent/model/location
// switches. They are invisible to turn boundaries and to "what is the newest
// message". An `idle` whose outcome is not `succeeded` is not transparent: it
// is the evidence that the turn failed or was interrupted.
const TRANSPARENT_TYPES = new Set(['agent-switched', 'model-switched', 'location-switched']);

function isTransparent(record) {
  if (record?.type === 'idle') return record.outcome === 'succeeded';
  return TRANSPARENT_TYPES.has(record?.type);
}

/**
 * The id of the newest record that is conversation content, given a page in
 * v2's newest-first order; null when the page holds only service records.
 * Both the assist reader and the pre-write re-check use it so they agree on
 * what "the last message" is.
 */
export function newestContentId(records) {
  for (const record of Array.isArray(records) ? records : []) {
    if (!record?.id || isTransparent(record)) continue;
    return record.id;
  }
  return null;
}

/**
 * v2 message records are flat: an assistant message carries `content[]`, a user
 * message a single `text` plus its attachments, and context items that used to
 * ride along as `synthetic` text parts are their own `synthetic` messages now.
 * Tool payloads never enter this view.
 */
function readMessage(message) {
  const role = message.type;
  const blocks = [];
  const authored = [];

  if (role === 'user') {
    const attached = attachedText(message);
    if (attached) {
      blocks.push(attached.text);
      authored.push(attached.authored);
    } else if (typeof message.text === 'string') {
      blocks.push(message.text);
      // Legacy terminal selections are source material, not a language sample.
      authored.push(message.text.replace(/\n*<terminal_context>\n[\s\S]*?\n<\/terminal_context>\s*$/, ''));
    }
  } else if (role === 'assistant') {
    for (const part of Array.isArray(message.content) ? message.content : []) {
      if (part?.type === 'text' && typeof part.text === 'string') blocks.push(part.text);
    }
  } else if (role === 'synthetic') {
    // Context the user attached to the message that follows: in v1 it was a
    // `synthetic` text part inside the user message, in v2 it is its own turn.
    const attached = attachedText(message);
    if (attached) {
      blocks.push(attached.text);
      authored.push(attached.authored);
    } else if (typeof message.text === 'string') {
      blocks.push(message.text);
    }
  }

  return {
    id: message.id,
    role,
    transparent: isTransparent(message),
    // v2 has no `parentID` on a message: a turn is the run of messages between
    // one user message and the assistant reply that follows it, which is what
    // `collectTurns` walks.
    providerID: message.model?.providerID,
    modelID: message.model?.id,
    complete: role === 'assistant'
      && message.finish === 'stop'
      && Boolean(message.time?.completed)
      && !message.error,
    text: excerpt(blocks.join('\n\n').trim(), role === 'user' ? USER_CHAR_LIMIT : ANSWER_CHAR_LIMIT),
    authored: excerpt(authored.filter(Boolean).join('\n\n').trim(), USER_CHAR_LIMIT),
  };
}

/**
 * A turn is one user message and the assistant reply that closes it. v2 dropped
 * `parentID`, so the boundary is positional: everything between two user
 * messages belongs to the turn the earlier one opened.
 *
 * Synthetic messages are the context the user attached to the message they are
 * about to send — v1 carried them as parts of that user message — so they are
 * folded into the next user message instead of opening a turn of their own.
 */
function collectTurns(messages) {
  const turns = [];
  let active = null;
  let attached = [];
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
      active = { user: { ...message, text, authored }, assistant: null, complete: false };
      turns.push(active);
      continue;
    }
    attached = [];
    if (!active || message.role !== 'assistant') continue;
    if (message.text) active.assistant = message;
    active.complete = message.complete && Boolean(message.text);
  }
  return turns.slice(-TURN_LIMIT);
}

/** Failure is thrown; null means no eligible final answer within bounded history. */
export async function loadAssistContext({ readPage, signal }) {
  let messages = [];
  let cursor;
  const cursors = new Set();
  const ids = new Set();
  for (let pageNumber = 0; pageNumber < MAX_PAGES; pageNumber++) {
    signal.throwIfAborted();
    // v2 pages messages newest first and returns `{ data, cursor }`.
    const page = await readPage({ limit: PAGE_SIZE, cursor });
    signal.throwIfAborted();
    if (!Array.isArray(page?.data)) throw new Error('Session message page is unavailable');
    const older = [];
    for (const record of page.data) {
      if (!record?.id || ids.has(record.id)) continue;
      ids.add(record.id);
      older.push(readMessage(record));
    }
    older.reverse();
    messages = older.concat(messages);
    const next = typeof page.cursor?.next === 'string' ? page.cursor.next : null;
    // A successful turn ends with an `idle` marker after the answer; look past
    // it and its siblings to the newest content record.
    const last = messages.findLast((message) => !message.transparent);
    if (!last) {
      if (!next || pageNumber === MAX_PAGES - 1) return null;
    } else {
      if (!last.complete || !last.text) return null;
      const turns = collectTurns(messages);
      if (turns.length === TURN_LIMIT || !next || pageNumber === MAX_PAGES - 1) {
        if (!turns.at(-1)?.complete || turns.at(-1).assistant.id !== last.id) return null;
        return { turns, last };
      }
    }
    if (cursors.has(next)) throw new Error('Session message pagination made no progress');
    cursors.add(next);
    cursor = next;
  }
  return null;
}
