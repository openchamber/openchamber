/**
 * Map Claude Agent SDK messages → OpenCode-shaped canonical events.
 * Unknown event types are ignored safely (no throw).
 *
 * Part/message IDs use OpenCode ascending format so the UI Binary.search
 * ordering matches chronological stream order (random UUIDs break tool/text
 * interleaving in the transcript).
 */

import crypto from 'node:crypto';

const ID_RANDOM_CHARS = '0123456789ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz';
const ID_RANDOM_LENGTH = 14;

let lastIdTimestamp = 0;
let idCounter = 0;

/**
 * @param {number} length
 * @returns {string}
 */
function randomBase62(length) {
  const bytes = crypto.randomBytes(length);
  let result = '';
  for (let i = 0; i < length; i += 1) {
    result += ID_RANDOM_CHARS[bytes[i] % ID_RANDOM_CHARS.length];
  }
  return result;
}

/**
 * OpenCode-compatible ascending id (`msg_*` / `prt_*` / `perm_*` / `call_*`).
 * Lexicographic order matches creation order across the UI event reducer.
 *
 * @param {string} prefix
 * @returns {string}
 */
export function createOpenCodeId(prefix) {
  const now = Date.now();
  if (now !== lastIdTimestamp) {
    lastIdTimestamp = now;
    idCounter = 0;
  }
  idCounter += 1;

  const value = BigInt(now) * BigInt(0x1000) + BigInt(idCounter);
  const bytes = new Uint8Array(6);
  for (let i = 0; i < 6; i += 1) {
    bytes[i] = Number((value >> BigInt(40 - 8 * i)) & BigInt(0xff));
  }

  let hex = '';
  for (let i = 0; i < bytes.length; i += 1) {
    hex += bytes[i].toString(16).padStart(2, '0');
  }

  return `${prefix}_${hex}${randomBase62(ID_RANDOM_LENGTH)}`;
}

/** Test helper — reset ascending id clock state. */
export function resetOpenCodeIdState() {
  lastIdTimestamp = 0;
  idCounter = 0;
}

/**
 * @typedef {object} ClaudeMapperContext
 * @property {string} sessionId
 * @property {string} directory
 * @property {string} userMessageId
 * @property {string} assistantMessageId
 * @property {string} [modelRef]
 * @property {string} [textPartId]
 * @property {Map<string, { partId: string, toolName: string }>} [toolParts]
 * @property {string} [foreignSessionId]
 * @property {number} [assistantCreatedAt]
 * @property {string} [accumulatedText]
 * @property {boolean} [needsNewTextSegment]
 * @property {boolean} [textPartStarted]
 */

/**
 * @param {Partial<ClaudeMapperContext>} input
 * @returns {ClaudeMapperContext}
 */
export function createClaudeMapperContext(input) {
  /** @type {Map<string, { partId: string, toolName: string }>} */
  let toolParts = input.toolParts || new Map();
  // Back-compat for older callers/tests that passed toolPartIds: Map<callId, partId>
  if (!input.toolParts && input.toolPartIds instanceof Map) {
    toolParts = new Map();
    for (const [callId, partId] of input.toolPartIds.entries()) {
      toolParts.set(callId, { partId, toolName: 'tool' });
    }
  }

  return {
    sessionId: input.sessionId,
    directory: input.directory,
    userMessageId: input.userMessageId || createOpenCodeId('msg'),
    assistantMessageId: input.assistantMessageId || createOpenCodeId('msg'),
    modelRef: input.modelRef || 'sonnet',
    textPartId: input.textPartId || createOpenCodeId('prt'),
    toolParts,
    foreignSessionId: input.foreignSessionId,
    assistantCreatedAt: input.assistantCreatedAt || Date.now(),
    accumulatedText: input.accumulatedText || '',
    needsNewTextSegment: input.needsNewTextSegment === true,
    textPartStarted: input.textPartStarted === true || Boolean(input.accumulatedText),
  };
}

/**
 * @param {ClaudeMapperContext} ctx
 * @param {string} text
 * @param {Array<{ mime?: string, url?: string, filename?: string }>} [files]
 * @returns {object[]}
 */
export function buildUserMessageEvents(ctx, text, files) {
  const now = Date.now();
  const events = [
    {
      type: 'message.updated',
      properties: {
        info: {
          id: ctx.userMessageId,
          sessionID: ctx.sessionId,
          role: 'user',
          time: { created: now },
          agent: 'build',
          model: {
            providerID: 'claude-code',
            modelID: ctx.modelRef || 'sonnet',
          },
        },
      },
    },
    {
      type: 'message.part.updated',
      properties: {
        sessionID: ctx.sessionId,
        part: {
          id: createOpenCodeId('prt'),
          sessionID: ctx.sessionId,
          messageID: ctx.userMessageId,
          type: 'text',
          text: typeof text === 'string' ? text : '',
          time: { start: now, end: now },
        },
      },
    },
  ];

  if (Array.isArray(files)) {
    for (const file of files) {
      if (!file || typeof file !== 'object') continue;
      const mime = typeof file.mime === 'string' ? file.mime : '';
      const url = typeof file.url === 'string' ? file.url : '';
      const filename = typeof file.filename === 'string' && file.filename.trim()
        ? file.filename.trim()
        : 'attachment';
      if (!url) continue;
      events.push({
        type: 'message.part.updated',
        properties: {
          sessionID: ctx.sessionId,
          part: {
            id: createOpenCodeId('prt'),
            sessionID: ctx.sessionId,
            messageID: ctx.userMessageId,
            type: 'file',
            mime,
            url,
            filename,
            time: { start: now, end: now },
          },
        },
      });
    }
  }

  events.push({
    type: 'session.status',
    properties: {
      sessionID: ctx.sessionId,
      status: { type: 'busy' },
    },
  });

  return events;
}

/**
 * @param {ClaudeMapperContext} ctx
 * @returns {object}
 */
function assistantInfo(ctx, completed) {
  const info = {
    id: ctx.assistantMessageId,
    sessionID: ctx.sessionId,
    role: 'assistant',
    time: {
      created: ctx.assistantCreatedAt,
      ...(completed ? { completed: Date.now() } : {}),
    },
    parentID: ctx.userMessageId,
    modelID: ctx.modelRef || 'sonnet',
    providerID: 'claude-code',
    mode: 'build',
    agent: 'build',
    path: {
      cwd: ctx.directory,
      root: ctx.directory,
    },
    cost: 0,
    tokens: {
      input: 0,
      output: 0,
      reasoning: 0,
      cache: { read: 0, write: 0 },
    },
  };
  if (completed) info.finish = 'stop';
  return info;
}

/**
 * After a tool part, subsequent assistant text must use a fresh part id so the
 * transcript shows text → tools → text instead of merging all text above tools.
 *
 * @param {ClaudeMapperContext} ctx
 */
function beginNewTextSegment(ctx) {
  ctx.textPartId = createOpenCodeId('prt');
  ctx.accumulatedText = '';
  ctx.textPartStarted = false;
  ctx.needsNewTextSegment = false;
}

/**
 * @param {ClaudeMapperContext} ctx
 * @param {string} delta
 * @returns {object[]}
 */
function textDeltaEvents(ctx, delta) {
  if (typeof delta !== 'string' || !delta) return [];
  const events = [];

  if (ctx.needsNewTextSegment) {
    beginNewTextSegment(ctx);
  }

  if (!ctx.textPartStarted) {
    events.push({
      type: 'message.updated',
      properties: { info: assistantInfo(ctx, false) },
    });
    events.push({
      type: 'message.part.updated',
      properties: {
        sessionID: ctx.sessionId,
        part: {
          id: ctx.textPartId,
          sessionID: ctx.sessionId,
          messageID: ctx.assistantMessageId,
          type: 'text',
          text: '',
          time: { start: Date.now() },
        },
      },
    });
    ctx.textPartStarted = true;
  }

  ctx.accumulatedText = (ctx.accumulatedText || '') + delta;
  events.push({
    type: 'message.part.delta',
    properties: {
      sessionID: ctx.sessionId,
      messageID: ctx.assistantMessageId,
      partID: ctx.textPartId,
      field: 'text',
      delta,
    },
  });
  return events;
}

/**
 * @param {ClaudeMapperContext} ctx
 * @param {object} block
 * @returns {object[]}
 */
function mapContentBlock(ctx, block) {
  if (!block || typeof block !== 'object') return [];
  if (block.type === 'text' && typeof block.text === 'string') {
    // Prefer deltas for streaming; full text block fills when no partials arrived
    // for the current segment.
    if (!ctx.accumulatedText || ctx.needsNewTextSegment) {
      return textDeltaEvents(ctx, block.text);
    }
    const remainder = block.text.startsWith(ctx.accumulatedText)
      ? block.text.slice(ctx.accumulatedText.length)
      : '';
    if (remainder) return textDeltaEvents(ctx, remainder);
    return [];
  }

  if (block.type === 'tool_use') {
    const callId = typeof block.id === 'string' ? block.id : createOpenCodeId('call');
    let entry = ctx.toolParts.get(callId);
    if (!entry) {
      entry = {
        partId: createOpenCodeId('prt'),
        toolName: typeof block.name === 'string' && block.name.trim() ? block.name.trim() : 'tool',
      };
      ctx.toolParts.set(callId, entry);
    } else if (typeof block.name === 'string' && block.name.trim()) {
      entry.toolName = block.name.trim();
    }
    const input = block.input && typeof block.input === 'object' ? block.input : {};
    // Next assistant text belongs after this tool in transcript order.
    ctx.needsNewTextSegment = true;
    return [
      {
        type: 'message.updated',
        properties: { info: assistantInfo(ctx, false) },
      },
      {
        type: 'message.part.updated',
        properties: {
          sessionID: ctx.sessionId,
          part: {
            id: entry.partId,
            sessionID: ctx.sessionId,
            messageID: ctx.assistantMessageId,
            type: 'tool',
            callID: callId,
            tool: entry.toolName,
            state: {
              status: 'running',
              input,
              time: { start: Date.now() },
            },
          },
        },
      },
    ];
  }

  return [];
}

/**
 * @param {ClaudeMapperContext} ctx
 * @param {object} block
 * @returns {object[]}
 */
function mapToolResultBlock(ctx, block) {
  if (!block || block.type !== 'tool_result') return [];
  const callId = typeof block.tool_use_id === 'string' ? block.tool_use_id : '';
  if (!callId) return [];
  let entry = ctx.toolParts.get(callId);
  if (!entry) {
    entry = { partId: createOpenCodeId('prt'), toolName: 'tool' };
    ctx.toolParts.set(callId, entry);
  }
  const output = typeof block.content === 'string'
    ? block.content
    : Array.isArray(block.content)
      ? block.content.map((c) => (typeof c?.text === 'string' ? c.text : '')).join('\n')
      : '';
  const isError = block.is_error === true;
  return [
    {
      type: 'message.part.updated',
      properties: {
        sessionID: ctx.sessionId,
        part: {
          id: entry.partId,
          sessionID: ctx.sessionId,
          messageID: ctx.assistantMessageId,
          type: 'tool',
          callID: callId,
          tool: entry.toolName,
          state: isError
            ? {
              status: 'error',
              input: {},
              error: output || 'Tool error',
              time: { start: Date.now(), end: Date.now() },
            }
            : {
              status: 'completed',
              input: {},
              output: output || '',
              title: entry.toolName,
              metadata: {},
              time: { start: Date.now(), end: Date.now() },
            },
        },
      },
    },
  ];
}

/**
 * Finalize the current open text segment (if any).
 * @param {ClaudeMapperContext} ctx
 * @returns {object[]}
 */
function finalizeCurrentTextPart(ctx) {
  if (!ctx.textPartStarted) return [];
  return [{
    type: 'message.part.updated',
    properties: {
      sessionID: ctx.sessionId,
      part: {
        id: ctx.textPartId,
        sessionID: ctx.sessionId,
        messageID: ctx.assistantMessageId,
        type: 'text',
        text: ctx.accumulatedText || '',
        time: { start: ctx.assistantCreatedAt, end: Date.now() },
      },
    },
  }];
}

/**
 * Map one SDK message into zero or more canonical events.
 * Mutates ctx for streaming state (accumulated text, foreign id, tool ids).
 *
 * @param {ClaudeMapperContext} ctx
 * @param {object} message
 * @returns {{ events: object[], foreignSessionId?: string }}
 */
export function mapClaudeMessageToEvents(ctx, message) {
  if (!message || typeof message !== 'object') {
    return { events: [] };
  }

  const events = [];
  let foreignSessionId;

  if (typeof message.session_id === 'string' && message.session_id) {
    foreignSessionId = message.session_id;
    ctx.foreignSessionId = foreignSessionId;
  }

  switch (message.type) {
    case 'system': {
      if (message.subtype === 'init' && typeof message.session_id === 'string') {
        foreignSessionId = message.session_id;
        ctx.foreignSessionId = foreignSessionId;
      }
      break;
    }

    case 'stream_event': {
      const event = message.event;
      if (!event || typeof event !== 'object') break;
      if (event.type === 'content_block_delta') {
        const delta = event.delta;
        if (delta?.type === 'text_delta' && typeof delta.text === 'string') {
          events.push(...textDeltaEvents(ctx, delta.text));
        }
      } else if (event.type === 'content_block_start') {
        const block = event.content_block;
        if (block?.type === 'tool_use') {
          events.push(...mapContentBlock(ctx, block));
        } else if (block?.type === 'text') {
          if (ctx.needsNewTextSegment || !ctx.textPartStarted) {
            if (ctx.needsNewTextSegment) beginNewTextSegment(ctx);
            events.push({
              type: 'message.updated',
              properties: { info: assistantInfo(ctx, false) },
            });
            events.push({
              type: 'message.part.updated',
              properties: {
                sessionID: ctx.sessionId,
                part: {
                  id: ctx.textPartId,
                  sessionID: ctx.sessionId,
                  messageID: ctx.assistantMessageId,
                  type: 'text',
                  text: '',
                  time: { start: Date.now() },
                },
              },
            });
            ctx.textPartStarted = true;
          }
        }
      }
      break;
    }

    case 'assistant': {
      const content = message.message?.content;
      if (Array.isArray(content)) {
        for (const block of content) {
          events.push(...mapContentBlock(ctx, block));
        }
      }
      if (message.error) {
        events.push({
          type: 'session.status',
          properties: {
            sessionID: ctx.sessionId,
            status: { type: 'idle' },
          },
        });
        events.push({
          type: 'message.updated',
          properties: {
            info: {
              ...assistantInfo(ctx, true),
              error: {
                name: 'APIError',
                data: {
                  message: String(message.error),
                  isRetryable: message.error === 'rate_limit' || message.error === 'overloaded',
                },
              },
            },
          },
        });
      }
      break;
    }

    case 'user': {
      const content = message.message?.content;
      if (Array.isArray(content)) {
        for (const block of content) {
          events.push(...mapToolResultBlock(ctx, block));
        }
      }
      break;
    }

    case 'result': {
      const hasContent = ctx.textPartStarted || ctx.toolParts.size > 0
        || (typeof message.result === 'string' && message.result);

      if (ctx.textPartStarted) {
        events.push(...finalizeCurrentTextPart(ctx));
        events.push({
          type: 'message.updated',
          properties: { info: assistantInfo(ctx, true) },
        });
      } else if (typeof message.result === 'string' && message.result) {
        events.push(...textDeltaEvents(ctx, message.result));
        events.push(...finalizeCurrentTextPart(ctx));
        events.push({
          type: 'message.updated',
          properties: { info: assistantInfo(ctx, true) },
        });
      } else if (hasContent) {
        events.push({
          type: 'message.updated',
          properties: { info: assistantInfo(ctx, true) },
        });
      }

      const isError = message.is_error === true || (typeof message.subtype === 'string' && message.subtype.startsWith('error_'));
      events.push({
        type: 'session.status',
        properties: {
          sessionID: ctx.sessionId,
          status: { type: 'idle' },
        },
      });
      if (isError) {
        events.push({
          type: 'session.error',
          properties: {
            sessionID: ctx.sessionId,
          },
        });
      }
      break;
    }

    default:
      // Ignore unknown types safely.
      break;
  }

  return { events, foreignSessionId };
}
