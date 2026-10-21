import { create } from 'zustand';
import type { PersistentPtyInfo } from '@opencode/client';
import type { SyncEvent } from '@/lib/opencode/events';

// Terminals an agent started with the pty tool, by id. `persistent-pty.added`
// and `persistent-pty.removed` keep the index current. OpenCode announces no
// exit: a terminal reads `exited`, with the exit code when the process left
// one, only in a list or a record read. So a session's list is read when its
// composer shows and again while one of its terminals runs, and replaces only
// that session's terminals.
//
// A terminal the user stops here is removed by OpenCode. Its entry stays,
// marked `stoppedByUser`, so its row keeps saying how it ended until the user
// dismisses it.

export type TrackedPty = PersistentPtyInfo & {
  directory: string;
  /** The user stopped it here; OpenCode no longer has it. */
  stoppedByUser?: true;
};

/** How a terminal's row reads. */
export type AgentTerminalState =
  | { kind: 'running' }
  | { kind: 'exited'; exitCode?: number }
  | { kind: 'stopped' };

export const agentTerminalState = (pty: TrackedPty): AgentTerminalState => {
  if (pty.stoppedByUser) return { kind: 'stopped' };
  if (pty.status === 'running') return { kind: 'running' };
  return pty.exitCode === undefined ? { kind: 'exited' } : { kind: 'exited', exitCode: pty.exitCode };
};

type PersistentPtysState = {
  byId: ReadonlyMap<string, TrackedPty>;
};

export const usePersistentPtysStore = create<PersistentPtysState>(() => ({
  byId: new Map(),
}));

// A list read races the events and stops that land while it is in flight: a
// terminal one of them touched after the read began keeps what it said.
let revision = 0;
const touchedAt = new Map<string, number>();
const MAX_TOUCHED = 500;
// A runtime switch resets the index; a read started before it must not commit.
let generation = 0;
// Terminals whose Stop is in flight: their removal is that stop, and list
// reads leave them to it.
const stopRequested = new Set<string>();

const touch = (ptyID: string): void => {
  revision += 1;
  touchedAt.delete(ptyID);
  touchedAt.set(ptyID, revision);
  if (touchedAt.size > MAX_TOUCHED) {
    const oldest = touchedAt.keys().next().value;
    if (oldest !== undefined) touchedAt.delete(oldest);
  }
};

const touchedSince = (ptyID: string, since: number): boolean => (touchedAt.get(ptyID) ?? 0) > since;

const asStopped = (pty: TrackedPty): TrackedPty => ({ ...pty, status: 'exited', stoppedByUser: true });

const sameTerminal = (left: TrackedPty, right: TrackedPty): boolean => (
  left.status === right.status
  && left.exitCode === right.exitCode
  && left.stoppedByUser === right.stoppedByUser
  && left.title === right.title
  && left.command === right.command
  && left.args.join('\0') === right.args.join('\0')
  && left.cwd === right.cwd
  && left.sessionID === right.sessionID
  && left.directory === right.directory
  && left.size.cols === right.size.cols
  && left.size.rows === right.size.rows
);

export const applyPersistentPtyEvents = (directory: string, events: readonly SyncEvent[]): void => {
  if (!events.some((event) => event.type === 'persistent-pty.added' || event.type === 'persistent-pty.removed')) return;
  const next = new Map(usePersistentPtysStore.getState().byId);
  for (const event of events) {
    if (event.type === 'persistent-pty.added') {
      touch(event.properties.terminal.id);
      next.set(event.properties.terminal.id, { ...event.properties.terminal, directory });
    } else if (event.type === 'persistent-pty.removed') {
      const { ptyID } = event.properties;
      touch(ptyID);
      const current = next.get(ptyID);
      if (current?.stoppedByUser) continue;
      // Removed while the user's Stop is in flight: that removal is the stop.
      if (current && current.status === 'running' && stopRequested.has(ptyID)) next.set(ptyID, asStopped(current));
      else next.delete(ptyID);
    }
  }
  usePersistentPtysStore.setState({ byId: next });
};

/**
 * Replaces one session's terminals with a complete list read from OpenCode.
 * `since` is the revision the read started at (`persistentPtyRevision()`).
 * Terminals the user stopped, and any an event or a stop touched since the
 * read started, keep what they say.
 */
export const replaceSessionTerminals = (
  sessionID: string,
  directory: string,
  terminals: readonly PersistentPtyInfo[],
  since: number,
): void => {
  const state = usePersistentPtysStore.getState();
  const listed = new Map(terminals.map((terminal) => [terminal.id, terminal]));
  const next = new Map<string, TrackedPty>();
  for (const [id, pty] of state.byId) {
    if (pty.sessionID !== sessionID || pty.stoppedByUser || stopRequested.has(id) || touchedSince(id, since)) {
      next.set(id, pty);
      continue;
    }
    const terminal = listed.get(id);
    if (!terminal) continue;
    const fresh: TrackedPty = { ...terminal, directory };
    next.set(id, sameTerminal(pty, fresh) ? pty : fresh);
  }
  for (const terminal of terminals) {
    if (next.has(terminal.id) || touchedSince(terminal.id, since)) continue;
    next.set(terminal.id, { ...terminal, directory });
  }
  const unchanged = next.size === state.byId.size && [...next].every(([id, pty]) => state.byId.get(id) === pty);
  if (!unchanged) usePersistentPtysStore.setState({ byId: next });
};

export const persistentPtyRevision = (): number => revision;

/** Reads a session's terminals and applies them. A failed read rejects and changes nothing. */
export const refreshSessionTerminals = async (
  sessionID: string,
  directory: string,
  listSessionTerminals: (sessionID: string, directory: string) => Promise<PersistentPtyInfo[]>,
): Promise<void> => {
  const startedGeneration = generation;
  const since = revision;
  const terminals = await listSessionTerminals(sessionID, directory);
  if (startedGeneration !== generation) return;
  replaceSessionTerminals(sessionID, directory, terminals, since);
};

const updateTerminal = (ptyID: string, update: (pty: TrackedPty) => TrackedPty | null): void => {
  touch(ptyID);
  const state = usePersistentPtysStore.getState();
  const current = state.byId.get(ptyID);
  if (!current) return;
  const updated = update(current);
  if (updated === current) return;
  const next = new Map(state.byId);
  if (updated) next.set(ptyID, updated);
  else next.delete(ptyID);
  usePersistentPtysStore.setState({ byId: next });
};

/**
 * Stops a running terminal at the user's request. Its record is read first,
 * since OpenCode announces no exit: a terminal that ended on its own keeps the
 * exit it reports, and one OpenCode no longer has is left to its removal
 * event. Rejects when the read or the removal fails; the row then reads as it
 * did before.
 */
export const stopAgentTerminal = async (
  ptyID: string,
  readTerminal: (ptyID: string, directory: string) => Promise<PersistentPtyInfo | undefined>,
  removeTerminal: (ptyID: string, directory: string) => Promise<void>,
): Promise<void> => {
  const pty = usePersistentPtysStore.getState().byId.get(ptyID);
  if (!pty || agentTerminalState(pty).kind !== 'running') return;
  const startedGeneration = generation;
  // A list read that started before the click must not undo what follows.
  touch(ptyID);
  const record = await readTerminal(ptyID, pty.directory);
  if (record === undefined || startedGeneration !== generation) return;
  if (record.status !== 'running') {
    updateTerminal(ptyID, (current) => ({ ...record, directory: current.directory }));
    return;
  }
  stopRequested.add(ptyID);
  try {
    await removeTerminal(ptyID, pty.directory);
    if (startedGeneration !== generation) return;
    // The removal event may have arrived first, or not at all.
    updateTerminal(ptyID, (current) => (current.stoppedByUser ? current : asStopped(current)));
  } finally {
    stopRequested.delete(ptyID);
  }
};

/**
 * Clears an ended terminal's row. A terminal the user stopped is already gone
 * from OpenCode; an exited one is removed there too, which also takes it off
 * the agent's own list. Rejects when that removal fails, and the row stays.
 */
export const dismissAgentTerminal = async (
  ptyID: string,
  removeTerminal: (ptyID: string, directory: string) => Promise<void>,
): Promise<void> => {
  const pty = usePersistentPtysStore.getState().byId.get(ptyID);
  if (!pty || agentTerminalState(pty).kind === 'running') return;
  if (!pty.stoppedByUser) await removeTerminal(ptyID, pty.directory);
  updateTerminal(ptyID, () => null);
};

export const resetPersistentPtys = (): void => {
  generation += 1;
  revision = 0;
  touchedAt.clear();
  stopRequested.clear();
  usePersistentPtysStore.setState({ byId: new Map() });
};
