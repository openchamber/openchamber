/**
 * Thin wrapper around @anthropic-ai/claude-agent-sdk query()/interrupt.
 * Import failure is surfaced as unavailable — detect must not report ready.
 */

import { spawnSync } from 'node:child_process';
import { buildClaudeCodeChildEnv } from './auth-env.js';
import {
  assertClaudeWorkingDirectory,
  resolveClaudeCodeExecutable,
} from './executable-path.js';

/**
 * Claude permission mode is inherited from the selected agent's edit permission
 * on every send (`claudePermissionModeFromEditPermission`), never configured on
 * its own. These are the only three values that mapping can produce.
 *
 * Auto-approve is a separate mechanism that answers the `canUseTool` bridge, so
 * a bypass mode must never be forwarded — it would defeat that bridge entirely.
 */
const ALLOWED_PERMISSION_MODES = new Set(['default', 'acceptEdits', 'plan']);

let sdkModulePromise = null;
/** @type {Error | null} */
let sdkLoadError = null;
/** @type {typeof import('@anthropic-ai/claude-agent-sdk') | null} */
let sdkModule = null;

/**
 * @returns {Promise<typeof import('@anthropic-ai/claude-agent-sdk')>}
 */
export async function loadClaudeAgentSdk() {
  if (sdkModule) return sdkModule;
  if (sdkLoadError) throw sdkLoadError;
  if (!sdkModulePromise) {
    sdkModulePromise = import('@anthropic-ai/claude-agent-sdk')
      .then((mod) => {
        sdkModule = mod;
        return mod;
      })
      .catch((error) => {
        sdkLoadError = error instanceof Error
          ? error
          : new Error(String(error?.message || error || 'Failed to load Claude Agent SDK'));
        sdkModulePromise = null;
        throw sdkLoadError;
      });
  }
  return sdkModulePromise;
}

/**
 * Reset cached SDK load state (tests only).
 */
export function resetClaudeAgentSdkCache() {
  sdkModule = null;
  sdkModulePromise = null;
  sdkLoadError = null;
}

/**
 * @returns {{ available: boolean, error?: string }}
 */
export function getClaudeAgentSdkAvailability() {
  if (sdkModule) return { available: true };
  if (sdkLoadError) {
    return { available: false, error: sdkLoadError.message || 'Claude Agent SDK unavailable' };
  }
  return { available: false, error: 'Claude Agent SDK not loaded' };
}

/**
 * Best-effort probe whether the SDK package can be imported.
 * @returns {Promise<{ available: boolean, error?: string }>}
 */
export async function probeClaudeAgentSdk() {
  try {
    await loadClaudeAgentSdk();
    return { available: true };
  } catch (error) {
    return {
      available: false,
      error: error instanceof Error ? error.message : 'Claude Agent SDK unavailable',
    };
  }
}

/**
 * Tree-kill a process (and process group when possible).
 * @param {number | null | undefined} pid
 * @param {{ signal?: NodeJS.Signals, force?: boolean }} [options]
 */
export function killProcessTree(pid, options = {}) {
  if (!Number.isInteger(pid) || pid <= 0) return;
  const signal = options.signal || 'SIGTERM';
  if (process.platform === 'win32') {
    try {
      spawnSync('taskkill', ['/PID', String(pid), '/T', '/F'], {
        stdio: 'ignore',
        timeout: 5000,
        windowsHide: true,
      });
    } catch {
      // best-effort
    }
    return;
  }

  try {
    process.kill(-pid, signal);
  } catch {
    // process group may not exist
  }
  try {
    process.kill(pid, signal);
  } catch {
    // already gone
  }

  if (options.force) {
    try {
      process.kill(-pid, 'SIGKILL');
    } catch {
      // ignore
    }
    try {
      process.kill(pid, 'SIGKILL');
    } catch {
      // ignore
    }
  }
}

/**
 * @typedef {object} ClaudeQueryHandle
 * @property {AsyncIterable<unknown>} stream
 * @property {() => Promise<void>} interrupt
 * @property {() => void} close
 * @property {() => number | null | undefined} getPid
 */

/**
 * Start a Claude Agent SDK query with subscription-only env.
 *
 * @param {object} params
 * @param {string | AsyncIterable<unknown>} params.prompt
 * @param {string} params.cwd
 * @param {string} [params.model]
 * @param {string} [params.resume]
 * @param {string} [params.permissionMode]
 * @param {string} [params.effort]
 * @param {string | { type: 'preset', preset: 'claude_code', append?: string }} [params.systemPrompt]
 * @param {(toolName: string, input: Record<string, unknown>, options: object) => Promise<object | null>} [params.canUseTool]
 * @param {Record<string, string | undefined>} [params.env]
 * @param {boolean} [params.includePartialMessages]
 * @param {Record<string, unknown>} [params.mcpServers]
 * @param {string[]} [params.allowedTools]
 * @param {Record<string, object>} [params.agents]
 * @param {string[] | 'all'} [params.skills]
 * @param {Array<'user' | 'project' | 'local'>} [params.settingSources]
 * @param {boolean} [params.forwardSubagentText]
 * @param {boolean} [params.agentProgressSummaries]
 * @param {(mod: typeof import('@anthropic-ai/claude-agent-sdk')) => unknown} [params.queryImpl]
 * @returns {Promise<ClaudeQueryHandle>}
 */
export async function startClaudeQuery(params) {
  const sdk = await loadClaudeAgentSdk();
  const queryFn = typeof params.queryImpl === 'function'
    ? params.queryImpl
    : sdk.query;

  if (typeof queryFn !== 'function') {
    const error = new Error('Claude Agent SDK query() is unavailable');
    error.code = 'CLAUDE_SDK_UNAVAILABLE';
    error.statusCode = 503;
    throw error;
  }

  const env = buildClaudeCodeChildEnv(params.env || process.env);
  const cwd = assertClaudeWorkingDirectory(params.cwd);
  const pathToClaudeCodeExecutable = typeof params.pathToClaudeCodeExecutable === 'string'
    && params.pathToClaudeCodeExecutable.trim()
    ? params.pathToClaudeCodeExecutable.trim()
    : resolveClaudeCodeExecutable({ env });

  const options = {
    cwd,
    env,
    includePartialMessages: params.includePartialMessages !== false,
    // Nested Agent transcripts + progress so OpenChamber can render subagents.
    forwardSubagentText: params.forwardSubagentText !== false,
    agentProgressSummaries: params.agentProgressSummaries !== false,
    // Load user/project/local Claude settings so .claude/{commands,agents,skills}
    // and project .mcp.json participate (matches CLI defaults when omitted, but
    // set explicitly so capability "full" is intentional).
    settingSources: Array.isArray(params.settingSources)
      ? params.settingSources
      : ['user', 'project', 'local'],
  };
  if (pathToClaudeCodeExecutable) {
    // Avoid Electron asar ENOTDIR when the SDK resolves a path inside app.asar.
    options.pathToClaudeCodeExecutable = pathToClaudeCodeExecutable;
  }
  if (typeof params.model === 'string' && params.model.trim()) {
    options.model = params.model.trim();
  }
  if (typeof params.resume === 'string' && params.resume.trim()) {
    options.resume = params.resume.trim();
  }
  // Fail closed: only modes the UI can legitimately produce are forwarded. A
  // client-supplied `bypassPermissions` must never bypass the canUseTool bridge.
  const permissionMode = typeof params.permissionMode === 'string'
    ? params.permissionMode.trim()
    : '';
  if (ALLOWED_PERMISSION_MODES.has(permissionMode)) {
    options.permissionMode = permissionMode;
  }
  if (typeof params.effort === 'string' && params.effort.trim()) {
    options.effort = params.effort.trim();
  }
  if (typeof params.canUseTool === 'function') {
    options.canUseTool = params.canUseTool;
  }
  if (params.mcpServers && typeof params.mcpServers === 'object') {
    options.mcpServers = params.mcpServers;
  }
  // System prompt: string custom, or Claude Code preset (+ optional OpenCode agent append).
  if (typeof params.systemPrompt === 'string' && params.systemPrompt.trim()) {
    options.systemPrompt = params.systemPrompt.trim();
  } else if (params.systemPrompt && typeof params.systemPrompt === 'object' && !Array.isArray(params.systemPrompt)) {
    const preset = params.systemPrompt;
    if (preset.type === 'preset' && preset.preset === 'claude_code') {
      /** @type {{ type: 'preset', preset: 'claude_code', append?: string }} */
      const systemPrompt = { type: 'preset', preset: 'claude_code' };
      if (typeof preset.append === 'string' && preset.append.trim()) {
        systemPrompt.append = preset.append.trim();
      }
      options.systemPrompt = systemPrompt;
    }
  }
  if (params.mcpServers && typeof params.mcpServers === 'object' && !Array.isArray(params.mcpServers)) {
    const names = Object.keys(params.mcpServers);
    if (names.length > 0) {
      options.mcpServers = params.mcpServers;
    }
  }
  if (Array.isArray(params.allowedTools) && params.allowedTools.length > 0) {
    options.allowedTools = params.allowedTools.filter((tool) => typeof tool === 'string' && tool.trim());
  }
  if (params.agents && typeof params.agents === 'object' && !Array.isArray(params.agents)) {
    const names = Object.keys(params.agents);
    if (names.length > 0) {
      options.agents = params.agents;
    }
  }
  if (params.skills === 'all' || (Array.isArray(params.skills) && params.skills.length > 0)) {
    options.skills = params.skills;
  } else if (params.skills === undefined) {
    // Enable every discovered skill so /skill and Skill tool work on Claude sessions.
    options.skills = 'all';
  }

  let result;
  try {
    result = queryFn({
      prompt: params.prompt,
      options,
    });
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    const code = error && typeof error === 'object' && 'code' in error
      ? error.code
      : undefined;
    if (code === 'ENOTDIR' || /spawn.*ENOTDIR/i.test(message)) {
      const wrapped = new Error(
        'Claude Code executable path is not spawnable (ENOTDIR). '
        + 'Packaged Desktop must use PATH/`app.asar.unpacked` Claude CLI, not an `app.asar` path.',
      );
      wrapped.code = 'CLAUDE_SPAWN_ENOTDIR';
      wrapped.statusCode = 503;
      wrapped.cause = error;
      throw wrapped;
    }
    throw error;
  }

  let closed = false;
  const getPid = () => {
    if (result && typeof result === 'object' && 'pid' in result) {
      return result.pid;
    }
    return null;
  };

  const interrupt = async () => {
    if (result && typeof result.interrupt === 'function') {
      try {
        await result.interrupt();
      } catch {
        // fall through to tree-kill
      }
    }
    killProcessTree(getPid(), { signal: 'SIGTERM' });
  };

  const close = () => {
    if (closed) return;
    closed = true;
    killProcessTree(getPid(), { signal: 'SIGTERM', force: true });
    if (result && typeof result.return === 'function') {
      try {
        // Must swallow the rejection too — an unhandled one would take the
        // whole server process down.
        Promise.resolve(result.return()).catch(() => {});
      } catch {
        // ignore
      }
    }
  };

  return {
    stream: result,
    interrupt,
    close,
    getPid,
  };
}
