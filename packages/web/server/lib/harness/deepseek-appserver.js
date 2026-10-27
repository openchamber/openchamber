/**
 * deepseek-appserver.js — ACP (Agent Client Protocol) client / protocol layer.
 *
 * Spawns `dsh --profile acp` (overridable via `DEEPSEEK_DSH_BIN` / `DEEPSEEK_DSH_ARGS`)
 * as a line-delimited JSON-RPC 2.0 stdio subprocess and drives the agent-side
 * ACP surface:
 *
 *   initialize, session/new, session/resume, session/list,
 *   session/set_config_option, session/close, session/prompt;
 *   session/cancel (outbound notification);
 *   session/update (inbound notification) → typed internal events;
 *   session/request_permission (inbound request) → round-trip to the host.
 *
 * This module owns process lifecycle (per workspace directory), the initialize
 * handshake, crash detection + restart with exponential backoff, and the
 * permission request/reply round-trip. It contains no OpenChamber web types;
 * `deepseek-backend.js` maps its output onto the harness contract.
 *
 * One ACP process per workspace directory; every `session/new` pins that
 * directory as the session cwd.
 *
 * @module
 */

import { existsSync, accessSync, constants as fsConstants } from 'fs';
import { delimiter, join } from 'path';

import { createJsonRpcSubprocess } from './jsonrpc-subprocess.js';

/** ACP protocol version we advertise. Server echoes/negotiates its own. */
export const ACP_PROTOCOL_VERSION = 1;

/** Default CLI args when `DEEPSEEK_DSH_ARGS` is unset. */
const DEFAULT_DSH_ARGS = ['--profile', 'acp'];

/** Long turns must not hit the 20s request default. */
const PROMPT_TIMEOUT_MS = 8 * 60 * 60 * 1000;

/** Restart backoff for a directory whose process died. */
const BACKOFF_BASE_MS = 250;
const BACKOFF_CAP_MS = 5_000;

/**
 * @typedef {Object} AcpPermissionRequest
 * @property {string} requestId            Stable id the host echoes back on reply.
 * @property {string} sessionId            ACP session id.
 * @property {string} directory            Workspace directory of the process.
 * @property {object} params               Raw `session/request_permission` params.
 */

/**
 * @typedef {Object} AcpSessionUpdate
 * @property {string} sessionId
 * @property {object} update               Raw `session/update` payload.
 */

/**
 * @typedef {Object} AcpSessionState
 * @property {string} sessionId
 * @property {string} directory
 * @property {object[]} configOptions      Latest ACP configOptions (may include `model`).
 * @property {object|null} models          Legacy ACP `models` field, when present.
 */

const sleep = (ms) => new Promise((r) => setTimeout(r, ms > 0 ? ms : 0));

/**
 * Split a `DEEPSEEK_DSH_ARGS` string into argv, honouring single/double quotes.
 * @param {string} raw
 * @returns {string[]}
 */
const parseArgsString = (raw) => {
  const out = [];
  const re = /"([^"]*)"|'([^']*)'|(\S+)/g;
  let m;
  while ((m = re.exec(raw)) !== null) {
    out.push(m[1] ?? m[2] ?? m[3]);
  }
  return out;
};

/**
 * Resolve the dsh binary on PATH (no spawn), using a
 * non-blocking probe. Returns the command name either way; `found` is honest.
 * @param {string} command
 * @param {NodeJS.ProcessEnv} env
 */
const resolveOnPath = (command, env) => {
  if (command.includes('/') || (process.platform === 'win32' && command.includes('\\'))) {
    return { command, found: existsSync(command) };
  }
  const pathValue = env.PATH || env.Path || '';
  const exts = process.platform === 'win32' ? ['.exe', '.cmd', '.bat', ''] : [''];
  for (const dir of pathValue.split(delimiter)) {
    if (!dir) continue;
    for (const ext of exts) {
      const candidate = join(dir, command + ext);
      if (existsSync(candidate)) {
        try {
          accessSync(candidate, fsConstants.X_OK);
          return { command: candidate, found: true };
        } catch {
          // fall through to plain existence
        }
      }
    }
  }
  return { command, found: false };
};

/**
 * Create the ACP app-server adapter.
 *
 * @param {Object} deps
 * @param {object} deps.crypto  Node crypto module (for request ids).
 * @param {NodeJS.ProcessEnv} [deps.env]  Environment for spawn + binary resolution.
 * @param {{ info?: Function, warn?: Function, error?: Function }} [deps.logger]
 * @param {() => number} [deps.now]
 * @param {(update: AcpSessionUpdate) => void} [deps.onSessionUpdate]
 * @param {(req: AcpPermissionRequest) => void} [deps.onPermissionRequest]
 * @param {(method: string, params: object) => void} [deps.onUnknownNotification]
 */
export const createDeepSeekAppServerAdapter = (deps = {}) => {
  const {
    crypto,
    env = process.env,
    logger = console,
    now = () => Date.now(),
    onSessionUpdate = () => {},
    onPermissionRequest = () => {},
    onUnknownNotification = () => {},
  } = deps;

  /** @type {Map<string, { proc: any, directory: string, initPromise: Promise<any>|null, restarts: number, diedAt: number|null, sessions: Map<string, AcpSessionState> }>} */
  const processes = new Map();
  const connecting = new Map();
  /** @type {Map<string, { respond: (result: unknown, error?: object) => void, sessionId: string, params: object }>} */
  const pendingPermissions = new Map();
  let shutdownRequested = false;

  const createRequestId = () =>
    typeof crypto?.randomUUID === 'function'
      ? crypto.randomUUID()
      : `perm-${now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`;

  const resolveBinary = () => {
    const command = env.DEEPSEEK_DSH_BIN || 'dsh';
    const args = env.DEEPSEEK_DSH_ARGS ? parseArgsString(env.DEEPSEEK_DSH_ARGS) : DEFAULT_DSH_ARGS.slice();
    return { command, args };
  };

  const isAvailable = () => resolveOnPath(resolveBinary().command, env).found;

  /** @param {object} handle */
  const handleInboundRequest = (handle, id, method, params) => {
    if (method === 'session/request_permission') {
      const requestId = createRequestId();
      const respond = (result, error) => {
        if (!handle.proc.isAlive()) return;
        handle.proc.sendResponse(id, result, error);
      };
      pendingPermissions.set(requestId, { respond, sessionId: params?.sessionId, params, owner: handle });
      onPermissionRequest({
        requestId,
        sessionId: params?.sessionId,
        directory: handle.directory,
        params,
      });
      return;
    }
    // We advertise no client capabilities, so fs/* should not arrive; if it
    // does, answer null rather than leave the server hanging.
    handle.proc.sendResponse(id, null);
  };

  /** @param {object} handle */
  const handleInboundNotification = (handle, method, params) => {
    if (method === 'session/update') {
      const sessionId = params?.sessionId;
      const state = handle.sessions.get(sessionId);
      if (state && params?.update) {
        if (Array.isArray(params.update.configOptions)) {
          state.configOptions = params.update.configOptions;
        }
      }
      onSessionUpdate({ sessionId, directory: handle.directory, update: params?.update });
      return;
    }
    onUnknownNotification(method, params);
  };

  let spawnCount = 0;

  /** Spawn + initialize one process for a directory. */
  const spawnProcess = (directory) => {
    spawnCount += 1;
    const { command, args } = resolveBinary();
    /** @type {object} */
    const handle = {
      proc: null,
      directory,
      initPromise: null,
      restarts: 0,
      diedAt: null,
      sessions: new Map(),
    };

    const proc = createJsonRpcSubprocess({
      command,
      args,
      cwd: directory,
      env,
      onRequest: (id, method, params) => handleInboundRequest(handle, id, method, params),
      onNotification: (method, params) => handleInboundNotification(handle, method, params),
      onError: (err) => logger.warn?.(`[deepseek-appserver] ${directory}: ${err?.message ?? err}`),
      onExit: (code, signal) => {
        handle.diedAt = now();
        const reason = new Error(`dsh acp exited (code=${code}, signal=${signal})`);
        // Resolve (as cancelled) any approval this process still owes. Otherwise the
        // approval UI keeps showing a request that can never be answered.
        for (const [requestId, pending] of pendingPermissions) {
          if (pending.owner !== handle) continue; // another directory's approval
          pendingPermissions.delete(requestId);
          try { pending.respond({ outcome: { outcome: 'cancelled' } }); } catch { /* gone */ }
        }
        if (!shutdownRequested) {
          logger.warn?.(`[deepseek-appserver] ${directory}: ${reason.message}`);
          handle.pendingExitReason = reason;
        }
      },
    });
    handle.proc = proc;

    handle.initPromise = (async () => {
      try {
        const result = await proc.sendRequest('initialize', {
          protocolVersion: ACP_PROTOCOL_VERSION,
          clientCapabilities: {},
          clientInfo: { name: 'openchamber-deepseek-adapter', version: '1.0.0' },
        });
        handle.protocolVersion = result?.protocolVersion ?? ACP_PROTOCOL_VERSION;
        handle.agentCapabilities = result?.agentCapabilities ?? {};
      } catch (err) {
        // Don't orphan the child if the handshake fails.
        try { await proc.shutdown({ grace: 0 }); } catch { /* already gone */ }
        throw err;
      }
    })();

    return handle;
  };

  /** Get (or lazily (re)spawn) the live process for a directory. */
  const connectProcess = async (directory) => {
    // Single-flight: concurrent connect() calls for the same directory while a
    // process is being (re)spawned must share one spawn, otherwise the loser's
    // child is orphaned (processes.set would only retain the last handle).
    const inFlight = connecting.get(directory);
    if (inFlight) return inFlight;
    const pending = connectProcessInner(directory);
    connecting.set(directory, pending);
    try {
      return await pending;
    } finally {
      connecting.delete(directory);
    }
  };

  const connectProcessInner = async (directory) => {
    let handle = processes.get(directory);
    if (handle && handle.proc.isAlive()) {
      await handle.initPromise;
      return handle;
    }
    if (handle && !handle.proc.isAlive()) {
      // Backoff before respawning a directory that just died.
      const wanted = Math.min(BACKOFF_BASE_MS * 2 ** handle.restarts, BACKOFF_CAP_MS);
      const elapsed = handle.diedAt ? now() - handle.diedAt : wanted;
      if (elapsed < wanted) await sleep(wanted - elapsed);
    }
    const restarts = handle ? handle.restarts + 1 : 0;
    handle = spawnProcess(directory);
    handle.restarts = restarts;
    try {
      await handle.initPromise;
      handle.restarts = 0;
    } catch (err) {
      handle.restarts = restarts + 1;
      throw err;
    }
    processes.set(directory, handle);
    return handle;
  };

  const sessionState = (handle, sessionId) => handle.sessions.get(sessionId) ?? null;

  const adoptResponse = (handle, directory, result) => {
    if (result?.sessionId) {
      handle.sessions.set(result.sessionId, {
        sessionId: result.sessionId,
        directory,
        configOptions: Array.isArray(result.configOptions) ? result.configOptions : [],
        models: result.models ?? null,
      });
    }
    return result;
  };

  return {
    /** @returns {boolean} */
    isAvailable,
    /** @returns {{ command: string, args: string[] }} */
    resolveBinary,

    /**
     * Create a new ACP session in `directory`.
     * @param {{ directory: string, mcpServers?: object[] }} input
     */
    newSession: async ({ directory, mcpServers = [] }) => {
      const handle = await connectProcess(directory);
      const result = await handle.proc.sendRequest('session/new', {
        cwd: directory,
        mcpServers,
      });
      return adoptResponse(handle, directory, result);
    },

    /**
     * Resume an existing ACP session (ACP has no `session/load`; dsh uses
     * `session/resume`).
     * @param {{ directory: string, sessionId: string, mcpServers?: object[] }} input
     */
    resumeSession: async ({ directory, sessionId, mcpServers = [] }) => {
      const handle = await connectProcess(directory);
      const result = await handle.proc.sendRequest('session/resume', {
        sessionId,
        cwd: directory,
        mcpServers,
      });
      return adoptResponse(handle, directory, result);
    },

    /**
     * List persisted sessions (ACP filters out sessions active in this process).
     * @param {{ directory: string, cursor?: string }} input
     */
    listSessions: async ({ directory, cursor }) => {
      const handle = await connectProcess(directory);
      const params = { cwd: directory };
      if (cursor) params.cursor = cursor;
      return handle.proc.sendRequest('session/list', params);
    },

    /**
     * Select a config option (used for model). Returns the updated configOptions.
     * @param {{ directory: string, sessionId: string, configId: string, value: string }} input
     */
    setConfigOption: async ({ directory, sessionId, configId, value }) => {
      const handle = await connectProcess(directory);
      const result = await handle.proc.sendRequest('session/set_config_option', {
        sessionId,
        configId,
        value,
      });
      const state = sessionState(handle, sessionId);
      if (state && Array.isArray(result?.configOptions)) {
        state.configOptions = result.configOptions;
      }
      return result;
    },

    /**
     * Send a prompt and resolve with `{ stopReason }`.
     * @param {{ directory: string, sessionId: string, contentBlocks: object[], signal?: AbortSignal }} input
     * @returns {Promise<{ stopReason: string }>}
     */
    prompt: async ({ directory, sessionId, contentBlocks, signal }) => {
      const handle = await connectProcess(directory);
      const onAbort = () => {
        try {
          handle.proc.sendNotification('session/cancel', { sessionId });
        } catch {
          // best effort
        }
      };
      signal?.addEventListener('abort', onAbort, { once: true });
      try {
        const result = await handle.proc.sendRequest(
          'session/prompt',
          { sessionId, prompt: contentBlocks },
          { timeout: PROMPT_TIMEOUT_MS },
        );
        return { stopReason: result?.stopReason ?? 'end_turn' };
      } finally {
        signal?.removeEventListener('abort', onAbort);
      }
    },

    /** Best-effort cancel of an in-flight prompt. */
    cancel: async ({ directory, sessionId }) => {
      const handle = processes.get(directory);
      if (!handle || !handle.proc.isAlive()) return;
      handle.proc.sendNotification('session/cancel', { sessionId });
    },

    /** Close a session on the server. */
    closeSession: async ({ directory, sessionId }) => {
      const handle = processes.get(directory);
      if (!handle || !handle.proc.isAlive()) return null;
      try {
        return await handle.proc.sendRequest('session/close', { sessionId });
      } catch {
        return null;
      } finally {
        handle.sessions.delete(sessionId);
      }
    },

    /**
     * Answer a pending `session/request_permission`.
     * @param {string} requestId
     * @param {string|null} optionId  null → cancelled outcome.
     * @returns {boolean} whether the request was pending.
     */
    resolvePermission: (requestId, optionId) => {
      const entry = pendingPermissions.get(requestId);
      if (!entry) return false;
      pendingPermissions.delete(requestId);
      if (optionId) {
        entry.respond({ outcome: { outcome: 'selected', optionId } });
      } else {
        entry.respond({ outcome: { outcome: 'cancelled' } });
      }
      return true;
    },

    /** @returns {boolean} */
    hasPermissionRequest: (requestId) => pendingPermissions.has(requestId),

    /** Snapshot of a live session's configOptions, if known. */
    getSessionConfig: ({ directory, sessionId }) => {
      const handle = processes.get(directory);
      return handle ? sessionState(handle, sessionId) : null;
    },

    /** Whether the live process for `directory` knows `sessionId`. */
    hasSession: ({ directory, sessionId }) => {
      const handle = processes.get(directory);
      return Boolean(handle && handle.proc.isAlive() && handle.sessions.has(sessionId));
    },

    /** Terminate every managed process. */
    shutdown: async () => {
      shutdownRequested = true;
      const handles = [...processes.values()];
      processes.clear();
      await Promise.allSettled(handles.map((h) => h.proc.shutdown({ grace: 1000 })));
    },

    /** Exposed for tests / diagnostics. */
    _processes: processes,
    /** Number of child processes ever spawned (diagnostics). */
    _spawnCount: () => spawnCount,
  };
};

/**
 * Translate an OpenChamber message part list into ACP content blocks.
 * Text parts concatenate; file/image parts with a `data:`/base64 payload become
 * `image` blocks. Honest: unknown parts degrade to text.
 *
 * @param {object[]} parts
 * @returns {object[]} ACP ContentBlock[]
 */
export const partsToAcpContentBlocks = (parts = []) => {
  const blocks = [];
  const textChunks = [];
  for (const part of Array.isArray(parts) ? parts : []) {
    if (!part || typeof part !== 'object') continue;
    if (part.type === 'image' && typeof part.dataUrl === 'string') {
      const match = /^data:([^;]+);base64,(.*)$/.exec(part.dataUrl);
      if (match) {
        if (textChunks.length) {
          blocks.push({ type: 'text', text: textChunks.join('\n') });
          textChunks.length = 0;
        }
        blocks.push({ type: 'image', mimeType: match[1] || 'image/png', data: match[2] });
        continue;
      }
    }
    if (part.type === 'file' && typeof part.path === 'string') {
      textChunks.push(`File: ${part.path}`);
      continue;
    }
    if (typeof part.text === 'string') textChunks.push(part.text);
    else if (typeof part.content === 'string') textChunks.push(part.content);
  }
  if (textChunks.length) blocks.push({ type: 'text', text: textChunks.join('\n') });
  return blocks;
};
