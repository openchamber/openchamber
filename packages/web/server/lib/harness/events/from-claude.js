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
 * @property {Map<string, { partId: string, toolName: string, input: object }>} [toolParts]
 * @property {string} [foreignSessionId]
 * @property {number} [assistantCreatedAt]
 * @property {string} [accumulatedText]
 * @property {boolean} [needsNewTextSegment]
 * @property {boolean} [textPartStarted]
 * @property {string} [reasoningPartId]
 * @property {string} [accumulatedReasoning]
 * @property {boolean} [needsNewReasoningSegment]
 * @property {boolean} [reasoningPartStarted]
 * @property {Map<string, {
 *   sessionId: string,
 *   assistantMessageId: string,
 *   userMessageId: string,
 *   title: string,
 *   textPartId: string,
 *   reasoningPartId: string,
 *   toolParts: Map<string, { partId: string, toolName: string, input: object, settled?: boolean }>,
 *   accumulatedText: string,
 *   textPartStarted: boolean,
 *   needsNewTextSegment: boolean,
 *   accumulatedReasoning: string,
 *   reasoningPartStarted: boolean,
 *   needsNewReasoningSegment: boolean,
 *   created: boolean,
 * }>} [subagentByToolUseId]
 * @property {object | null} [lastInitCapabilities]
 */

/**
 * Streamed assistant segments share one shape: an OpenCode part that grows by
 * deltas until a tool (or the turn end) closes it. Keyed by part type so text
 * and reasoning do not need parallel implementations.
 */
const SEGMENT_FIELDS = {
  text: {
    partId: 'textPartId',
    accumulated: 'accumulatedText',
    started: 'textPartStarted',
    needsNew: 'needsNewTextSegment',
  },
  reasoning: {
    partId: 'reasoningPartId',
    accumulated: 'accumulatedReasoning',
    started: 'reasoningPartStarted',
    needsNew: 'needsNewReasoningSegment',
  },
};

/**
 * @param {Partial<ClaudeMapperContext>} input
 * @returns {ClaudeMapperContext}
 */
export function createClaudeMapperContext(input) {
  /** @type {Map<string, { partId: string, toolName: string, input: object }>} */
  let toolParts = input.toolParts || new Map();
  // Back-compat for older callers/tests that passed toolPartIds: Map<callId, partId>
  if (!input.toolParts && input.toolPartIds instanceof Map) {
    toolParts = new Map();
    for (const [callId, partId] of input.toolPartIds.entries()) {
      toolParts.set(callId, { partId, toolName: 'tool', input: {} });
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
    reasoningPartId: input.reasoningPartId || createOpenCodeId('prt'),
    accumulatedReasoning: input.accumulatedReasoning || '',
    needsNewReasoningSegment: input.needsNewReasoningSegment === true,
    reasoningPartStarted: input.reasoningPartStarted === true
      || Boolean(input.accumulatedReasoning),
    subagentByToolUseId: input.subagentByToolUseId || new Map(),
    lastInitCapabilities: input.lastInitCapabilities || null,
    tokens: input.tokens && typeof input.tokens === 'object'
      ? input.tokens
      : { input: 0, output: 0, reasoning: 0, cache: { read: 0, write: 0 } },
    cost: Number.isFinite(input.cost) ? input.cost : 0,
  };
}

/**
 * Deterministic child session id for a Claude Agent tool_use call.
 * @param {string} parentSessionId
 * @param {string} toolUseId
 * @returns {string}
 */
export function claudeSubagentSessionId(parentSessionId, toolUseId) {
  const safeTool = String(toolUseId || 'agent').replace(/[^a-zA-Z0-9_-]/g, '').slice(0, 24) || 'agent';
  return `ses_claude_sub_${parentSessionId.slice(-12)}_${safeTool}`;
}

/**
 * @param {ClaudeMapperContext} parentCtx
 * @param {string} toolUseId
 * @param {string} [title]
 */
function ensureSubagentContext(parentCtx, toolUseId, title) {
  if (!toolUseId) return null;
  let child = parentCtx.subagentByToolUseId.get(toolUseId);
  if (child) {
    if (title && title.trim() && child.title === 'Subagent') {
      child.title = title.trim().slice(0, 120);
    }
    return child;
  }
  const sessionId = claudeSubagentSessionId(parentCtx.sessionId, toolUseId);
  child = {
    sessionId,
    assistantMessageId: createOpenCodeId('msg'),
    userMessageId: createOpenCodeId('msg'),
    title: (typeof title === 'string' && title.trim() ? title.trim() : 'Subagent').slice(0, 120),
    textPartId: createOpenCodeId('prt'),
    reasoningPartId: createOpenCodeId('prt'),
    toolParts: new Map(),
    accumulatedText: '',
    textPartStarted: false,
    needsNewTextSegment: false,
    accumulatedReasoning: '',
    reasoningPartStarted: false,
    needsNewReasoningSegment: false,
    created: false,
  };
  parentCtx.subagentByToolUseId.set(toolUseId, child);
  return child;
}

/**
 * @param {ClaudeMapperContext} parentCtx
 * @param {ReturnType<typeof ensureSubagentContext>} child
 * @returns {object[]}
 */
function buildSubagentCreatedEvents(parentCtx, child) {
  if (!child || child.created) return [];
  child.created = true;
  const now = Date.now();
  return [{
    type: 'session.created',
    properties: {
      info: {
        id: child.sessionId,
        parentID: parentCtx.sessionId,
        title: child.title,
        time: { created: now, updated: now },
      },
    },
  }];
}

/**
 * Temporarily project a child subagent onto the mapper context fields that
 * content-block helpers read/write, then restore.
 *
 * @param {ClaudeMapperContext} parentCtx
 * @param {NonNullable<ReturnType<typeof ensureSubagentContext>>} child
 * @param {() => object[]} fn
 * @returns {object[]}
 */
function withSubagentContext(parentCtx, child, fn) {
  const snapshot = {
    sessionId: parentCtx.sessionId,
    assistantMessageId: parentCtx.assistantMessageId,
    userMessageId: parentCtx.userMessageId,
    textPartId: parentCtx.textPartId,
    reasoningPartId: parentCtx.reasoningPartId,
    toolParts: parentCtx.toolParts,
    accumulatedText: parentCtx.accumulatedText,
    textPartStarted: parentCtx.textPartStarted,
    needsNewTextSegment: parentCtx.needsNewTextSegment,
    accumulatedReasoning: parentCtx.accumulatedReasoning,
    reasoningPartStarted: parentCtx.reasoningPartStarted,
    needsNewReasoningSegment: parentCtx.needsNewReasoningSegment,
  };

  parentCtx.sessionId = child.sessionId;
  parentCtx.assistantMessageId = child.assistantMessageId;
  parentCtx.userMessageId = child.userMessageId;
  parentCtx.textPartId = child.textPartId;
  parentCtx.reasoningPartId = child.reasoningPartId;
  parentCtx.toolParts = child.toolParts;
  parentCtx.accumulatedText = child.accumulatedText;
  parentCtx.textPartStarted = child.textPartStarted;
  parentCtx.needsNewTextSegment = child.needsNewTextSegment;
  parentCtx.accumulatedReasoning = child.accumulatedReasoning;
  parentCtx.reasoningPartStarted = child.reasoningPartStarted;
  parentCtx.needsNewReasoningSegment = child.needsNewReasoningSegment;

  try {
    return fn();
  } finally {
    child.textPartId = parentCtx.textPartId;
    child.reasoningPartId = parentCtx.reasoningPartId;
    child.toolParts = parentCtx.toolParts;
    child.accumulatedText = parentCtx.accumulatedText;
    child.textPartStarted = parentCtx.textPartStarted;
    child.needsNewTextSegment = parentCtx.needsNewTextSegment;
    child.accumulatedReasoning = parentCtx.accumulatedReasoning;
    child.reasoningPartStarted = parentCtx.reasoningPartStarted;
    child.needsNewReasoningSegment = parentCtx.needsNewReasoningSegment;

    parentCtx.sessionId = snapshot.sessionId;
    parentCtx.assistantMessageId = snapshot.assistantMessageId;
    parentCtx.userMessageId = snapshot.userMessageId;
    parentCtx.textPartId = snapshot.textPartId;
    parentCtx.reasoningPartId = snapshot.reasoningPartId;
    parentCtx.toolParts = snapshot.toolParts;
    parentCtx.accumulatedText = snapshot.accumulatedText;
    parentCtx.textPartStarted = snapshot.textPartStarted;
    parentCtx.needsNewTextSegment = snapshot.needsNewTextSegment;
    parentCtx.accumulatedReasoning = snapshot.accumulatedReasoning;
    parentCtx.reasoningPartStarted = snapshot.reasoningPartStarted;
    parentCtx.needsNewReasoningSegment = snapshot.needsNewReasoningSegment;
  }
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
 * Map Claude Agent SDK usage into OpenCode-shaped token counters.
 * Goal budgets read `input + cache.read + output` from the latest assistant.
 *
 * @param {unknown} usage
 * @returns {{ input: number, output: number, reasoning: number, cache: { read: number, write: number } }}
 */
export function mapClaudeUsageToTokens(usage) {
  const source = usage && typeof usage === 'object' ? usage : {};
  const num = (value) => {
    const n = Number(value);
    return Number.isFinite(n) && n > 0 ? Math.floor(n) : 0;
  };
  return {
    input: num(source.input_tokens ?? source.inputTokens),
    output: num(source.output_tokens ?? source.outputTokens),
    reasoning: num(source.reasoning_tokens ?? source.reasoningTokens),
    cache: {
      read: num(
        source.cache_read_input_tokens
        ?? source.cacheReadInputTokens
        ?? source.cache_read_tokens,
      ),
      write: num(
        source.cache_creation_input_tokens
        ?? source.cacheCreationInputTokens
        ?? source.cache_write_tokens,
      ),
    },
  };
}

/**
 * @param {ClaudeMapperContext} ctx
 * @param {unknown} usage
 * @param {unknown} [totalCostUsd]
 */
function applyUsageToContext(ctx, usage, totalCostUsd) {
  if (usage && typeof usage === 'object') {
    ctx.tokens = mapClaudeUsageToTokens(usage);
  }
  const cost = Number(totalCostUsd);
  if (Number.isFinite(cost) && cost >= 0) {
    ctx.cost = cost;
  }
}

function assistantInfo(ctx, completed) {
  const tokens = ctx.tokens && typeof ctx.tokens === 'object'
    ? ctx.tokens
    : { input: 0, output: 0, reasoning: 0, cache: { read: 0, write: 0 } };
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
    cost: Number.isFinite(ctx.cost) ? ctx.cost : 0,
    tokens: {
      input: Number.isFinite(tokens.input) ? tokens.input : 0,
      output: Number.isFinite(tokens.output) ? tokens.output : 0,
      reasoning: Number.isFinite(tokens.reasoning) ? tokens.reasoning : 0,
      cache: {
        read: Number.isFinite(tokens.cache?.read) ? tokens.cache.read : 0,
        write: Number.isFinite(tokens.cache?.write) ? tokens.cache.write : 0,
      },
    },
  };
  if (completed) info.finish = 'stop';
  return info;
}

/**
 * After a tool part, subsequent assistant output must use a fresh part id so the
 * transcript shows text → tools → text instead of merging all text above tools.
 *
 * @param {ClaudeMapperContext} ctx
 * @param {'text' | 'reasoning'} kind
 */
function beginNewSegment(ctx, kind) {
  const field = SEGMENT_FIELDS[kind];
  ctx[field.partId] = createOpenCodeId('prt');
  ctx[field.accumulated] = '';
  ctx[field.started] = false;
  ctx[field.needsNew] = false;
}

/**
 * Open the segment part if needed, then emit one growth delta.
 *
 * @param {ClaudeMapperContext} ctx
 * @param {'text' | 'reasoning'} kind
 * @param {string} delta
 * @returns {object[]}
 */
function segmentDeltaEvents(ctx, kind, delta) {
  if (typeof delta !== 'string' || !delta) return [];
  const field = SEGMENT_FIELDS[kind];
  const events = [];

  if (ctx[field.needsNew]) {
    beginNewSegment(ctx, kind);
  }

  if (!ctx[field.started]) {
    events.push(...startSegmentEvents(ctx, kind));
  }

  ctx[field.accumulated] = (ctx[field.accumulated] || '') + delta;
  events.push({
    type: 'message.part.delta',
    properties: {
      sessionID: ctx.sessionId,
      messageID: ctx.assistantMessageId,
      partID: ctx[field.partId],
      field: 'text',
      delta,
    },
  });
  return events;
}

/**
 * Emit the assistant-message + empty-part pair that opens a segment.
 *
 * @param {ClaudeMapperContext} ctx
 * @param {'text' | 'reasoning'} kind
 * @returns {object[]}
 */
function startSegmentEvents(ctx, kind) {
  const field = SEGMENT_FIELDS[kind];
  ctx[field.started] = true;
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
          id: ctx[field.partId],
          sessionID: ctx.sessionId,
          messageID: ctx.assistantMessageId,
          type: kind,
          text: '',
          time: { start: Date.now() },
        },
      },
    },
  ];
}

/**
 * Reconcile a complete content block against what streaming already emitted.
 *
 * Deltas are preferred while streaming; the full block fills in when no partials
 * arrived. When the full block diverges from the accumulated stream (rather than
 * merely extending it) the segment is rewritten wholesale — dropping the block
 * would silently lose the tail.
 *
 * @param {ClaudeMapperContext} ctx
 * @param {'text' | 'reasoning'} kind
 * @param {string} full
 * @returns {object[]}
 */
function segmentCompletionEvents(ctx, kind, full) {
  const field = SEGMENT_FIELDS[kind];
  const accumulated = ctx[field.accumulated] || '';

  if (!accumulated || ctx[field.needsNew]) {
    return segmentDeltaEvents(ctx, kind, full);
  }
  if (full.startsWith(accumulated)) {
    const remainder = full.slice(accumulated.length);
    return remainder ? segmentDeltaEvents(ctx, kind, remainder) : [];
  }

  ctx[field.accumulated] = full;
  const events = ctx[field.started] ? [] : startSegmentEvents(ctx, kind);
  events.push(...finalizeSegment(ctx, kind));
  return events;
}

/**
 * @param {ClaudeMapperContext} ctx
 * @param {string} delta
 * @returns {object[]}
 */
function textDeltaEvents(ctx, delta) {
  return segmentDeltaEvents(ctx, 'text', delta);
}

/**
 * @param {ClaudeMapperContext} ctx
 * @param {object} block
 * @returns {object[]}
 */
function mapContentBlock(ctx, block) {
  if (!block || typeof block !== 'object') return [];
  if (block.type === 'text' && typeof block.text === 'string') {
    return segmentCompletionEvents(ctx, 'text', block.text);
  }

  // Extended thinking is requested via the `effort` option; surface it as an
  // OpenCode reasoning part instead of dropping it. Redacted thinking carries
  // no readable text, so it is skipped.
  if (block.type === 'thinking' && typeof block.thinking === 'string') {
    return segmentCompletionEvents(ctx, 'reasoning', block.thinking);
  }

  if (block.type === 'tool_use') {
    const callId = typeof block.id === 'string' ? block.id : createOpenCodeId('call');
    let entry = ctx.toolParts.get(callId);
    if (!entry) {
      entry = {
        partId: createOpenCodeId('prt'),
        toolName: typeof block.name === 'string' && block.name.trim() ? block.name.trim() : 'tool',
        input: {},
      };
      ctx.toolParts.set(callId, entry);
    } else if (typeof block.name === 'string' && block.name.trim()) {
      entry.toolName = block.name.trim();
    }
    const input = block.input && typeof block.input === 'object' ? block.input : {};
    // Retained so the completed/error state can echo the same arguments — the UI
    // reducer replaces `part.state` wholesale, so omitting them blanks the args.
    if (Object.keys(input).length > 0 || !entry.input) entry.input = input;
    // Next assistant output belongs after this tool in transcript order.
    ctx.needsNewTextSegment = true;
    ctx.needsNewReasoningSegment = true;

    const events = [
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

    // Claude Agent tool → nested OpenChamber child session (subagent UI).
    const isAgentTool = entry.toolName === 'Agent' || entry.toolName === 'Task';
    if (isAgentTool && callId) {
      const description = typeof input.description === 'string' && input.description.trim()
        ? input.description.trim()
        : typeof input.prompt === 'string' && input.prompt.trim()
          ? input.prompt.trim().slice(0, 80)
          : typeof input.subagent_type === 'string' && input.subagent_type.trim()
            ? input.subagent_type.trim()
            : 'Subagent';
      const child = ensureSubagentContext(ctx, callId, description);
      events.unshift(...buildSubagentCreatedEvents(ctx, child));
      events[events.length - 1].properties.part.state.metadata = {
        sessionId: child.sessionId,
        title: child.title,
      };
    }

    return events;
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
    entry = { partId: createOpenCodeId('prt'), toolName: 'tool', input: {} };
    ctx.toolParts.set(callId, entry);
  }
  const input = entry.input && typeof entry.input === 'object' ? entry.input : {};
  entry.settled = true;
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
              input,
              error: output || 'Tool error',
              time: { start: Date.now(), end: Date.now() },
            }
            : {
              status: 'completed',
              input,
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
 * Finalize one open segment (if any) by writing its complete text.
 *
 * @param {ClaudeMapperContext} ctx
 * @param {'text' | 'reasoning'} kind
 * @returns {object[]}
 */
function finalizeSegment(ctx, kind) {
  const field = SEGMENT_FIELDS[kind];
  if (!ctx[field.started]) return [];
  return [{
    type: 'message.part.updated',
    properties: {
      sessionID: ctx.sessionId,
      part: {
        id: ctx[field.partId],
        sessionID: ctx.sessionId,
        messageID: ctx.assistantMessageId,
        type: kind,
        text: ctx[field.accumulated] || '',
        time: { start: ctx.assistantCreatedAt, end: Date.now() },
      },
    },
  }];
}

/**
 * Finalize every open assistant segment. Reasoning closes before text so the
 * transcript keeps thinking above the answer it produced.
 *
 * @param {ClaudeMapperContext} ctx
 * @returns {object[]}
 */
function finalizeOpenSegments(ctx) {
  return [...finalizeSegment(ctx, 'reasoning'), ...finalizeSegment(ctx, 'text')];
}

/**
 * Terminal events for a turn cut short by abort.
 *
 * Without these, every tool part left `running` and the open text/reasoning
 * segment keep their spinner in the transcript forever — the abort marker lands
 * on a fresh message and never closes the parts already on screen.
 *
 * @param {ClaudeMapperContext} ctx
 * @param {string} [reason]
 * @returns {object[]}
 */
export function buildTurnAbortEvents(ctx, reason = 'Aborted by user') {
  if (!ctx || typeof ctx !== 'object') return [];
  const events = finalizeOpenSegments(ctx);
  const now = Date.now();

  for (const [callId, entry] of ctx.toolParts?.entries() ?? []) {
    if (!entry || entry.settled) continue;
    entry.settled = true;
    events.push({
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
            status: 'error',
            input: entry.input && typeof entry.input === 'object' ? entry.input : {},
            error: reason,
            time: { start: ctx.assistantCreatedAt, end: now },
          },
        },
      },
    });
  }

  return events;
}

/**
 * Map one SDK message into zero or more canonical events.
 * Mutates ctx for streaming state (accumulated text, foreign id, tool ids).
 *
 * @param {ClaudeMapperContext} ctx
 * @param {object} message
 * @returns {{ events: object[], foreignSessionId?: string, capabilities?: object }}
 */
export function mapClaudeMessageToEvents(ctx, message) {
  if (!message || typeof message !== 'object') {
    return { events: [] };
  }

  const events = [];
  let foreignSessionId;
  /** @type {object | undefined} */
  let capabilities;

  if (typeof message.session_id === 'string' && message.session_id) {
    foreignSessionId = message.session_id;
    ctx.foreignSessionId = foreignSessionId;
  }

  const parentToolUseId = typeof message.parent_tool_use_id === 'string'
    ? message.parent_tool_use_id.trim()
    : '';

  /**
   * @param {() => object[]} mapFn
   */
  const mapMaybeNested = (mapFn) => {
    if (!parentToolUseId) {
      events.push(...mapFn());
      return;
    }
    const child = ensureSubagentContext(ctx, parentToolUseId);
    events.push(...buildSubagentCreatedEvents(ctx, child));
    events.push(...withSubagentContext(ctx, child, mapFn));
  };

  switch (message.type) {
    case 'system': {
      if (message.subtype === 'init') {
        if (typeof message.session_id === 'string') {
          foreignSessionId = message.session_id;
          ctx.foreignSessionId = foreignSessionId;
        }
        capabilities = {
          slash_commands: Array.isArray(message.slash_commands) ? message.slash_commands : [],
          skills: Array.isArray(message.skills) ? message.skills : [],
          agents: Array.isArray(message.agents) ? message.agents : [],
          tools: Array.isArray(message.tools) ? message.tools : [],
          mcp_servers: Array.isArray(message.mcp_servers) ? message.mcp_servers : [],
          session_id: foreignSessionId,
        };
        ctx.lastInitCapabilities = capabilities;
      } else if (message.subtype === 'compact_boundary') {
        const pre = message.compact_metadata?.pre_tokens;
        const trigger = message.compact_metadata?.trigger;
        const notice = [
          'Conversation compacted',
          typeof pre === 'number' ? `(pre-compaction tokens: ${pre})` : '',
          trigger ? `trigger: ${trigger}` : '',
        ].filter(Boolean).join(' · ');
        events.push(...segmentDeltaEvents(ctx, 'text', notice));
        events.push(...finalizeOpenSegments(ctx));
        events.push({
          type: 'message.updated',
          properties: { info: assistantInfo(ctx, true) },
        });
        events.push({
          type: 'session.status',
          properties: {
            sessionID: ctx.sessionId,
            status: { type: 'idle' },
          },
        });
      }
      break;
    }

    case 'stream_event': {
      const event = message.event;
      if (!event || typeof event !== 'object') break;
      mapMaybeNested(() => {
        const nested = [];
        if (event.type === 'content_block_delta') {
          const delta = event.delta;
          if (delta?.type === 'text_delta' && typeof delta.text === 'string') {
            nested.push(...segmentDeltaEvents(ctx, 'text', delta.text));
          } else if (delta?.type === 'thinking_delta' && typeof delta.thinking === 'string') {
            nested.push(...segmentDeltaEvents(ctx, 'reasoning', delta.thinking));
          }
        } else if (event.type === 'content_block_start') {
          const block = event.content_block;
          if (block?.type === 'tool_use') {
            nested.push(...mapContentBlock(ctx, block));
          } else {
            const kind = block?.type === 'text'
              ? 'text'
              : block?.type === 'thinking' ? 'reasoning' : null;
            if (kind) {
              const field = SEGMENT_FIELDS[kind];
              if (ctx[field.needsNew] || !ctx[field.started]) {
                if (ctx[field.needsNew]) beginNewSegment(ctx, kind);
                nested.push(...startSegmentEvents(ctx, kind));
              }
            }
          }
        }
        return nested;
      });
      break;
    }

    case 'assistant': {
      mapMaybeNested(() => {
        const nested = [];
        const content = message.message?.content;
        if (Array.isArray(content)) {
          for (const block of content) {
            nested.push(...mapContentBlock(ctx, block));
          }
        }
        if (message.error && !parentToolUseId) {
          nested.push({
            type: 'session.status',
            properties: {
              sessionID: ctx.sessionId,
              status: { type: 'idle' },
            },
          });
          nested.push({
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
        return nested;
      });
      break;
    }

    case 'user': {
      mapMaybeNested(() => {
        const nested = [];
        const content = message.message?.content;
        if (Array.isArray(content)) {
          for (const block of content) {
            nested.push(...mapToolResultBlock(ctx, block));
          }
        }
        return nested;
      });
      break;
    }

    case 'result': {
      const resultText = typeof message.result === 'string' ? message.result : '';
      const hasContent = ctx.textPartStarted || ctx.reasoningPartStarted
        || ctx.toolParts.size > 0 || Boolean(resultText);

      // Prefer turn-total usage on the result message so goal budgets see the
      // same counters OpenCode sessions expose on assistant.info.tokens.
      applyUsageToContext(ctx, message.usage, message.total_cost_usd);

      // Non-streaming turns carry their whole answer on the result message.
      if (!ctx.textPartStarted && resultText) {
        events.push(...segmentDeltaEvents(ctx, 'text', resultText));
      }
      events.push(...finalizeOpenSegments(ctx));
      if (hasContent) {
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

  return { events, foreignSessionId, capabilities };
}
