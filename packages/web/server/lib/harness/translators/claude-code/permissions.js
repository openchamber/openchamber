/**
 * Claude Code canUseTool ↔ OpenChamber permission.asked / permission.replied bridge.
 * Fail-closed: unanswered prompts deny after timeout.
 */

import { createOpenCodeId } from '../../events/from-claude.js';
import { emitHarnessEvents } from '../../events/emit.js';

/** @typedef {'once' | 'always' | 'reject'} PermissionReply */

/**
 * @typedef {object} PendingPermission
 * @property {(result: object) => void} resolve
 * @property {(error: Error) => void} reject
 * @property {string} sessionId
 * @property {string} directory
 * @property {Record<string, unknown>} input
 * @property {unknown[] | undefined} suggestions
 * @property {ReturnType<typeof setTimeout> | null} timer
 * @property {() => ((payload: object, options?: object) => void) | null | undefined} getBroadcast
 */

/** @type {Map<string, PendingPermission>} */
const pending = new Map();

export const DEFAULT_PERMISSION_TIMEOUT_MS = 120_000;

/**
 * Tools injected by OpenChamber itself (Claude SDK MCP openchamber server).
 * These are already gated by `agentControlToolEnabled` and execute a fixed
 * allowlist through the control service — they must not also require a second
 * PermissionCard prompt (OpenCode's managed plugin has no equivalent gate).
 *
 * @param {string} toolName
 * @returns {boolean}
 */
export function isOpenChamberInjectedTool(toolName) {
  const name = typeof toolName === 'string' ? toolName.trim() : '';
  if (!name) return false;
  if (name === 'openchamber') return true;
  // Claude Agent SDK MCP tools are exposed as mcp__<server>__<tool>
  return name === 'mcp__openchamber__openchamber'
    || /^mcp__openchamber__/i.test(name);
}

/**
 * @param {Record<string, unknown>} input
 * @param {{ blockedPath?: string, title?: string }} [options]
 * @returns {string[]}
 */
export function extractPermissionPatterns(input, options = {}) {
  const patterns = [];
  const push = (value) => {
    if (typeof value !== 'string') return;
    const trimmed = value.trim();
    if (!trimmed || patterns.includes(trimmed)) return;
    patterns.push(trimmed);
  };

  if (input && typeof input === 'object') {
    push(input.command);
    push(input.cmd);
    push(input.path);
    push(input.file_path);
    push(input.filePath);
    push(input.filename);
    push(input.url);
  }
  push(options.blockedPath);
  push(options.title);
  return patterns;
}

/**
 * @param {Record<string, unknown>} input
 * @returns {Record<string, unknown>}
 */
function sanitizeToolInput(input) {
  if (!input || typeof input !== 'object') return {};
  /** @type {Record<string, unknown>} */
  const out = {};
  for (const [key, value] of Object.entries(input)) {
    if (/token|secret|password|authorization|credential|api[_-]?key|oauth/i.test(key)) {
      continue;
    }
    if (typeof value === 'string' && value.length > 8_000) {
      out[key] = `${value.slice(0, 8_000)}…`;
      continue;
    }
    out[key] = value;
  }
  return out;
}

/**
 * @param {PermissionReply} reply
 * @param {PendingPermission} entry
 * @returns {object}
 */
function mapReplyToPermissionResult(reply, entry) {
  if (reply === 'reject') {
    return {
      behavior: 'deny',
      message: 'Permission denied by user',
    };
  }

  const allow = {
    behavior: 'allow',
    updatedInput: entry.input && typeof entry.input === 'object' ? entry.input : {},
  };
  if (reply === 'always' && Array.isArray(entry.suggestions) && entry.suggestions.length > 0) {
    allow.updatedPermissions = entry.suggestions;
  }
  return allow;
}

/**
 * @param {string} requestId
 * @param {PendingPermission} entry
 * @param {PermissionReply} reply
 */
function settlePending(requestId, entry, reply) {
  if (entry.timer) {
    clearTimeout(entry.timer);
    entry.timer = null;
  }
  pending.delete(requestId);

  const result = mapReplyToPermissionResult(reply, entry);
  try {
    entry.resolve(result);
  } catch {
    // ignore double-settle
  }

  const broadcast = typeof entry.getBroadcast === 'function' ? entry.getBroadcast() : null;
  emitHarnessEvents(broadcast, entry.directory, [{
    type: 'permission.replied',
    properties: {
      sessionID: entry.sessionId,
      requestID: requestId,
    },
  }]);
}

/**
 * Build Always-Allow patterns for the OpenChamber PermissionCard.
 * Prefer concrete command/path patterns; fall back to the tool name so
 * "Always Allow" remains available and labeled (full permissions support).
 *
 * @param {string[]} patterns
 * @param {string} toolName
 * @returns {string[]}
 */
export function buildAlwaysPatterns(patterns, toolName) {
  if (Array.isArray(patterns) && patterns.length > 0) {
    return [...patterns];
  }
  const tool = typeof toolName === 'string' && toolName.trim() ? toolName.trim() : 'tool';
  return [tool];
}

/**
 * Create an Agent SDK canUseTool callback for one OpenChamber session.
 *
 * @param {object} params
 * @param {string} params.sessionId
 * @param {string} params.directory
 * @param {() => ((payload: object, options?: object) => void) | null | undefined} params.getBroadcast
 * @param {number} [params.timeoutMs]
 * @param {() => string} [params.createId]
 * @param {string} [params.assistantMessageId]
 * @returns {(toolName: string, input: Record<string, unknown>, options: object) => Promise<object>}
 */
export function createCanUseTool(params) {
  const sessionId = typeof params?.sessionId === 'string' ? params.sessionId : '';
  const directory = typeof params?.directory === 'string' ? params.directory : '';
  const getBroadcast = typeof params?.getBroadcast === 'function' ? params.getBroadcast : () => null;
  const timeoutMs = Number.isFinite(params?.timeoutMs) && params.timeoutMs > 0
    ? params.timeoutMs
    : DEFAULT_PERMISSION_TIMEOUT_MS;
  const createId = typeof params?.createId === 'function'
    ? params.createId
    : () => createOpenCodeId('perm');
  const assistantMessageId = typeof params?.assistantMessageId === 'string'
    ? params.assistantMessageId
    : '';

  return async (toolName, input, options = {}) => {
    if (!sessionId || !directory) {
      return {
        behavior: 'deny',
        message: 'Permission bridge misconfigured',
      };
    }

    if (options?.signal?.aborted) {
      return {
        behavior: 'deny',
        message: 'Permission request aborted',
      };
    }

    const safeInput = input && typeof input === 'object' ? input : {};
    if (isOpenChamberInjectedTool(toolName)) {
      return {
        behavior: 'allow',
        updatedInput: safeInput,
      };
    }

    const requestId = createId();
    const tool = typeof toolName === 'string' && toolName.trim() ? toolName.trim() : 'tool';
    const patterns = extractPermissionPatterns(safeInput, {
      blockedPath: typeof options.blockedPath === 'string' ? options.blockedPath : undefined,
      title: typeof options.title === 'string' ? options.title : undefined,
    });
    const always = buildAlwaysPatterns(patterns, tool);

    /** @type {Record<string, unknown>} */
    const metadata = {
      ...sanitizeToolInput(safeInput),
      ...(typeof options.title === 'string' ? { title: options.title } : {}),
      ...(typeof options.description === 'string' ? { description: options.description } : {}),
      ...(typeof options.decisionReason === 'string' ? { decisionReason: options.decisionReason } : {}),
      ...(typeof options.displayName === 'string' ? { displayName: options.displayName } : {}),
      ...(typeof options.toolUseID === 'string' ? { toolUseID: options.toolUseID } : {}),
      ...(typeof options.requestId === 'string' ? { sdkRequestId: options.requestId } : {}),
      always,
    };

    const permissionRequest = {
      id: requestId,
      sessionID: sessionId,
      permission: tool,
      patterns,
      metadata,
      always,
      ...(typeof options.toolUseID === 'string' ? {
        tool: {
          messageID: assistantMessageId,
          callID: options.toolUseID,
        },
      } : {}),
    };

    const broadcast = getBroadcast();
    emitHarnessEvents(broadcast, directory, [{
      type: 'permission.asked',
      properties: permissionRequest,
    }]);

    return new Promise((resolve, reject) => {
      /** @type {PendingPermission} */
      const entry = {
        resolve,
        reject,
        sessionId,
        directory,
        input: safeInput,
        suggestions: Array.isArray(options.suggestions) ? options.suggestions : undefined,
        timer: null,
        getBroadcast,
      };

      entry.timer = setTimeout(() => {
        if (!pending.has(requestId)) return;
        settlePending(requestId, entry, 'reject');
      }, timeoutMs);

      pending.set(requestId, entry);

      if (options?.signal && typeof options.signal.addEventListener === 'function') {
        options.signal.addEventListener('abort', () => {
          if (!pending.has(requestId)) return;
          settlePending(requestId, entry, 'reject');
        }, { once: true });
      }
    });
  };
}

/**
 * Resolve a pending canUseTool promise from the UI reply route.
 *
 * @param {object} body
 * @param {string} body.sessionId
 * @param {string} body.requestId
 * @param {PermissionReply} body.reply
 * @param {string} [body.directory]
 * @returns {{ ok: true, sessionId: string, requestId: string, reply: PermissionReply }}
 */
export function replyPermission(body) {
  const sessionId = typeof body?.sessionId === 'string' ? body.sessionId : '';
  const requestId = typeof body?.requestId === 'string' ? body.requestId : '';
  const reply = body?.reply;

  if (!sessionId || !requestId) {
    const error = new Error('sessionId and requestId are required');
    error.code = 'PERMISSION_REPLY_INVALID';
    error.statusCode = 400;
    throw error;
  }
  if (reply !== 'once' && reply !== 'always' && reply !== 'reject') {
    const error = new Error('reply must be once, always, or reject');
    error.code = 'PERMISSION_REPLY_INVALID';
    error.statusCode = 400;
    throw error;
  }

  const entry = pending.get(requestId);
  if (!entry) {
    const error = new Error('Permission request not found');
    error.code = 'PERMISSION_NOT_FOUND';
    error.statusCode = 404;
    throw error;
  }
  if (entry.sessionId !== sessionId) {
    const error = new Error('Permission request does not belong to this session');
    error.code = 'PERMISSION_SESSION_MISMATCH';
    error.statusCode = 409;
    throw error;
  }

  settlePending(requestId, entry, reply);
  return { ok: true, sessionId, requestId, reply };
}

/**
 * Fail-closed: deny all pending prompts for a session (abort / turn end).
 * @param {string} sessionId
 * @returns {number} settled count
 */
export function rejectPendingForSession(sessionId) {
  if (typeof sessionId !== 'string' || !sessionId) return 0;
  let count = 0;
  for (const [requestId, entry] of Array.from(pending.entries())) {
    if (entry.sessionId !== sessionId) continue;
    settlePending(requestId, entry, 'reject');
    count += 1;
  }
  return count;
}

/** @returns {number} */
export function getPendingPermissionCount() {
  return pending.size;
}

/**
 * Pending bridged permission requests for auto-accept reconcile.
 * @returns {Array<{ id: string, sessionID: string, directory: string }>}
 */
export function listPendingPermissions() {
  return Array.from(pending.entries()).map(([id, entry]) => ({
    id,
    sessionID: entry.sessionId,
    directory: entry.directory,
  }));
}

/** Test helper — clears pending map and timers. */
export function resetPendingPermissions() {
  for (const entry of pending.values()) {
    if (entry.timer) clearTimeout(entry.timer);
  }
  pending.clear();
}
