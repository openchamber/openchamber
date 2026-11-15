/**
 * `terminal.list` and `terminal.read`: the terminal panel an agent can look at,
 * read-only.
 *
 * The runtime keeps the sanitized replay text the panel's `attach` snapshot
 * sends (`../terminal/runtime.js`) and returns it as plain text, so a read is a
 * copy of in-memory state: it never types into a PTY, starts or stops one,
 * moves `lastActivity` or writes to an attached client. Only the managed
 * agent-tool callback reaches it; the ordinary control route refuses
 * `terminal.*` (`routes.js`).
 *
 * The tool is off until the user turns it on: a terminal holds whatever was
 * typed into it, secrets included, so the gate is read again on every call,
 * not only while the plugin is materialized.
 */

import { asNonEmptyString } from '../shared/guards.js';
import { OpenChamberControlError } from './error.js';

/**
 * @param {object} options
 * @param {() => Promise<object | null>} options.readSettings
 * @param {() => { listTerminals: Function, readTerminal: Function } | null} options.getTerminalRuntime
 */
export const createTerminalReadAction = ({ readSettings, getTerminalRuntime }) => async (action, input = {}, contextDirectory) => {
  const settings = await readSettings().catch(() => null);
  if (settings?.agentTerminalToolEnabled !== true) {
    throw new OpenChamberControlError('The terminal tool is turned off in OpenChamber settings', 403);
  }

  const runtime = getTerminalRuntime?.();
  if (!runtime) {
    throw new OpenChamberControlError('The terminal panel is not available on this server', 503);
  }

  if (action === 'terminal.list') {
    // The session's folder, or one the caller names. Never every terminal of the
    // instance: a session whose folder cannot be resolved must pass `directory`
    // rather than silently receive the whole instance's list.
    const directory = asNonEmptyString(input.directory) || asNonEmptyString(contextDirectory);
    if (!directory) {
      throw new OpenChamberControlError('terminal.list needs a folder: pass directory, because this call carries no session folder', 400);
    }
    return { terminals: runtime.listTerminals({ directory }) };
  }

  const sessionId = asNonEmptyString(input.sessionId);
  if (!sessionId) {
    throw new OpenChamberControlError('sessionId is required; terminal.list names them', 400);
  }
  const maxBytes = input.maxBytes;
  const terminal = runtime.readTerminal(sessionId, Number.isFinite(maxBytes) ? { maxBytes } : {});
  if (!terminal) {
    throw new OpenChamberControlError(`No terminal with sessionId ${sessionId}; terminal.list names this folder's terminals`, 404);
  }
  return terminal;
};
