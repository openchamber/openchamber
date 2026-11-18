
import { asNonEmptyString } from '../shared/guards.js';
import { OpenChamberControlError } from './error.js';
import type { createTerminalRuntime } from '../terminal/runtime.js';
import type { ControlInput } from './contracts.js';

export interface TerminalReadDependencies {
  readSettings: () => Promise<{ agentTerminalToolEnabled?: unknown } | null>;
  getTerminalRuntime?: (() => Pick<ReturnType<typeof createTerminalRuntime>, 'listTerminals' | 'readTerminal'> | null) | null;
}

const isFiniteBytes = (value: unknown): value is number => Number.isFinite(value);

export const createTerminalReadAction = ({ readSettings, getTerminalRuntime }: TerminalReadDependencies) => async (action: string, input: ControlInput = {}, contextDirectory?: ControlInput['directory']) => {
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
  const terminal = runtime.readTerminal(sessionId, isFiniteBytes(maxBytes) ? { maxBytes } : {});
  if (!terminal) {
    throw new OpenChamberControlError(`No terminal with sessionId ${sessionId}; terminal.list names this folder's terminals`, 404);
  }
  return terminal;
};
