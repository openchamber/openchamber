/**
 * Harness prompt/abort dispatch.
 */

import { createClaudeCodeTranslator } from './translators/claude-code/index.js';
import { createOpenCodeTranslator } from './translators/opencode/index.js';

/**
 * @param {object} [deps]
 */
export function createHarnessRouter(deps = {}) {
  const getBroadcast = deps.getBroadcast || (() => null);
  const claude = deps.claudeTranslator || createClaudeCodeTranslator({
    getBroadcast,
    createOpenChamberMcpServers: deps.createOpenChamberMcpServers,
  });
  const opencode = deps.opencodeTranslator || createOpenCodeTranslator();

  /**
   * @param {object} body
   */
  const prompt = async (body) => {
    const harnessId = body?.target?.harnessId || body?.harnessId;
    if (harnessId === 'opencode') {
      return opencode.prompt(body);
    }
    if (harnessId === 'claude-code') {
      return claude.prompt(body);
    }
    const error = new Error(harnessId
      ? `Unsupported harnessId: ${harnessId}`
      : 'target.harnessId is required');
    error.code = 'HARNESS_UNSUPPORTED';
    error.statusCode = 400;
    throw error;
  };

  /**
   * @param {object} body
   */
  const abort = async (body) => {
    // Abort is session-scoped; Claude translator owns active-turn state.
    // OpenCode abort remains on the SDK path.
    return claude.abort(body);
  };

  /**
   * Resolve a bridged Claude permission prompt.
   * @param {object} body
   */
  const replyPermission = async (body) => {
    if (typeof claude.replyPermission !== 'function') {
      const error = new Error('Permission reply is unavailable');
      error.code = 'PERMISSION_UNAVAILABLE';
      error.statusCode = 503;
      throw error;
    }
    return claude.replyPermission(body);
  };

  return { prompt, abort, replyPermission, claude, opencode };
}
