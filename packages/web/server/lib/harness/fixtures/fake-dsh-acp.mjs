#!/usr/bin/env node
/**
 * fake-dsh-acp.mjs — a deterministic ACP JSON-RPC 2.0 stdio server.
 *
 * Used by deepseek-backend.test.js to exercise the real
 * jsonrpc-subprocess + deepseek-appserver + deepseek-backend stack without a
 * network or a real `dsh` install. It speaks the same newline-delimited
 * JSON-RPC framing as `dsh --profile acp` and implements exactly the agent-side
 * subset the adapter drives:
 *
 *   initialize, session/new, session/resume, session/list,
 *   session/set_config_option, session/close, session/prompt (agent request),
 *   session/cancel (agent notification), session/request_permission (client
 *   request), session/update (client notification).
 *
 * Deterministic behaviours are keyed off the prompt text so a test can select
 * them without extra config:
 *   - text containing "permission"  -> emit a session/request_permission and
 *                                      await the client's answer before ending.
 *   - text containing "abort"       -> emit one chunk, then wait for
 *                                      session/cancel and end with "cancelled".
 *   - text containing "crash"       -> emit one chunk, then process.exit(1).
 *   - anything else                 -> thought + message + tool_call + usage,
 *                                      end with "end_turn".
 *
 * All diagnostics go to stderr; stdout is exclusively ACP framing.
 */

import readline from 'readline';

const MODEL_OPTIONS = [
  {
    id: 'model',
    name: 'Model',
    category: 'model',
    type: 'select',
    currentValue: 'deepseek-chat',
    options: [
      { value: 'deepseek-chat', name: 'DeepSeek Chat' },
      { value: 'deepseek-reasoner', name: 'DeepSeek Reasoner' },
    ],
  },
];

const out = (msg) => process.stdout.write(`${JSON.stringify(msg)}\n`);
const notify = (method, params) => out({ jsonrpc: '2.0', method, params });
const respond = (id, result) => out({ jsonrpc: '2.0', id, result });
const respondError = (id, code, message) => out({ jsonrpc: '2.0', id, error: { code, message } });

let nextSession = 0;
let nextServerRequestId = 1000;

/** sessionId -> { promptId, cancelled, waitingCancel } */
const sessions = new Map();
/** serverRequestId -> resolve(result) */
const serverRequests = new Map();

const emitUpdate = (sessionId, update) =>
  notify('session/update', { sessionId, update });

const endPrompt = (sessionId, stopReason) => {
  const state = sessions.get(sessionId);
  if (!state || state.promptId == null) return;
  const id = state.promptId;
  state.promptId = null;
  state.cancelled = false;
  respond(id, { stopReason });
};

const hasText = (blocks, needle) =>
  (Array.isArray(blocks) ? blocks : [])
    .filter((b) => b?.type === 'text' && typeof b.text === 'string')
    .map((b) => b.text)
    .join('\n')
    .includes(needle);

const askPermission = (sessionId) =>
  new Promise((resolve) => {
    const id = nextServerRequestId++;
    serverRequests.set(id, resolve);
    out({
      jsonrpc: '2.0',
      id,
      method: 'session/request_permission',
      params: {
        sessionId,
        toolCall: { toolCallId: 'tc-perm', title: 'Write file', kind: 'edit', status: 'pending' },
        options: [
          { optionId: 'allow-once', name: 'Allow once', kind: 'allow_once' },
          { optionId: 'allow-always', name: 'Allow always', kind: 'allow_always' },
          { optionId: 'reject', name: 'Reject', kind: 'reject_once' },
        ],
      },
    });
  });

const handlePrompt = async (id, params) => {
  const sessionId = params.sessionId;
  if (!sessions.has(sessionId)) {
    respondError(id, -32602, `unknown session ${sessionId}`);
    return;
  }
  const state = sessions.get(sessionId);
  state.promptId = id;
  state.cancelled = false;

  const blocks = params.prompt;

  emitUpdate(sessionId, {
    sessionUpdate: 'agent_thought_chunk',
    content: { type: 'text', text: 'Let me think. ' },
  });
  emitUpdate(sessionId, {
    sessionUpdate: 'agent_message_chunk',
    content: { type: 'text', text: 'Hello ' },
  });

  if (hasText(blocks, 'crash')) {
    emitUpdate(sessionId, {
      sessionUpdate: 'agent_message_chunk',
      content: { type: 'text', text: 'before-crash' },
    });
    setImmediate(() => process.exit(1));
    return;
  }

  if (hasText(blocks, 'abort')) {
    // Wait for the client to send session/cancel.
    return;
  }

  emitUpdate(sessionId, {
    sessionUpdate: 'tool_call',
    toolCallId: 'tc-1',
    title: 'Read a.txt',
    kind: 'read',
    status: 'in_progress',
    rawInput: { path: 'a.txt' },
  });
  emitUpdate(sessionId, {
    sessionUpdate: 'tool_call_update',
    toolCallId: 'tc-1',
    status: 'completed',
    rawOutput: { ok: true },
  });

  if (hasText(blocks, 'permission')) {
    const outcome = await askPermission(sessionId);
    const answered = outcome?.outcome?.outcome === 'selected'
      ? `perm=${outcome.outcome.optionId}`
      : 'perm=cancelled';
    emitUpdate(sessionId, {
      sessionUpdate: 'agent_message_chunk',
      content: { type: 'text', text: `${answered} ` },
    });
  }

  emitUpdate(sessionId, {
    sessionUpdate: 'agent_message_chunk',
    content: { type: 'text', text: 'world.' },
  });
  emitUpdate(sessionId, {
    sessionUpdate: 'usage_update',
    size: 1000,
    used: 42,
  });
  endPrompt(sessionId, 'end_turn');
};

const handleRequest = async (id, method, params) => {
  switch (method) {
    case 'initialize':
      respond(id, {
        protocolVersion: 1,
        agentCapabilities: {
          promptCapabilities: { image: true, audio: false, embeddedContext: false },
        },
      });
      return;
    case 'session/new': {
      const sessionId = `acp-${++nextSession}`;
      sessions.set(sessionId, { promptId: null, cancelled: false });
      respond(id, { sessionId, configOptions: MODEL_OPTIONS });
      emitUpdate(sessionId, {
        sessionUpdate: 'available_commands_update',
        availableCommands: [{ name: 'review', description: 'Review the diff' }],
      });
      return;
    }
    case 'session/resume': {
      const sessionId = params?.sessionId || `acp-${++nextSession}`;
      sessions.set(sessionId, { promptId: null, cancelled: false });
      respond(id, { sessionId, configOptions: MODEL_OPTIONS });
      return;
    }
    case 'session/list':
      respond(id, {
        sessions: [
          {
            sessionId: 'acp-listed',
            cwd: params?.cwd ?? process.cwd(),
            title: 'Listed session',
            updatedAt: new Date(0).toISOString(),
          },
        ],
      });
      return;
    case 'session/set_config_option': {
      const currentValue = params?.value ?? 'deepseek-chat';
      respond(id, {
        configOptions: [{ ...MODEL_OPTIONS[0], currentValue }],
      });
      return;
    }
    case 'session/close':
      respond(id, null);
      return;
    case 'session/prompt':
      await handlePrompt(id, params);
      return;
    default:
      respondError(id, -32601, `method not found: ${method}`);
  }
};

const handleNotification = (method, params) => {
  if (method === 'session/cancel') {
    const state = sessions.get(params?.sessionId);
    if (state && state.promptId != null) {
      state.cancelled = true;
      endPrompt(params.sessionId, 'cancelled');
    }
  }
};

const handleResponse = (msg) => {
  const resolve = serverRequests.get(msg.id);
  if (resolve) {
    serverRequests.delete(msg.id);
    resolve(msg.result);
  }
};

const rl = readline.createInterface({ input: process.stdin });
rl.on('line', (line) => {
  const trimmed = line.trim();
  if (!trimmed) return;
  let msg;
  try {
    msg = JSON.parse(trimmed);
  } catch (err) {
    process.stderr.write(`fake-dsh-acp: bad json line: ${err.message}\n`);
    return;
  }

  if (msg.method && msg.id != null) {
    handleRequest(msg.id, msg.method, msg.params).catch((err) => {
      respondError(msg.id, -32603, err?.message ?? 'internal error');
    });
    return;
  }
  if (msg.method) {
    handleNotification(msg.method, msg.params);
    return;
  }
  if (msg.id != null) {
    handleResponse(msg);
  }
});

process.stderr.write('fake-dsh-acp: ready\n');
