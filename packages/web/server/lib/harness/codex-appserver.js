import { existsSync } from 'fs';
import path from 'path';
import os from 'os';
import { createJsonRpcSubprocess } from './jsonrpc-subprocess.js';

/* eslint-disable max-len */
const PLAN_MODE_INSTRUCTIONS = `<collaboration_mode># Plan Mode (Conversational)

You work in 3 phases, and you should *chat your way* to a great plan before finalizing it. A great plan is very detailed-intent- and implementation-wise-so that it can be handed to another engineer or agent to be implemented right away. It must be **decision complete**, where the implementer does not need to make any decisions.

## Mode rules (strict)

You are in **Plan Mode** until a developer message explicitly ends it.

Plan Mode is not changed by user intent, tone, or imperative language. If a user asks for execution while still in Plan Mode, treat it as a request to **plan the execution**, not perform it.

## Execution vs. mutation in Plan Mode

You may explore and execute **non-mutating** actions that improve the plan. You must not perform **mutating** actions.

### Allowed (non-mutating, plan-improving)

* Reading or searching files, configs, schemas, types, manifests, and docs
* Static analysis, inspection, and repo exploration
* Dry-run style commands when they do not edit repo-tracked files

### Not allowed (mutating, plan-executing)

* Editing or writing files
* Running formatters or linters that rewrite files
* Applying patches, migrations, or codegen that updates repo-tracked files

When in doubt: if the action would reasonably be described as "doing the work" rather than "planning the work," do not do it.

## Asking questions

Strongly prefer using the \`request_user_input\` tool to ask any questions.

## Finalization rule

Only output the final plan when it is decision complete.

When you present the official plan, wrap it in a \`<proposed_plan>\` block so the client can render it specially.
</collaboration_mode>`;

const DEFAULT_MODE_INSTRUCTIONS = `<collaboration_mode># Collaboration Mode: Default

You are now in Default mode. Any previous instructions for other modes (e.g. Plan mode) are no longer active.

Your active mode changes only when new developer instructions with a different \`<collaboration_mode>...</collaboration_mode>\` change it; user requests or tool descriptions do not change mode by themselves.

## request_user_input availability

The \`request_user_input\` tool is unavailable in Default mode. If you call it while in Default mode, it will return an error.

In Default mode, strongly prefer making reasonable assumptions and executing the user's request rather than stopping to ask questions.
</collaboration_mode>`;
/* eslint-enable max-len */

const CLIENT_INFO = Object.freeze({
  name: 'openchamber',
  title: 'OpenChamber',
  version: '0.1.0',
});

const CAPABILITIES = Object.freeze({
  experimentalApi: true,
});

const IDLE_TIMEOUT_MS = 30 * 60 * 1000; // 30 minutes
const INIT_TIMEOUT_MS = 30_000;
const TURN_START_TIMEOUT_MS = 60_000;

const APPROVAL_METHOD_MAP = Object.freeze({
  'item/commandExecution/requestApproval': 'command_execution',
  'item/fileRead/requestApproval': 'file_read',
  'item/fileChange/requestApproval': 'file_change',
  'apply_patch/requestApproval': 'file_change',
});

const APPROVAL_REPLY_MAP = Object.freeze({
  once: 'accept',
  always: 'acceptForSession',
  reject: 'decline',
});

const RECOVERABLE_RESUME_PATTERNS = [
  'not found',
  'missing thread',
  'no such thread',
  'unknown thread',
  'does not exist',
];

/**
 * Resolves the path to the `codex` CLI binary.
 */
const resolveCodexPath = () => {
  const explicit = [
    process.env.OPENCHAMBER_CODEX_PATH,
    process.env.CODEX_PATH,
    process.env.CODEX_BIN,
  ]
    .filter((v) => typeof v === 'string')
    .map((v) => v.trim())
    .filter(Boolean);

  for (const candidate of explicit) {
    if (existsSync(candidate)) {
      return candidate;
    }
  }

  const pathEntries = (process.env.PATH || '')
    .split(path.delimiter)
    .map((e) => e.trim())
    .filter(Boolean);

  const binaryName = process.platform === 'win32' ? 'codex.cmd' : 'codex';
  const pathCandidates = pathEntries.map((e) => path.join(e, binaryName));
  const commonCandidates = process.platform === 'win32'
    ? []
    : ['/opt/homebrew/bin/codex', '/usr/local/bin/codex', '/usr/bin/codex'];

  for (const candidate of [...pathCandidates, ...commonCandidates]) {
    if (existsSync(candidate)) {
      return candidate;
    }
  }

  return undefined;
};

/**
 * Creates a Codex app-server process pool and adapter.
 *
 * Manages one `codex app-server` subprocess per session, maps Codex JSON-RPC
 * events to openchamber's SSE event format, and handles approval/question flows.
 */
export function createCodexAppServerAdapter({ crypto, emitEvent, onTurnCompleted, onTurnError }) {
  const codexPath = resolveCodexPath();

  /** @type {Map<string, SessionProcess>} */
  const pool = new Map();

  // -------------------------------------------------------------------
  //  Session process lifecycle
  // -------------------------------------------------------------------

  /**
   * @typedef {Object} SessionProcess
   * @property {ReturnType<typeof createJsonRpcSubprocess>} rpc
   * @property {string|null} threadId
   * @property {boolean} initialized
   * @property {string|null} activeTurnId
   * @property {Map<string, PendingApproval>} pendingApprovals
   * @property {Map<string, PendingQuestion>} pendingQuestions
   * @property {ActiveMessage|null} activeMessage
   * @property {ReturnType<typeof setTimeout>|null} idleTimer
   * @property {string} sessionId
   * @property {string|null} directory
   */

  /**
   * @typedef {Object} PendingApproval
   * @property {number|string} rpcRequestId
   * @property {string} sessionId
   * @property {string} directory
   */

  /**
   * @typedef {Object} PendingQuestion
   * @property {number|string} rpcRequestId
   * @property {string} sessionId
   * @property {string} directory
   * @property {Array} questions - parsed question info
   */

  /**
   * @typedef {Object} ActiveMessage
   * @property {object} record - the assistant message record being built
   * @property {Map<string, string>} textBuffers - partId -> accumulated text
   */

  function createId() {
    return `${Date.now().toString(16).padStart(12, '0')}${crypto.randomBytes(4).toString('hex')}`;
  }

  function resetIdleTimer(proc) {
    if (proc.idleTimer) {
      clearTimeout(proc.idleTimer);
      proc.idleTimer = null;
    }
    proc.idleTimer = setTimeout(() => {
      shutdownProcess(proc.sessionId);
    }, IDLE_TIMEOUT_MS);
  }

  function clearIdleTimer(proc) {
    if (proc.idleTimer) {
      clearTimeout(proc.idleTimer);
      proc.idleTimer = null;
    }
  }

  /**
   * Spawn a new codex app-server process for a session.
   */
  function spawnProcess(sessionId, directory) {
    if (!codexPath) {
      throw new Error('Codex CLI not found. Ensure codex is installed and in PATH.');
    }

    /** @type {SessionProcess} */
    const proc = {
      rpc: null,
      threadId: null,
      initialized: false,
      activeTurnId: null,
      pendingApprovals: new Map(),
      pendingQuestions: new Map(),
      activeMessage: null,
      idleTimer: null,
      sessionId,
      directory,
    };

    proc.rpc = createJsonRpcSubprocess({
      command: codexPath,
      args: ['app-server'],
      cwd: directory || undefined,
      requestTimeout: INIT_TIMEOUT_MS,

      onRequest: (id, method, params) => {
        handleSubprocessRequest(proc, id, method, params);
      },

      onNotification: (method, params) => {
        handleSubprocessNotification(proc, method, params);
      },

      onError: (err) => {
        // Filter benign stderr noise
        const msg = err?.message || '';
        if (msg.includes('state db missing rollout path')
          || msg.includes('state db record_discrepancy')) {
          return;
        }
        console.warn(`[codex-appserver:${sessionId}] ${msg}`);
      },

      onExit: (code, signal) => {
        console.info(`[codex-appserver:${sessionId}] exited code=${code} signal=${signal}`);
        rejectAllPending(proc, `Codex process exited (code=${code})`);
        pool.delete(sessionId);

        emitEvent(directory, {
          type: 'session.error',
          properties: {
            sessionID: sessionId,
            error: { message: `Codex process exited unexpectedly (code=${code})` },
            directory,
          },
        });

        emitEvent(directory, {
          type: 'session.status',
          properties: { sessionID: sessionId, status: { type: 'idle' }, info: { type: 'idle' }, directory },
        });
      },
    });

    pool.set(sessionId, proc);
    resetIdleTimer(proc);
    return proc;
  }

  /**
   * Initialize the codex app-server (handshake).
   */
  async function initializeProcess(proc, options = {}) {
    // Step 1: initialize
    await proc.rpc.sendRequest('initialize', {
      clientInfo: CLIENT_INFO,
      capabilities: CAPABILITIES,
    }, { timeout: INIT_TIMEOUT_MS });

    // Step 2: initialized notification (no params — matches codex protocol)
    proc.rpc.sendNotification('initialized');

    // Step 3: Optional account/model queries
    try {
      await proc.rpc.sendRequest('account/read', {}, { timeout: 10_000 });
    } catch {
      // non-fatal
    }

    try {
      await proc.rpc.sendRequest('model/list', {}, { timeout: 10_000 });
    } catch {
      // non-fatal
    }

    proc.initialized = true;
  }

  /**
   * Start or resume a thread on the process.
   */
  async function ensureThread(proc, options = {}) {
    // Build thread params, omitting null/undefined values (Codex rejects null strings)
    const threadParams = {
      approvalPolicy: options.approvalPolicy || 'on-request',
      sandbox: options.sandbox || 'workspace-write',
    };
    if (options.model) {
      threadParams.model = options.model;
    }
    if (proc.directory) {
      threadParams.cwd = proc.directory;
    }

    if (proc.threadId) {
      // Try to resume
      try {
        const result = await proc.rpc.sendRequest('thread/resume', {
          threadId: proc.threadId,
          ...threadParams,
        }, { timeout: INIT_TIMEOUT_MS });
        proc.threadId = result?.thread?.id || result?.threadId || proc.threadId;
        return;
      } catch (err) {
        const msg = (err?.message || '').toLowerCase();
        const isRecoverable = RECOVERABLE_RESUME_PATTERNS.some((p) => msg.includes(p));
        if (!isRecoverable) {
          throw err;
        }
        // Fall through to thread/start
        console.info(`[codex-appserver:${proc.sessionId}] thread resume failed, starting fresh: ${msg}`);
      }
    }

    // Start new thread
    const result = await proc.rpc.sendRequest('thread/start', threadParams, { timeout: INIT_TIMEOUT_MS });
    proc.threadId = result?.thread?.id || result?.threadId || null;
  }

  /**
   * Send a turn (user message) to Codex.
   */
  async function sendTurn(proc, input, options = {}) {
    clearIdleTimer(proc);
    proc.activeTurnId = null;

    const params = {
      threadId: proc.threadId,
      input,
      // Enable reasoning summary streaming so the UI can display thinking traces.
      // Values: 'auto' | 'concise' | 'detailed' | 'none'
      summary: 'auto',
    };

    if (options.model) {
      params.model = options.model;
    }
    if (options.effort) {
      params.effort = options.effort;
    }

    // Set collaborationMode for plan/build switching (per-turn setting).
    // The developer_instructions tell Codex what mode it's operating in.
    if (options.mode) {
      const interactionMode = options.mode === 'plan' ? 'plan' : 'default';
      params.collaborationMode = {
        mode: interactionMode,
        settings: {
          model: options.model || 'gpt-5.4',
          reasoning_effort: options.effort || 'medium',
          developer_instructions: interactionMode === 'plan'
            ? PLAN_MODE_INSTRUCTIONS
            : DEFAULT_MODE_INSTRUCTIONS,
        },
      };
    }

    const result = await proc.rpc.sendRequest('turn/start', params, { timeout: TURN_START_TIMEOUT_MS });
    const turnId = result?.turn?.id || result?.turnId || null;
    proc.activeTurnId = turnId;
    return result;
  }

  /**
   * Interrupt the current turn.
   */
  async function interruptTurn(proc) {
    if (!proc.threadId || !proc.activeTurnId) {
      return;
    }

    try {
      await proc.rpc.sendRequest('turn/interrupt', {
        threadId: proc.threadId,
        turnId: proc.activeTurnId,
      }, { timeout: 10_000 });
    } catch {
      // best effort
    }

    proc.activeTurnId = null;
    resetIdleTimer(proc);
  }

  // -------------------------------------------------------------------
  //  Inbound request handlers (approval, user-input)
  // -------------------------------------------------------------------

  function handleSubprocessRequest(proc, rpcId, method, params) {
    const permissionType = APPROVAL_METHOD_MAP[method];

    if (permissionType) {
      handleApprovalRequest(proc, rpcId, method, params, permissionType);
      return;
    }

    if (method === 'item/tool/requestUserInput') {
      handleUserInputRequest(proc, rpcId, params);
      return;
    }

    // Unknown request — respond with error
    proc.rpc.sendResponse(rpcId, null, {
      code: -32601,
      message: `Method not found: ${method}`,
    });
  }

  function handleApprovalRequest(proc, rpcId, method, params, permissionType) {
    const permRequestId = createId();

    proc.pendingApprovals.set(permRequestId, {
      rpcRequestId: rpcId,
      sessionId: proc.sessionId,
      directory: proc.directory,
    });

    // Extract meaningful metadata from the params
    const metadata = {};
    const patterns = [];

    if (permissionType === 'command_execution') {
      if (params?.command) {
        metadata.command = params.command;
        patterns.push(params.command);
      }
      if (params?.cwd) {
        metadata.cwd = params.cwd;
      }
    } else if (permissionType === 'file_read') {
      if (params?.path) {
        metadata.path = params.path;
        patterns.push(params.path);
      }
    } else if (permissionType === 'file_change') {
      if (params?.path) {
        metadata.path = params.path;
        patterns.push(params.path);
      }
      if (params?.diff) {
        metadata.diff = params.diff;
      }
      if (params?.changes && Array.isArray(params.changes)) {
        for (const change of params.changes) {
          if (change?.path) {
            patterns.push(change.path);
          }
        }
        metadata.changes = params.changes;
      }
    }

    // Include full raw params for anything we missed
    metadata._raw = params;

    emitEvent(proc.directory, {
      type: 'permission.asked',
      properties: {
        id: permRequestId,
        sessionID: proc.sessionId,
        permission: permissionType,
        patterns,
        metadata,
        always: [],
      },
    });
  }

  function handleUserInputRequest(proc, rpcId, params) {
    const questionRequestId = createId();

    // Parse questions from params
    const rawQuestions = Array.isArray(params?.questions) ? params.questions : [];
    const questions = rawQuestions.map((q) => ({
      question: typeof q?.question === 'string' ? q.question : '',
      header: typeof q?.header === 'string' ? q.header : '',
      options: Array.isArray(q?.options)
        ? q.options.map((opt) => ({
            label: typeof opt?.label === 'string' ? opt.label : '',
            description: typeof opt?.description === 'string' ? opt.description : '',
          }))
        : [],
      multiple: Boolean(q?.multiSelect || q?.multiple),
    }));

    proc.pendingQuestions.set(questionRequestId, {
      rpcRequestId: rpcId,
      sessionId: proc.sessionId,
      directory: proc.directory,
      questions,
    });

    emitEvent(proc.directory, {
      type: 'question.asked',
      properties: {
        id: questionRequestId,
        sessionID: proc.sessionId,
        questions,
      },
    });
  }

  // -------------------------------------------------------------------
  //  Inbound notification handlers (streaming events)
  // -------------------------------------------------------------------

  function handleSubprocessNotification(proc, method, params) {
    // Log every notification from the Codex subprocess for debugging
    console.info(`[codex-appserver:${proc.sessionId}] notification: ${method}`, JSON.stringify(params, null, 2)?.slice(0, 500));

    switch (method) {
      case 'turn/started':
        proc.activeTurnId = params?.turnId || proc.activeTurnId;
        emitEvent(proc.directory, {
          type: 'session.status',
          properties: {
            sessionID: proc.sessionId,
            status: { type: 'busy' },
            info: { type: 'busy' },
            directory: proc.directory,
          },
        });
        break;

      case 'turn/completed':
        handleTurnCompleted(proc, params);
        break;

      case 'turn/aborted':
        handleTurnAborted(proc, params);
        break;

      case 'item/agentMessage/delta':
      case 'item/reasoning/textDelta':
      case 'item/reasoning/summaryTextDelta':
      case 'item/commandExecution/outputDelta':
      case 'item/fileChange/outputDelta':
        handleContentDelta(proc, method, params);
        break;

      case 'item/started':
        handleItemStarted(proc, params);
        break;

      case 'item/completed':
        handleItemCompleted(proc, params);
        break;

      case 'thread/started':
        if (params?.threadId) {
          proc.threadId = params.threadId;
        }
        break;

      case 'thread/name/updated':
        if (params?.name) {
          emitEvent(proc.directory, {
            type: 'session.updated',
            properties: {
              info: {
                id: proc.sessionId,
                title: params.name,
                directory: proc.directory,
              },
              directory: proc.directory,
            },
          });
        }
        break;

      case 'error':
        emitEvent(proc.directory, {
          type: 'session.error',
          properties: {
            sessionID: proc.sessionId,
            error: { message: params?.message || 'Unknown Codex error' },
            directory: proc.directory,
          },
        });
        break;

      case 'codex/event/reasoning_content_delta':
        // Alternative Codex-specific reasoning format: delta is in params.msg.delta
        handleContentDelta(proc, 'item/reasoning/summaryTextDelta', {
          ...(params?.msg || {}),
          // Flatten msg fields so handleContentDelta can find the delta
          delta: params?.msg?.delta,
          textDelta: params?.msg?.delta,
          itemId: params?.msg?.item_id || params?.msg?.itemId || params?.id || 'default',
        });
        break;

      case 'codex/event/agent_reasoning':
        // Agent-level reasoning progress — treat as reasoning delta
        if (params?.msg?.text) {
          handleContentDelta(proc, 'item/reasoning/textDelta', {
            delta: params.msg.text,
            textDelta: params.msg.text,
            itemId: params?.id || 'default',
          });
        }
        break;

      case 'item/requestApproval/decision':
      case 'item/tool/requestUserInput/answered':
        // Acknowledgement notifications — no action needed
        break;

      default:
        // Log unhandled notifications to help identify missing event types
        if (method && !method.startsWith('item/requestApproval') && !method.startsWith('item/tool/')) {
          console.debug(`[codex-appserver:${proc.sessionId}] unhandled notification: ${method}`);
        }
        break;
    }
  }

  function handleContentDelta(proc, method, params) {
    // Extract delta text — Codex sends it under different fields depending on
    // the notification type.  Match the same fallback chain as t3code:
    //   event.textDelta → payload.delta → payload.text → payload.content.text
    const delta = params?.textDelta || params?.delta || params?.text
      || (typeof params?.content === 'object' && params.content !== null ? params.content.text : undefined)
      || '';

    console.info(`[codex-appserver:${proc.sessionId}] handleContentDelta method=${method} deltaLen=${delta?.length || 0} hasActiveMessage=${!!proc.activeMessage} partType=${
      method === 'item/commandExecution/outputDelta' ? 'tool-output'
      : method === 'item/fileChange/outputDelta' ? 'file-diff'
      : (method === 'item/reasoning/textDelta' || method === 'item/reasoning/summaryTextDelta') ? 'reasoning'
      : 'text'
    }`);

    if (!delta) {
      return;
    }

    if (!proc.activeMessage) {
      return;
    }

    // Use the Codex itemId to distinguish separate items within a turn
    // (e.g., an agent message before an approval vs after).
    const itemId = params?.itemId || 'default';

    // Determine part type based on method
    let partType = 'text';
    if (method === 'item/commandExecution/outputDelta') {
      partType = 'tool-output';
    } else if (method === 'item/fileChange/outputDelta') {
      partType = 'file-diff';
    } else if (method === 'item/reasoning/textDelta' || method === 'item/reasoning/summaryTextDelta') {
      partType = 'reasoning';
    }

    const partId = `${proc.activeMessage.record.info.id}_${partType}_${itemId}`;
    const currentText = proc.activeMessage.textBuffers.get(partId) || '';
    const newText = currentText + delta;
    proc.activeMessage.textBuffers.set(partId, newText);

    // Map internal part types to the UI's expected part schema.
    // 'tool-output' and 'file-diff' should become tool parts so the UI renders
    // them inside collapsible tool components rather than as plain assistant text.
    let emitPart;
    if (partType === 'tool-output' || partType === 'file-diff') {
      const toolName = partType === 'tool-output' ? 'bash' : 'edit';
      // Track the start time and input metadata for this tool part (first delta only)
      if (!proc.activeMessage.toolStartTimes) {
        proc.activeMessage.toolStartTimes = new Map();
      }
      if (!proc.activeMessage.toolInputs) {
        proc.activeMessage.toolInputs = new Map();
      }
      if (!proc.activeMessage.toolStartTimes.has(partId)) {
        proc.activeMessage.toolStartTimes.set(partId, Date.now());
        proc.activeMessage.toolInputs.set(partId, {
          partType,
          toolName,
          input: partType === 'tool-output'
            ? { command: params?.command || '' }
            : { file_path: params?.filePath || '' },
        });
      }
      emitPart = {
        id: partId,
        sessionID: proc.sessionId,
        messageID: proc.activeMessage.record.info.id,
        type: 'tool',
        callID: partId,
        tool: toolName,
        state: {
          status: 'running',
          output: newText,
          input: partType === 'tool-output'
            ? { command: params?.command || '' }
            : { file_path: params?.filePath || '' },
          time: { start: proc.activeMessage.toolStartTimes.get(partId) },
        },
      };
    } else if (partType === 'reasoning') {
      // Track start time for reasoning parts (needed by the UI to show duration
      // and determine when reasoning is complete)
      if (!proc.activeMessage.toolStartTimes) {
        proc.activeMessage.toolStartTimes = new Map();
      }
      if (!proc.activeMessage.toolStartTimes.has(partId)) {
        proc.activeMessage.toolStartTimes.set(partId, Date.now());
      }
      emitPart = {
        id: partId,
        sessionID: proc.sessionId,
        messageID: proc.activeMessage.record.info.id,
        type: 'reasoning',
        text: newText,
        time: { start: proc.activeMessage.toolStartTimes.get(partId) },
      };
    } else {
      emitPart = {
        id: partId,
        sessionID: proc.sessionId,
        messageID: proc.activeMessage.record.info.id,
        type: 'text',
        text: newText,
      };
    }

    console.info(`[codex-appserver:${proc.sessionId}] emitPart id=${emitPart.id} type=${emitPart.type} textLen=${(emitPart.text || emitPart.state?.output || '').length}`);

    emitEvent(proc.directory, {
      type: 'message.part.updated',
      properties: {
        part: emitPart,
        directory: proc.directory,
      },
    });
  }

  function handleItemStarted(proc, params) {
    // Item started — we could track individual items, but for now
    // the content deltas handle streaming. This is informational.
  }

  function handleItemCompleted(proc, params) {
    if (!proc.activeMessage) return;

    const itemId = params?.itemId || params?.id || 'default';
    const itemType = params?.type || params?.itemType || '';
    const now = Date.now();

    console.info(`[codex-appserver:${proc.sessionId}] itemCompleted itemId=${itemId} itemType=${itemType}`);

    // Finalize tool parts (command_execution, file_change) with completed status
    let partType = null;
    if (itemType === 'command_execution') {
      partType = 'tool-output';
    } else if (itemType === 'file_change') {
      partType = 'file-diff';
    } else if (itemType === 'reasoning') {
      partType = 'reasoning';
    }

    if (partType === 'tool-output' || partType === 'file-diff') {
      const partId = `${proc.activeMessage.record.info.id}_${partType}_${itemId}`;
      const output = proc.activeMessage.textBuffers.get(partId) || '';
      const startTime = proc.activeMessage.toolStartTimes?.get(partId) || now;
      const toolName = partType === 'tool-output' ? 'bash' : 'edit';

      emitEvent(proc.directory, {
        type: 'message.part.updated',
        properties: {
          part: {
            id: partId,
            sessionID: proc.sessionId,
            messageID: proc.activeMessage.record.info.id,
            type: 'tool',
            callID: partId,
            tool: toolName,
            state: {
              status: 'completed',
              output,
              input: partType === 'tool-output'
                ? { command: params?.command || '' }
                : { file_path: params?.filePath || '' },
              title: toolName === 'bash' ? 'Command' : 'File change',
              metadata: {},
              time: { start: startTime, end: now },
            },
          },
          directory: proc.directory,
        },
      });
    } else if (partType === 'reasoning') {
      // Finalize reasoning part with end time so the UI knows reasoning is complete
      const partId = `${proc.activeMessage.record.info.id}_reasoning_${itemId}`;
      const text = proc.activeMessage.textBuffers.get(partId) || '';
      const startTime = proc.activeMessage.toolStartTimes?.get(partId) || now;

      if (text) {
        emitEvent(proc.directory, {
          type: 'message.part.updated',
          properties: {
            part: {
              id: partId,
              sessionID: proc.sessionId,
              messageID: proc.activeMessage.record.info.id,
              type: 'reasoning',
              text,
              time: { start: startTime, end: now },
            },
            directory: proc.directory,
          },
        });
      }
    }
  }

  function handleTurnCompleted(proc, params) {
    proc.activeTurnId = null;
    resetIdleTimer(proc);

    // Finalize the active message
    const finalText = assembleFinalText(proc);
    const finalParts = assembleFinalParts(proc);

    emitEvent(proc.directory, {
      type: 'session.status',
      properties: {
        sessionID: proc.sessionId,
        status: { type: 'idle' },
        info: { type: 'idle' },
        directory: proc.directory,
      },
    });

    emitEvent(proc.directory, {
      type: 'session.idle',
      properties: {
        sessionID: proc.sessionId,
        directory: proc.directory,
      },
    });

    if (onTurnCompleted) {
      onTurnCompleted(proc.sessionId, finalText, params, finalParts);
    }

    proc.activeMessage = null;
  }

  function handleTurnAborted(proc, params) {
    proc.activeTurnId = null;
    resetIdleTimer(proc);

    emitEvent(proc.directory, {
      type: 'session.status',
      properties: {
        sessionID: proc.sessionId,
        status: { type: 'idle' },
        info: { type: 'idle' },
        directory: proc.directory,
      },
    });

    emitEvent(proc.directory, {
      type: 'session.idle',
      properties: {
        sessionID: proc.sessionId,
        directory: proc.directory,
      },
    });

    if (onTurnCompleted) {
      onTurnCompleted(proc.sessionId, null, params);
    }

    proc.activeMessage = null;
  }

  function assembleFinalText(proc) {
    if (!proc.activeMessage) {
      return '';
    }
    // Collect all text content parts (keyed as _text_<itemId>)
    const prefix = `${proc.activeMessage.record.info.id}_text_`;
    const textParts = [];
    for (const [key, value] of proc.activeMessage.textBuffers) {
      if (key.startsWith(prefix) && value) {
        textParts.push(value);
      }
    }
    return textParts.join('\n\n');
  }

  /**
   * Assemble all final parts (text, reasoning, tool) from the active message buffers.
   * Returns an array of part objects for persistence.
   */
  function assembleFinalParts(proc) {
    if (!proc.activeMessage) {
      return [];
    }
    const msgId = proc.activeMessage.record.info.id;
    const parts = [];
    const now = Date.now();

    for (const [key, value] of proc.activeMessage.textBuffers) {
      if (!value) continue;

      if (key.startsWith(`${msgId}_reasoning_`)) {
        const startTime = proc.activeMessage.toolStartTimes?.get(key) || now;
        parts.push({
          type: 'reasoning',
          text: value,
          time: { start: startTime, end: now },
        });
      } else if (key.startsWith(`${msgId}_text_`)) {
        parts.push({
          type: 'text',
          text: value,
        });
      } else if (key.startsWith(`${msgId}_tool-output_`) || key.startsWith(`${msgId}_file-diff_`)) {
        const startTime = proc.activeMessage.toolStartTimes?.get(key) || now;
        const meta = proc.activeMessage.toolInputs?.get(key);
        const toolName = meta?.toolName || (key.includes('_tool-output_') ? 'bash' : 'edit');
        parts.push({
          type: 'tool',
          callID: key,
          tool: toolName,
          state: {
            status: 'completed',
            output: value,
            input: meta?.input || {},
            title: toolName === 'bash' ? 'Command' : 'File change',
            metadata: {},
            time: { start: startTime, end: now },
          },
        });
      }
    }
    return parts;
  }

  // -------------------------------------------------------------------
  //  Cleanup helpers
  // -------------------------------------------------------------------

  function rejectAllPending(proc, reason) {
    // Emit rejection events for any pending approvals
    for (const [permId, info] of proc.pendingApprovals) {
      emitEvent(info.directory, {
        type: 'permission.replied',
        properties: {
          sessionID: info.sessionId,
          requestID: permId,
          reply: 'reject',
        },
      });
    }
    proc.pendingApprovals.clear();

    // Emit rejection events for any pending questions
    for (const [qId, info] of proc.pendingQuestions) {
      emitEvent(info.directory, {
        type: 'question.rejected',
        properties: {
          sessionID: info.sessionId,
          requestID: qId,
        },
      });
    }
    proc.pendingQuestions.clear();
  }

  async function shutdownProcess(sessionId) {
    const proc = pool.get(sessionId);
    if (!proc) {
      return;
    }

    clearIdleTimer(proc);
    rejectAllPending(proc, 'Session shutdown');
    pool.delete(sessionId);

    try {
      await proc.rpc.shutdown({ grace: 5000 });
    } catch {
      proc.rpc.kill();
    }
  }

  // -------------------------------------------------------------------
  //  Public API
  // -------------------------------------------------------------------

  return {
    /**
     * Get or create a process for a session, fully initialized.
     */
    async getOrCreateProcess(sessionId, directory, options = {}) {
      let proc = pool.get(sessionId);

      if (proc && !proc.rpc.isAlive()) {
        pool.delete(sessionId);
        proc = null;
      }

      if (!proc) {
        proc = spawnProcess(sessionId, directory);
        // Restore persisted thread ID so we can resume instead of starting fresh
        if (options.threadId) {
          proc.threadId = options.threadId;
        }
      }

      if (!proc.initialized) {
        await initializeProcess(proc, options);
      }

      await ensureThread(proc, options);

      return proc;
    },

    /**
     * Send a turn (user message).
     */
    async startTurn(sessionId, input, messageRecord, options = {}) {
      const proc = pool.get(sessionId);
      if (!proc) {
        throw new Error(`No process for session ${sessionId}`);
      }

      // Set up active message tracking for streaming
      proc.activeMessage = {
        record: messageRecord,
        textBuffers: new Map(),
      };

      // Emit initial assistant message
      emitEvent(proc.directory, {
        type: 'message.updated',
        properties: {
          info: messageRecord.info,
          directory: proc.directory,
        },
      });

      return sendTurn(proc, input, options);
    },

    /**
     * Abort the current turn for a session.
     */
    async abort(sessionId) {
      const proc = pool.get(sessionId);
      if (!proc) {
        return;
      }
      await interruptTurn(proc);
    },

    /**
     * Roll back N turns on the Codex thread.
     * Returns the thread snapshot from Codex.
     */
    async rollbackTurns(sessionId, numTurns) {
      const proc = pool.get(sessionId);
      if (!proc || !proc.threadId) {
        return null;
      }

      const result = await proc.rpc.sendRequest('thread/rollback', {
        threadId: proc.threadId,
        numTurns,
      }, { timeout: 15_000 });

      proc.activeTurnId = null;
      return result;
    },

    /**
     * Reply to a permission request.
     */
    replyToPermission(requestId, reply) {
      for (const proc of pool.values()) {
        const pending = proc.pendingApprovals.get(requestId);
        if (pending) {
          proc.pendingApprovals.delete(requestId);

          const decision = APPROVAL_REPLY_MAP[reply] || 'denied';
          proc.rpc.sendResponse(pending.rpcRequestId, { decision });

          emitEvent(pending.directory, {
            type: 'permission.replied',
            properties: {
              sessionID: pending.sessionId,
              requestID: requestId,
              reply,
            },
          });

          return true;
        }
      }
      return false;
    },

    /**
     * Reply to a question (user-input) request.
     */
    replyToQuestion(requestId, answers) {
      for (const proc of pool.values()) {
        const pending = proc.pendingQuestions.get(requestId);
        if (pending) {
          proc.pendingQuestions.delete(requestId);

          // Format answers for Codex: { questionId: { answers: [...] } }
          const codexAnswers = {};
          const normalizedAnswers = Array.isArray(answers) ? answers : [];
          const questions = pending.questions || [];

          for (let i = 0; i < questions.length; i++) {
            const questionId = questions[i]?.id || String(i);
            const answer = normalizedAnswers[i];
            codexAnswers[questionId] = {
              answers: Array.isArray(answer) ? answer : [String(answer || '')],
            };
          }

          proc.rpc.sendResponse(pending.rpcRequestId, { answers: codexAnswers });

          emitEvent(pending.directory, {
            type: 'question.replied',
            properties: {
              sessionID: pending.sessionId,
              requestID: requestId,
              answers: normalizedAnswers,
            },
          });

          return true;
        }
      }
      return false;
    },

    /**
     * Reject a question request.
     */
    rejectQuestion(requestId) {
      for (const proc of pool.values()) {
        const pending = proc.pendingQuestions.get(requestId);
        if (pending) {
          proc.pendingQuestions.delete(requestId);

          proc.rpc.sendResponse(pending.rpcRequestId, null, {
            code: -32000,
            message: 'User rejected the question',
          });

          emitEvent(pending.directory, {
            type: 'question.rejected',
            properties: {
              sessionID: pending.sessionId,
              requestID: requestId,
            },
          });

          return true;
        }
      }
      return false;
    },

    /**
     * Check if a permission request ID belongs to a Codex session.
     */
    hasPermissionRequest(requestId) {
      for (const proc of pool.values()) {
        if (proc.pendingApprovals.has(requestId)) {
          return true;
        }
      }
      return false;
    },

    /**
     * Check if a question request ID belongs to a Codex session.
     */
    hasQuestionRequest(requestId) {
      for (const proc of pool.values()) {
        if (proc.pendingQuestions.has(requestId)) {
          return true;
        }
      }
      return false;
    },

    /**
     * List all pending permission requests across all sessions.
     */
    listPendingPermissions(filterSessionId) {
      const result = [];
      for (const proc of pool.values()) {
        if (filterSessionId && proc.sessionId !== filterSessionId) {
          continue;
        }
        for (const [permId, info] of proc.pendingApprovals) {
          result.push({
            id: permId,
            sessionID: info.sessionId,
          });
        }
      }
      return result;
    },

    /**
     * List all pending question requests across all sessions.
     */
    listPendingQuestions(filterSessionId) {
      const result = [];
      for (const proc of pool.values()) {
        if (filterSessionId && proc.sessionId !== filterSessionId) {
          continue;
        }
        for (const [qId, info] of proc.pendingQuestions) {
          result.push({
            id: qId,
            sessionID: info.sessionId,
            questions: info.questions,
          });
        }
      }
      return result;
    },

    /**
     * Shut down a specific session's process.
     */
    async shutdownSession(sessionId) {
      await shutdownProcess(sessionId);
    },

    /**
     * Shut down all processes (server shutdown).
     */
    async shutdownAll() {
      const ids = Array.from(pool.keys());
      await Promise.all(ids.map((id) => shutdownProcess(id)));
    },

    /**
     * Whether the codex binary is available.
     */
    isAvailable() {
      return Boolean(codexPath);
    },

    /**
     * Get the resolved codex path.
     */
    getCodexPath() {
      return codexPath;
    },

    /**
     * Get the current thread ID for a session.
     */
    getThreadId(sessionId) {
      const proc = pool.get(sessionId);
      return proc?.threadId || null;
    },
  };
}
