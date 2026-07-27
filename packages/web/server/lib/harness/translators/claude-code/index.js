/**
 * Claude Code translator — prompt/abort orchestration.
 */

import { mapAttachmentsToContentBlocks } from './attachments.js';
import { startClaudeQuery } from './query.js';
import {
  buildClaudeMcpServersFromOpenChamber,
  buildMcpAllowedToolPatterns,
} from './mcp-config.js';
import {
  createCanUseTool,
  rejectPendingForSession,
  replyPermission as replyPendingPermission,
} from './permissions.js';
import {
  buildTurnAbortEvents,
  buildUserMessageEvents,
  createClaudeMapperContext,
  createOpenCodeId,
  mapClaudeMessageToEvents,
} from '../../events/from-claude.js';
import { emitHarnessEvents } from '../../events/emit.js';
import {
  bindSession,
  getSessionBinding,
  setBindingError,
  setForeignSessionId,
  updateSessionBinding,
} from '../../session-bindings.js';
import { getHarnessCapabilities } from '../../registry.js';
import { detectClaudeCode } from '../../detect.js';
import { updateSessionCapabilities } from '../../session-capabilities.js';

const ABORT_INTERRUPT_TIMEOUT_MS = 2_000;

/**
 * @param {object} event
 * @param {string} sessionId
 * @returns {boolean}
 */
function isIdleStatusEvent(event, sessionId) {
  return event?.type === 'session.status'
    && event.properties?.sessionID === sessionId
    && event.properties?.status?.type === 'idle';
}

/**
 * @param {object} handle
 * @param {number} timeoutMs
 */
async function interruptWithTimeout(handle, timeoutMs = ABORT_INTERRUPT_TIMEOUT_MS) {
  if (typeof handle?.interrupt !== 'function') return;
  /** @type {ReturnType<typeof setTimeout> | undefined} */
  let timer;
  try {
    await Promise.race([
      Promise.resolve().then(() => handle.interrupt()),
      new Promise((resolve) => {
        timer = setTimeout(resolve, timeoutMs);
        if (typeof timer.unref === 'function') timer.unref();
      }),
    ]);
  } finally {
    if (timer) clearTimeout(timer);
  }
}

/**
 * Build SDK prompt: string when text-only; AsyncIterable when attachments present.
 * @param {string} text
 * @param {unknown[]} files
 * @returns {string | AsyncIterable<object>}
 */
export function buildClaudePrompt(text, files, options = {}) {
  const blocks = mapAttachmentsToContentBlocks(files, {
    cwd: typeof options.cwd === 'string' ? options.cwd : undefined,
    preferPathReferences: options.preferPathReferences,
  });
  if (blocks.length === 0) {
    return typeof text === 'string' ? text : '';
  }
  const content = [
    { type: 'text', text: typeof text === 'string' ? text : '' },
    ...blocks,
  ];
  return (async function* streamUserMessage() {
    yield {
      type: 'user',
      parent_tool_use_id: null,
      message: {
        role: 'user',
        content,
      },
    };
  })();
}

/**
 * @param {object} deps
 * @param {() => ((payload: object, options?: object) => void) | null | undefined} [deps.getBroadcast]
 * @param {typeof startClaudeQuery} [deps.startQuery]
 * @param {typeof detectClaudeCode} [deps.detect]
 * @param {(options?: { contextDirectory?: string | null }) => Promise<Record<string, unknown> | null>} [deps.createOpenChamberMcpServers]
 */
export function createClaudeCodeTranslator(deps = {}) {
  /** @type {Map<string, { handle: object, ctx: object, aborting: boolean, idleEmitted: boolean }>} */
  const activeTurns = new Map();
  const getBroadcast = deps.getBroadcast || (() => null);
  const startQuery = deps.startQuery || startClaudeQuery;
  const detect = deps.detect || detectClaudeCode;
  const createOpenChamberMcpServers = deps.createOpenChamberMcpServers || (async () => null);

  /**
   * @param {object} body
   */
  const prompt = async (body) => {
    const sessionId = typeof body?.sessionId === 'string' ? body.sessionId : '';
    const directory = typeof body?.directory === 'string' ? body.directory : '';
    const text = typeof body?.text === 'string' ? body.text : '';
    const target = body?.target && typeof body.target === 'object' ? body.target : null;
    const harnessId = target?.harnessId || 'claude-code';

    if (!sessionId || !directory) {
      const error = new Error('sessionId and directory are required');
      error.code = 'PROMPT_INVALID';
      error.statusCode = 400;
      throw error;
    }
    if (harnessId !== 'claude-code') {
      const error = new Error(`Unsupported harnessId for Claude translator: ${harnessId}`);
      error.code = 'HARNESS_UNSUPPORTED';
      error.statusCode = 400;
      throw error;
    }

    const detection = await detect();
    if (detection.status !== 'ready') {
      const error = new Error(detection.statusDetail || `Claude Code is not ready (${detection.status})`);
      error.code = detection.status === 'missing-cli'
        ? 'CLAUDE_MISSING_CLI'
        : detection.status === 'needs-login'
          ? 'CLAUDE_NEEDS_LOGIN'
          : 'CLAUDE_NOT_READY';
      error.statusCode = 503;
      error.status = detection.status;
      throw error;
    }

    const existing = getSessionBinding(sessionId);
    if (existing && existing.harnessId !== 'claude-code') {
      const error = new Error('Session is bound to a different engine; create a new session for handoff');
      error.code = 'BINDING_CONFLICT';
      error.statusCode = 409;
      throw error;
    }

    if (activeTurns.has(sessionId)) {
      const error = new Error('A Claude Code turn is already active for this session');
      error.code = 'TURN_IN_PROGRESS';
      error.statusCode = 409;
      throw error;
    }

    const capabilities = getHarnessCapabilities('claude-code');
    const { binding } = bindSession({
      sessionId,
      harnessId: 'claude-code',
      directory,
      target: {
        harnessId: 'claude-code',
        modelRef: typeof target?.modelRef === 'string' ? target.modelRef : 'sonnet',
        permissionMode: target?.permissionMode,
        effort: target?.effort,
      },
      capabilitySnapshot: capabilities,
      seedFromSessionId: typeof body?.seedFromSessionId === 'string' ? body.seedFromSessionId : undefined,
    });

    const userMessageId = typeof body?.messageId === 'string' && body.messageId
      ? body.messageId
      : createOpenCodeId('msg');
    const assistantMessageId = typeof body?.assistantMessageId === 'string' && body.assistantMessageId
      ? body.assistantMessageId
      : createOpenCodeId('msg');

    const ctx = createClaudeMapperContext({
      sessionId,
      directory,
      userMessageId,
      assistantMessageId,
      modelRef: binding.target?.modelRef || 'sonnet',
    });

    const broadcast = getBroadcast();
    const files = Array.isArray(body?.files) ? body.files : [];

    // Validate attachments before anything optimistic is broadcast. Emitting the
    // user message first would leave a sent-and-busy turn on screen that never
    // gets an assistant reply when attachment mapping rejects the payload.
    let promptInput;
    try {
      promptInput = buildClaudePrompt(text, files, { cwd: directory });
    } catch (error) {
      setBindingError(sessionId, {
        code: error.code || 'ATTACHMENT_ERROR',
        message: error.message || 'Attachment mapping failed',
      });
      throw error;
    }

    emitHarnessEvents(broadcast, directory, buildUserMessageEvents(ctx, text, files));

    const canUseTool = createCanUseTool({
      sessionId,
      directory,
      getBroadcast,
      assistantMessageId,
    });

    // Bridge user/project OpenChamber MCP configs, then merge the in-process
    // OpenChamber control tool (if enabled). Control-tool failure must not block
    // the turn — Claude can still answer with bridged MCP alone.
    const bridgedMcpServers = buildClaudeMcpServersFromOpenChamber(directory);
    let controlMcpServers = null;
    try {
      controlMcpServers = await createOpenChamberMcpServers({ contextDirectory: directory });
    } catch (error) {
      console.warn(
        '[harness/claude-code] OpenChamber MCP injection failed:',
        error instanceof Error ? error.message : error,
      );
    }
    const mcpServers = {
      ...bridgedMcpServers,
      ...(controlMcpServers && typeof controlMcpServers === 'object' ? controlMcpServers : {}),
    };
    // Only forward MCP wildcards here. Bare names like Agent/Skill auto-approve in
    // the SDK and emit CLAUDE_SDK_CAN_USE_TOOL_SHADOWED, defeating canUseTool.
    // Agent/Task/Skill remain available via Claude defaults + skills:'all'.
    const allowedTools = buildMcpAllowedToolPatterns(mcpServers);

    const agentsMode = body?.agentsMode === 'claude' || body?.agentsMode === 'opencode'
      ? body.agentsMode
      : 'opencode';
    const systemPromptAppend = typeof body?.systemPromptAppend === 'string'
      ? body.systemPromptAppend.trim()
      : '';

    // OpenCode agents mode: keep Claude Code preset and append the OpenChamber
    // agent prompt. Claude agents mode: leave systemPrompt unset so the SDK
    // uses native Claude Code prompts/settings.
    /** @type {undefined | { type: 'preset', preset: 'claude_code', append?: string }} */
    let systemPrompt;
    if (agentsMode === 'opencode' && systemPromptAppend) {
      systemPrompt = {
        type: 'preset',
        preset: 'claude_code',
        append: systemPromptAppend,
      };
    }

    // Claude agents mode must not inherit a sticky OpenCode-derived permissionMode.
    const permissionMode = agentsMode === 'claude'
      ? undefined
      : binding.target?.permissionMode;

    let handle;
    try {
      handle = await startQuery({
        prompt: promptInput,
        cwd: directory,
        model: binding.target?.modelRef,
        resume: binding.foreignSessionId,
        permissionMode,
        effort: binding.target?.effort,
        systemPrompt,
        canUseTool,
        includePartialMessages: true,
        ...(Object.keys(mcpServers).length > 0 ? { mcpServers } : {}),
        ...(allowedTools.length > 0 ? { allowedTools } : {}),
        skills: 'all',
        settingSources: ['user', 'project', 'local'],
        forwardSubagentText: true,
        agentProgressSummaries: true,
      });
    } catch (error) {
      const wrapped = error instanceof Error ? error : new Error(String(error));
      if (!wrapped.code) wrapped.code = 'CLAUDE_SDK_UNAVAILABLE';
      if (!wrapped.statusCode) wrapped.statusCode = 503;
      setBindingError(sessionId, { code: wrapped.code, message: wrapped.message });
      emitHarnessEvents(broadcast, directory, [{
        type: 'session.status',
        properties: { sessionID: sessionId, status: { type: 'idle' } },
      }]);
      throw wrapped;
    }

    const activeTurn = { handle, ctx, aborting: false, idleEmitted: false };
    activeTurns.set(sessionId, activeTurn);
    const emitEvents = (events) => {
      if (events.some((event) => isIdleStatusEvent(event, sessionId))) {
        activeTurn.idleEmitted = true;
      }
      emitHarnessEvents(getBroadcast(), directory, events);
    };
    const emitIdleOnce = () => {
      if (activeTurn.idleEmitted) return;
      activeTurn.idleEmitted = true;
      emitHarnessEvents(getBroadcast(), directory, [{
        type: 'session.status',
        properties: { sessionID: sessionId, status: { type: 'idle' } },
      }]);
    };

    // Stream in background; HTTP returns accepted immediately.
    void (async () => {
      try {
        for await (const message of handle.stream) {
          const { events, foreignSessionId, capabilities } = mapClaudeMessageToEvents(ctx, message);
          if (foreignSessionId) {
            setForeignSessionId(sessionId, foreignSessionId);
          }
          if (capabilities) {
            updateSessionCapabilities(sessionId, capabilities);
          }
          emitEvents(events);
        }
        updateSessionBinding(sessionId, { lastError: undefined });
      } catch (error) {
        const active = activeTurns.get(sessionId);
        if (active?.aborting || activeTurn.aborting) {
          return;
        }
        const rawMessage = error instanceof Error ? error.message : 'Claude Code turn failed';
        const rawCode = error && typeof error === 'object' && 'code' in error
          ? String(error.code)
          : '';
        const isEnotdir = rawCode === 'ENOTDIR' || /spawn.*ENOTDIR/i.test(rawMessage);
        const message = isEnotdir
          ? 'Claude Code executable path is not spawnable (ENOTDIR). Reinstall/update Desktop or ensure `claude` is on PATH.'
          : rawMessage;
        setBindingError(sessionId, {
          code: isEnotdir ? 'CLAUDE_SPAWN_ENOTDIR' : 'CLAUDE_TURN_ERROR',
          message,
        });
        emitEvents([
          {
            type: 'session.status',
            properties: { sessionID: sessionId, status: { type: 'idle' } },
          },
          {
            type: 'session.error',
            properties: { sessionID: sessionId },
          },
        ]);
      } finally {
        try {
          rejectPendingForSession(sessionId);
        } catch {
          // cleanup must still close the turn and clear busy status
        }
        emitIdleOnce();
        try {
          handle.close();
        } catch {
          // ignore
        }
        activeTurns.delete(sessionId);
      }
    })();

    return {
      ok: true,
      sessionId,
      harnessId: 'claude-code',
      messageId: userMessageId,
      assistantMessageId,
      foreignSessionId: getSessionBinding(sessionId)?.foreignSessionId,
      status: 'started',
    };
  };

  /**
   * @param {{ sessionId: string }} body
   */
  const abort = async (body) => {
    const sessionId = typeof body?.sessionId === 'string' ? body.sessionId : '';
    if (!sessionId) {
      const error = new Error('sessionId is required');
      error.code = 'ABORT_INVALID';
      error.statusCode = 400;
      throw error;
    }

    const active = activeTurns.get(sessionId);
    const binding = getSessionBinding(sessionId);
    if (!active) {
      return { ok: true, sessionId, aborted: false, reason: 'no-active-turn' };
    }

    active.aborting = true;
    active.idleEmitted = true;
    try {
      rejectPendingForSession(sessionId);
    } catch {
      // abort cleanup must still close and remove the active turn
    }
    try {
      await interruptWithTimeout(active.handle);
    } catch {
      // ignore
    } finally {
      try {
        active.handle.close();
      } catch {
        // ignore
      }
      activeTurns.delete(sessionId);
    }

    if (binding?.directory) {
      // Close every part the interrupted turn left open first, otherwise those
      // tool/text parts keep spinning in the transcript forever.
      const abortedAssistantId = createOpenCodeId('msg');
      emitHarnessEvents(getBroadcast(), binding.directory, [
        ...buildTurnAbortEvents(active.ctx),
        // Emit MessageAbortedError so session-goal pauses immediately (same
        // contract as OpenCode abort), then idle for UI/status consumers.
        {
          type: 'message.updated',
          properties: {
            info: {
              id: abortedAssistantId,
              sessionID: sessionId,
              role: 'assistant',
              time: { created: Date.now(), completed: Date.now() },
              providerID: 'claude-code',
              modelID: binding.target?.modelRef || 'sonnet',
              agent: 'build',
              mode: 'build',
              error: {
                name: 'MessageAbortedError',
                data: { message: 'Aborted by user' },
              },
            },
          },
        },
        {
          type: 'session.status',
          properties: { sessionID: sessionId, status: { type: 'idle' } },
        },
      ]);
    }

    return { ok: true, sessionId, aborted: true };
  };

  /**
   * @param {{ sessionId: string, requestId: string, reply: 'once' | 'always' | 'reject', directory?: string }} body
   */
  const replyPermission = async (body) => replyPendingPermission(body);

  return {
    prompt,
    abort,
    replyPermission,
    /** @internal test helper */
    _activeTurns: activeTurns,
  };
}

export const claudeCodeTranslator = createClaudeCodeTranslator();
