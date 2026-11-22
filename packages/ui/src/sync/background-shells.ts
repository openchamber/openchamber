import { useCallback } from 'react';
import { create } from 'zustand';
import { readBackgroundShellIDFromMetadata, readShellCancellation, type RunningShell, type ShellEnd, type ShellEndRecord } from '@/lib/opencode/background-shell';
import type { SyncEvent } from '@/lib/opencode/events';
import { normalizeProjectPath } from '@/lib/projectResolution';


export type TrackedShell = RunningShell & {
  directory: string;
  background: boolean;
};

export type EndedShellStatus = 'exited' | 'timeout' | 'killed' | 'stopped' | 'unknown';

export type EndedShell = TrackedShell & {
  status: EndedShellStatus;
  exit?: number;
  endedAt: number;
};

type BackgroundShellsState = {
  byId: ReadonlyMap<string, TrackedShell>;
  sessionIds: ReadonlySet<string>;
  ended: ReadonlyMap<string, EndedShell>;
  /** Ended commands the user dismissed from the strip. */
  dismissed: ReadonlySet<string>;
  /** Sessions with an ended background command the strip still shows. */
  endedSessionIds: ReadonlySet<string>;
};

const EMPTY_SESSION_IDS: ReadonlySet<string> = new Set();
const EMPTY_DISMISSED: ReadonlySet<string> = new Set();
export const ENDED_SHELLS_MAX = 200;

export const useBackgroundShellsStore = create<BackgroundShellsState>(() => ({
  byId: new Map(),
  sessionIds: EMPTY_SESSION_IDS,
  ended: new Map(),
  dismissed: EMPTY_DISMISSED,
  endedSessionIds: EMPTY_SESSION_IDS,
}));

const normalizeDirectory = (directory: string): string => normalizeProjectPath(directory) ?? directory;

let revision = 0;
const touchedAt = new Map<string, number>();
const MAX_TOUCHED = 500;
let generation = 0;

const touch = (shellID: string): void => {
  revision += 1;
  touchedAt.delete(shellID);
  touchedAt.set(shellID, revision);
  if (touchedAt.size > MAX_TOUCHED) {
    const oldest = touchedAt.keys().next().value;
    if (oldest !== undefined) touchedAt.delete(oldest);
  }
};

const touchedSince = (shellID: string, since: number): boolean => (touchedAt.get(shellID) ?? 0) > since;

const settledInBackground = new Set<string>();

const rememberSettledInBackground = (shellID: string): void => {
  settledInBackground.add(shellID);
  if (settledInBackground.size > MAX_TOUCHED) {
    const oldest = settledInBackground.values().next().value;
    if (oldest !== undefined) settledInBackground.delete(oldest);
  }
};

const backgroundedShellID = (payload: SyncEvent): string | undefined => {
  if (payload.type !== 'message.tool.transition') return undefined;
  const { transition } = payload.properties;
  if (transition.kind !== 'success' || transition.metadata?.shellID === undefined) return undefined;
  return readBackgroundShellIDFromMetadata(transition.metadata);
};

const sameIds = (next: ReadonlySet<string>, previous: ReadonlySet<string>): boolean => (
  next.size === previous.size && [...next].every((id) => previous.has(id))
);

const sessionIdsOf = (byId: ReadonlyMap<string, TrackedShell>, previous: ReadonlySet<string>): ReadonlySet<string> => {
  const next = new Set<string>();
  for (const shell of byId.values()) next.add(shell.sessionID);
  return sameIds(next, previous) ? previous : next;
};

const endedSessionIdsOf = (
  ended: ReadonlyMap<string, EndedShell>,
  dismissed: ReadonlySet<string>,
  previous: ReadonlySet<string>,
): ReadonlySet<string> => {
  const next = new Set<string>();
  for (const shell of ended.values()) {
    if (shell.background && !dismissed.has(shell.id)) next.add(shell.sessionID);
  }
  return sameIds(next, previous) ? previous : next;
};

const publish = (byId: ReadonlyMap<string, TrackedShell>, ended: ReadonlyMap<string, EndedShell> | null): void => {
  const state = useBackgroundShellsStore.getState();
  if (ended === null) {
    useBackgroundShellsStore.setState({ byId, sessionIds: sessionIdsOf(byId, state.sessionIds) });
    return;
  }
  // Dismissals of commands the ended list dropped are forgotten with them.
  const dismissed = [...state.dismissed].every((id) => ended.has(id))
    ? state.dismissed
    : new Set([...state.dismissed].filter((id) => ended.has(id)));
  useBackgroundShellsStore.setState({
    byId,
    sessionIds: sessionIdsOf(byId, state.sessionIds),
    ended,
    dismissed,
    endedSessionIds: endedSessionIdsOf(ended, dismissed, state.endedSessionIds),
  });
};

/** Removes ended commands from the strip. `ended` keeps them for extensions. */
export const dismissEndedShells = (shellIDs: readonly string[]): void => {
  const state = useBackgroundShellsStore.getState();
  const added = shellIDs.filter((id) => state.ended.has(id) && !state.dismissed.has(id));
  if (added.length === 0) return;
  const dismissed = new Set([...state.dismissed, ...added]);
  useBackgroundShellsStore.setState({
    dismissed,
    endedSessionIds: endedSessionIdsOf(state.ended, dismissed, state.endedSessionIds),
  });
};

const stopNoted = new Set<string>();

const rememberStopNoted = (shellID: string): void => {
  stopNoted.add(shellID);
  if (stopNoted.size > MAX_TOUCHED) {
    const oldest = stopNoted.values().next().value;
    if (oldest !== undefined) stopNoted.delete(oldest);
  }
};

const endedFrom = (shell: TrackedShell, end: ShellEnd | null, endedAt: number): EndedShell => {
  if (end === null) return { ...shell, status: 'unknown', endedAt };
  if (end.kind === 'removed' || (end.exit === undefined && stopNoted.has(shell.id))) return { ...shell, status: 'stopped', endedAt };
  return end.exit === undefined
    ? { ...shell, status: end.status, endedAt }
    : { ...shell, status: end.status, exit: end.exit, endedAt };
};

const withEnded = (ended: ReadonlyMap<string, EndedShell>, added: readonly EndedShell[]): ReadonlyMap<string, EndedShell> => {
  const next = new Map(ended);
  for (const shell of added) {
    next.delete(shell.id);
    next.set(shell.id, shell);
  }
  for (const id of next.keys()) {
    if (next.size <= ENDED_SHELLS_MAX) break;
    next.delete(id);
  }
  return next;
};

const sameShell = (left: TrackedShell | undefined, right: TrackedShell): boolean => (
  left !== undefined
  && left.directory === right.directory
  && left.sessionID === right.sessionID
  && left.command === right.command
  && left.file === right.file
  && left.startedAt === right.startedAt
  && left.background === right.background
);

type SettleOutcome = 'background' | 'ended';
type SettleWaiter = { resolve: (outcome: SettleOutcome) => void; reject: (error: Error) => void };
type ShellSettleWait = { settled: Promise<SettleOutcome>; cancel: () => void };
const settleWaiters = new Map<string, SettleWaiter>();


export const waitForShellSettle = (shellID: string, timeoutMs: number): ShellSettleWait => {
  settleWaiters.get(shellID)?.reject(new Error('Replaced by a newer wait for the same command.'));
  let cancel = (): void => {};
  const settled = new Promise<SettleOutcome>((resolve, reject) => {
    const finish = (settle: () => void) => {
      clearTimeout(timer);
      if (settleWaiters.get(shellID) === waiter) settleWaiters.delete(shellID);
      settle();
    };
    const waiter: SettleWaiter = {
      resolve: (outcome) => finish(() => resolve(outcome)),
      reject: (error) => finish(() => reject(error)),
    };
    const timer = setTimeout(() => waiter.reject(new Error('The command did not move to the background in time.')), timeoutMs);
    settleWaiters.set(shellID, waiter);
    cancel = () => waiter.reject(new Error('Cancelled.'));
  });
  return { settled, cancel };
};

export const applyBackgroundShellEvents = (rawDirectory: string, payloads: readonly SyncEvent[]): void => {
  let draft: Map<string, TrackedShell> | null = null;
  const ended: EndedShell[] = [];
  const settled: Array<[string, SettleOutcome]> = [];
  const current = (): ReadonlyMap<string, TrackedShell> => draft ?? useBackgroundShellsStore.getState().byId;
  for (const payload of payloads) {
    if (payload.type === 'shell.started') {
      const { id } = payload.properties.shell;
      const background = current().get(id)?.background ?? settledInBackground.has(id);
      const shell: TrackedShell = { ...payload.properties.shell, directory: normalizeDirectory(rawDirectory), background };
      touch(shell.id);
      if (sameShell(current().get(shell.id), shell)) continue;
      draft ??= new Map(current());
      draft.set(shell.id, shell);
      continue;
    }
    if (payload.type === 'shell.ended') {
      const { shellID, end, endedAt } = payload.properties;
      touch(shellID);
      settledInBackground.delete(shellID);
      if (settleWaiters.has(shellID)) settled.push([shellID, 'ended']);
      const tracked = current().get(shellID);
      if (!tracked) continue;
      draft ??= new Map(current());
      draft.delete(shellID);
      ended.push(endedFrom(tracked, end, endedAt));
      stopNoted.delete(shellID);
      continue;
    }
    if (payload.type === 'message.updated') {
      const stopped = readShellCancellation(payload.properties.info);
      if (stopped) stopped.shellIDs.forEach(rememberStopNoted);
      continue;
    }
    const backgroundedID = backgroundedShellID(payload);
    if (backgroundedID === undefined) continue;
    if (settleWaiters.has(backgroundedID)) settled.push([backgroundedID, 'background']);
    const tracked = current().get(backgroundedID);
    if (!tracked) {
      rememberSettledInBackground(backgroundedID);
      continue;
    }
    if (tracked.background) continue;
    draft ??= new Map(current());
    draft.set(backgroundedID, { ...tracked, background: true });
  }
  if (draft) publish(draft, ended.length > 0 ? withEnded(useBackgroundShellsStore.getState().ended, ended) : null);
  for (const [shellID, outcome] of settled) settleWaiters.get(shellID)?.resolve(outcome);
};

/**
 * Replaces one directory's commands with a complete list read from it.
 * `since` is the revision the read started at (`backgroundShellRevision()`).
 * Returns the commands the list no longer has, ended as `unknown`.
 */
export const replaceDirectoryShells = (rawDirectory: string, shells: readonly RunningShell[], since: number): EndedShell[] => {
  const directory = normalizeDirectory(rawDirectory);
  const state = useBackgroundShellsStore.getState();
  let draft: Map<string, TrackedShell> | null = null;
  const ended: EndedShell[] = [];
  const listed = new Set(shells.map((shell) => shell.id));
  for (const [id, shell] of state.byId) {
    if (shell.directory !== directory || listed.has(id) || touchedSince(id, since)) continue;
    draft ??= new Map(state.byId);
    draft.delete(id);
    ended.push(endedFrom(shell, null, Date.now()));
  }
  for (const listedShell of shells) {
    if (touchedSince(listedShell.id, since)) continue;
    const shell: TrackedShell = { ...listedShell, directory, background: state.byId.get(listedShell.id)?.background ?? true };
    if (sameShell(state.byId.get(shell.id), shell)) continue;
    draft ??= new Map(state.byId);
    draft.set(shell.id, shell);
  }
  if (draft) publish(draft, ended.length > 0 ? withEnded(state.ended, ended) : null);
  return ended;
  for (const shell of ended) settleWaiters.get(shell.id)?.resolve('ended');
};

export const backgroundShellRevision = (): number => revision;

const resolveUnknownEnd = (shellID: string, record: ShellEndRecord): void => {
  const state = useBackgroundShellsStore.getState();
  const recorded = state.ended.get(shellID);
  if (recorded?.status !== 'unknown') return;
  publish(state.byId, withEnded(state.ended, [endedFrom(recorded, record.end, record.endedAt ?? recorded.endedAt)]));
};
export const refreshBackgroundShells = async (
  directory: string,
  listRunningShells: (directory: string) => Promise<{ directory: string; shells: RunningShell[] }>,
  readShellEnd: (shellID: string, directory: string) => Promise<ShellEndRecord | undefined>,
): Promise<void> => {
  const startedGeneration = generation;
  const since = revision;
  const listed = await listRunningShells(directory);
  if (startedGeneration !== generation) return;
  const unknown = replaceDirectoryShells(listed.directory, listed.shells, since);
  await Promise.all(unknown.map(async (shell) => {
    const record = await readShellEnd(shell.id, shell.directory).catch(() => undefined);
    if (record === undefined || startedGeneration !== generation) return;
    resolveUnknownEnd(shell.id, record);
  }));
};

export const directoriesWithRunningShells = (): string[] => {
  const directories = new Set<string>();
  for (const shell of useBackgroundShellsStore.getState().byId.values()) directories.add(shell.directory);
  return [...directories];
};

export const hasRunningShell = (sessionId: string): boolean => (
  useBackgroundShellsStore.getState().sessionIds.has(sessionId)
);

export const resetBackgroundShells = (): void => {
  generation += 1;
  revision = 0;
  touchedAt.clear();
  settledInBackground.clear();
  stopNoted.clear();
  for (const waiter of [...settleWaiters.values()]) waiter.reject(new Error('The runtime changed.'));
  useBackgroundShellsStore.setState({
    byId: new Map(),
    sessionIds: EMPTY_SESSION_IDS,
    ended: new Map(),
    dismissed: EMPTY_DISMISSED,
    endedSessionIds: EMPTY_SESSION_IDS,
  });
};

export const sessionsInTree = (
  sessionIds: Iterable<string>,
  rootId: string,
  parentOf: (sessionId: string) => string | undefined,
): string[] => {
  const inTree: string[] = [];
  for (const sessionId of sessionIds) {
    const seen = new Set<string>();
    let current: string | undefined = sessionId;
    while (current !== undefined && !seen.has(current)) {
      if (current === rootId) {
        inTree.push(sessionId);
        break;
      }
      seen.add(current);
      current = parentOf(current);
    }
  }
  return inTree.sort();
};

const byStart = (left: TrackedShell, right: TrackedShell): number => left.startedAt - right.startedAt || left.id.localeCompare(right.id);

export const backgroundShellsOfSessions = (
  byId: ReadonlyMap<string, TrackedShell>,
  sessionIds: ReadonlySet<string>,
): TrackedShell[] => {
  const shells: TrackedShell[] = [];
  for (const shell of byId.values()) {
    if (shell.background && sessionIds.has(shell.sessionID)) shells.push(shell);
  }
  return shells.sort(byStart);
};

/**
 * Ended background commands of the given sessions that the user has not
 * dismissed, oldest start first, so a command keeps its place in the strip
 * when it ends.
 */
export const endedBackgroundShellsOfSessions = (
  ended: ReadonlyMap<string, EndedShell>,
  dismissed: ReadonlySet<string>,
  sessionIds: ReadonlySet<string>,
): EndedShell[] => {
  const shells: EndedShell[] = [];
  for (const shell of ended.values()) {
    if (shell.background && sessionIds.has(shell.sessionID) && !dismissed.has(shell.id)) shells.push(shell);
  }
  return shells.sort(byStart);
};

export const useRunningShell = (shellID: string | undefined): TrackedShell | undefined => (
  useBackgroundShellsStore(useCallback((state) => (shellID ? state.byId.get(shellID) : undefined), [shellID]))
);
