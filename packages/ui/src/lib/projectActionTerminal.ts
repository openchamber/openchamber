import { normalizeTerminalDirectory as normalizeDirectory } from './pathNormalization';
import { getRuntimeKey } from './runtime-switch';
import type { CreateTerminalOptions, TerminalAPI, TerminalServerSession, TerminalSession, TerminalSessionPurpose } from './api/types';

type TerminalActionMutationRevisions = ReadonlyMap<string, number>;

type ProjectActionTerminalCreateOptions = Omit<Extract<CreateTerminalOptions, { mode: 'command' }>, 'mode' | 'command' | 'sessionId'>;

type CreateProjectActionTerminalSessionOptions = {
  terminal: TerminalAPI;
  createOptions: ProjectActionTerminalCreateOptions;
  command: string;
  isRunStillExpected: () => boolean;
  purpose: Extract<TerminalSessionPurpose, { type: 'project-action' }>;
};

type StopProjectActionTerminalSessionOptions = {
  terminal: TerminalAPI;
  sessionId: string;
  isExecutionStillCurrent: () => boolean;
  markStopping: () => void;
  restoreRunning: () => void;
  clearSession: () => void;
  finalizeExit: () => void;
  timeoutMs?: number;
};

const COMMAND_MODE_UNSUPPORTED_ERROR = 'COMMAND_MODE_UNSUPPORTED';
const PROJECT_ACTION_RUN_CANCELLED_ERROR = 'PROJECT_ACTION_RUN_CANCELLED';
const PROJECT_ACTION_PURPOSE_UNSUPPORTED_ERROR = 'PROJECT_ACTION_PURPOSE_UNSUPPORTED';

const createProjectActionTerminalError = (message: string): Error => new Error(message);

const closeTerminalSession = async (terminal: TerminalAPI, sessionId: string): Promise<void> => {
  try {
    await terminal.close(sessionId);
  } catch {
    // noop
  }
};

const rejectCreatedSession = async (terminal: TerminalAPI, session: TerminalSession, requestedExecutionId: string, errorMessage: string): Promise<never> => {
  // A deduplicated response belongs to the peer that created it.
  if (session.sessionId === requestedExecutionId) await closeTerminalSession(terminal, session.sessionId);
  throw createProjectActionTerminalError(errorMessage);
};

export const normalizeProjectActionCommand = (command: string): string => {
  const normalizedNewlines = command.trim().replace(/\r\n|\r/g, '\n');
  let next = '';
  for (let index = 0; index < normalizedNewlines.length; index += 1) {
    const code = normalizedNewlines.charCodeAt(index);
    const isControl = (code >= 0 && code <= 8)
      || code === 11
      || code === 12
      || (code >= 14 && code <= 31)
      || code === 127;
    if (!isControl) {
      next += normalizedNewlines[index];
    }
  }
  return next;
};

const isCommandTerminalSession = (session: TerminalSession): boolean => session.mode === 'command';
const isProjectActionTerminalPurpose = (
  purpose: TerminalSessionPurpose | undefined,
): purpose is Extract<TerminalSessionPurpose, { type: 'project-action' }> => purpose?.type === 'project-action';

const isMatchingProjectActionPurpose = (
  purpose: TerminalSessionPurpose | undefined,
  actionId: string,
): purpose is Extract<TerminalSessionPurpose, { type: 'project-action' }> => (
  isProjectActionTerminalPurpose(purpose)
  && purpose.actionId === actionId
  && purpose.executionId.trim().length > 0
);

type ReconcileTerminalSessionAuthorityOptions = {
  captureStartedActionMutationRevisions?: (directory: string) => TerminalActionMutationRevisions;
};

type ReconcileTerminalSessionAuthorityResult = {
  sessions: TerminalServerSession[];
  startedActionMutationRevisions: TerminalActionMutationRevisions;
};

export const createProjectActionTerminalSession = async ({
  terminal,
  createOptions,
  command,
  isRunStillExpected,
  purpose,
}: CreateProjectActionTerminalSessionOptions): Promise<TerminalSession> => {
  const created = await terminal.createSession({
    ...createOptions,
    sessionId: purpose.executionId,
    mode: 'command',
    command: normalizeProjectActionCommand(command),
    purpose,
  });

  if (!isCommandTerminalSession(created)) {
    await rejectCreatedSession(terminal, created, purpose.executionId, COMMAND_MODE_UNSUPPORTED_ERROR);
  }

  if (!isMatchingProjectActionPurpose(created.purpose, purpose.actionId)) {
    await rejectCreatedSession(terminal, created, purpose.executionId, PROJECT_ACTION_PURPOSE_UNSUPPORTED_ERROR);
  }

  if (!isRunStillExpected()) {
    await rejectCreatedSession(terminal, created, purpose.executionId, PROJECT_ACTION_RUN_CANCELLED_ERROR);
  }

  return created;
};

export const waitForTerminalExit = (
  terminal: TerminalAPI,
  sessionId: string,
  timeoutMs: number,
): Promise<boolean> => new Promise((resolve) => {
  let settled = false;
  let subscription: { close: () => void } | null = null;
  let timeout: ReturnType<typeof setTimeout> | null = null;
  const finish = (exited: boolean) => {
    if (settled) return;
    settled = true;
    if (timeout) clearTimeout(timeout);
    subscription?.close();
    resolve(exited);
  };
  subscription = terminal.connect(sessionId, {
    onEvent: (event) => {
      if (event.type === 'exit' || (event.type === 'snapshot' && event.status === 'exited')) finish(true);
    },
    onError: (_error, fatal) => { if (fatal) finish(true); },
  });
  if (settled) subscription.close();
  else timeout = setTimeout(() => finish(false), timeoutMs);
});

export const stopProjectActionTerminalSession = async ({
  terminal,
  sessionId,
  isExecutionStillCurrent,
  markStopping,
  restoreRunning,
  clearSession,
  finalizeExit,
  timeoutMs = 1000,
}: StopProjectActionTerminalSessionOptions): Promise<void> => {
  markStopping();

  const exitPromise = waitForTerminalExit(terminal, sessionId, timeoutMs);

  try {
    if (isExecutionStillCurrent()) {
      await terminal.sendInput(sessionId, '\x03');
    }
  } catch {
    // noop
  }

  const exitObserved = await exitPromise;
  if (!isExecutionStillCurrent()) {
    return;
  }

  if (!exitObserved) {
    let terminationFailed = false;
    if (terminal.forceKill) {
      try {
        if (isExecutionStillCurrent()) {
          await terminal.forceKill({ sessionId });
        }
      } catch {
        terminationFailed = true;
      }
    } else {
      try {
        if (isExecutionStillCurrent()) {
          await terminal.close(sessionId);
        }
      } catch {
        terminationFailed = true;
      }
    }

    if (!isExecutionStillCurrent()) {
      return;
    }
    if (terminationFailed) {
      restoreRunning();
      return;
    }
    clearSession();
  }

  if (!isExecutionStillCurrent()) {
    return;
  }
  finalizeExit();
};

const reconcileFlightsByTerminal = new WeakMap<
  TerminalAPI,
  Map<string, Promise<ReconcileTerminalSessionAuthorityResult | null>>
>();

export const reconcileTerminalSessionAuthority = (
  terminal: TerminalAPI,
  directory: string,
  options: ReconcileTerminalSessionAuthorityOptions = {},
): Promise<ReconcileTerminalSessionAuthorityResult | null> => {
  if (!terminal.listSessions) {
    return Promise.resolve(null);
  }

  const normalizedDirectory = normalizeDirectory(directory);
  const runtimeKey = getRuntimeKey();
  const flightKey = `${runtimeKey}\u0000${normalizedDirectory}`;
  let terminalFlights = reconcileFlightsByTerminal.get(terminal);
  if (!terminalFlights) {
    terminalFlights = new Map();
    reconcileFlightsByTerminal.set(terminal, terminalFlights);
  }
  const existing = terminalFlights.get(flightKey);
  if (existing) {
    return existing;
  }

  const startedActionMutationRevisions = options.captureStartedActionMutationRevisions?.(normalizedDirectory)
    ?? new Map<string, number>();
  const flight = terminal.listSessions(normalizedDirectory)
    .then((sessions) => runtimeKey === getRuntimeKey() ? { sessions, startedActionMutationRevisions } : null)
    .catch(() => null)
    .finally(() => {
      if (terminalFlights.get(flightKey) === flight) {
        terminalFlights.delete(flightKey);
        if (terminalFlights.size === 0) {
          reconcileFlightsByTerminal.delete(terminal);
        }
      }
    });
  terminalFlights.set(flightKey, flight);
  return flight;
};


/** Groups a whole-server listing into the directory keys the terminal store uses. */
export const groupTerminalSessionsByDirectory = (sessions: TerminalServerSession[]): Map<string, TerminalServerSession[]> => {
  const groups = new Map<string, TerminalServerSession[]>();
  for (const session of sessions) {
    const directory = normalizeDirectory(session.cwd);
    const group = groups.get(directory);
    if (group) group.push(session);
    else groups.set(directory, [session]);
  }
  return groups;
};
