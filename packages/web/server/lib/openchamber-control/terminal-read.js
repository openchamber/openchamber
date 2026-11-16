
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
