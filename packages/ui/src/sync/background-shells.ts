import { useCallback } from 'react';
import { create } from 'zustand';
import { readBackgroundShellIDFromMetadata, type RunningShell } from '@/lib/opencode/background-shell';
import type { SyncEvent } from '@/lib/opencode/events';
import { normalizeProjectPath } from '@/lib/projectResolution';

// Cross-directory index of the shell commands OpenCode is running on behalf of
// a session. A background command outlives the turn that started it: the
// session goes idle and runs again when the command's result is handed back,
// so this index is what keeps that pause visible as work (see
// `useSessionTurnActive`) and what a background command's tool row reads to
// know whether the command still runs.
//
// `shell.started` / `shell.ended` events keep it current for every directory.
// A directory's `/api/shell` list is authoritative for that directory and is
// read when the directory bootstraps and after the stream reconnects, which
// clears commands whose exit fell into a stream gap. Nothing here streams, so
// consumers subscribe per session or per command without cost.
//
// OpenCode runs every shell call as such a command, including one the turn is
// still waiting for. `background` tells them apart: a call that went to the
// background settles at once with the command's id in its metadata (see
// `readBackgroundShellIDFromMetadata`), while a call the turn waits for
// settles only after its command ended. A command first seen in a list (after
// a reload or reconnect) has no event to tell, and counts as background: a
// command the turn waits for is short-lived next to one left running.

export type TrackedShell = RunningShell & {
  directory: string;
  /** Went to the background; false while the turn that started it waits for it. */
  background: boolean;
};

type BackgroundShellsState = {
  byId: ReadonlyMap<string, TrackedShell>;
  /** Sessions with at least one running command. */
  sessionIds: ReadonlySet<string>;
};

const EMPTY_SESSION_IDS: ReadonlySet<string> = new Set();

export const useBackgroundShellsStore = create<BackgroundShellsState>(() => ({
  byId: new Map(),
  sessionIds: EMPTY_SESSION_IDS,
}));

const normalizeDirectory = (directory: string): string => normalizeProjectPath(directory) ?? directory;

// A list read races the events that arrive while it is in flight: a command
// that started or ended after the read began must keep what its event said.
// Every event stamps its command with the revision it was applied at; a list
// only decides for commands no event touched since the read started.
let revision = 0;
const touchedAt = new Map<string, number>();
const MAX_TOUCHED = 500;
// A runtime switch resets the index; a read started before it must not commit.
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

// A call's background settlement normally follows its command's start; this
// remembers one that arrived first, until the start does.
const settledInBackground = new Set<string>();

const rememberSettledInBackground = (shellID: string): void => {
  settledInBackground.add(shellID);
  if (settledInBackground.size > MAX_TOUCHED) {
    const oldest = settledInBackground.values().next().value;
    if (oldest !== undefined) settledInBackground.delete(oldest);
  }
};

/** The command a tool call went to the background with, or undefined for any other event. */
const backgroundedShellID = (payload: SyncEvent): string | undefined => {
  if (payload.type !== 'message.tool.transition') return undefined;
  const { transition } = payload.properties;
  if (transition.kind !== 'success' || transition.metadata?.shellID === undefined) return undefined;
  return readBackgroundShellIDFromMetadata(transition.metadata);
};

const sessionIdsOf = (byId: ReadonlyMap<string, TrackedShell>, previous: ReadonlySet<string>): ReadonlySet<string> => {
  const next = new Set<string>();
  for (const shell of byId.values()) next.add(shell.sessionID);
  const same = next.size === previous.size && [...next].every((id) => previous.has(id));
  return same ? previous : next;
};

const publish = (byId: Map<string, TrackedShell>): void => {
  const state = useBackgroundShellsStore.getState();
  useBackgroundShellsStore.setState({ byId, sessionIds: sessionIdsOf(byId, state.sessionIds) });
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

/** Applies shell lifecycle events for one directory. Other event types are ignored cheaply. */
export const applyBackgroundShellEvents = (rawDirectory: string, payloads: readonly SyncEvent[]): void => {
  let draft: Map<string, TrackedShell> | null = null;
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
      const { shellID } = payload.properties;
      touch(shellID);
      settledInBackground.delete(shellID);
      if (!current().has(shellID)) continue;
      draft ??= new Map(current());
      draft.delete(shellID);
      continue;
    }
    const backgroundedID = backgroundedShellID(payload);
    if (backgroundedID === undefined) continue;
    const tracked = current().get(backgroundedID);
    if (!tracked) {
      rememberSettledInBackground(backgroundedID);
      continue;
    }
    if (tracked.background) continue;
    draft ??= new Map(current());
    draft.set(backgroundedID, { ...tracked, background: true });
  }
  if (draft) publish(draft);
};

/**
 * Replaces one directory's commands with a complete list read from it.
 * `since` is the revision the read started at (`backgroundShellRevision()`).
 */
export const replaceDirectoryShells = (rawDirectory: string, shells: readonly RunningShell[], since: number): void => {
  const directory = normalizeDirectory(rawDirectory);
  const state = useBackgroundShellsStore.getState();
  let draft: Map<string, TrackedShell> | null = null;
  const listed = new Set(shells.map((shell) => shell.id));
  for (const [id, shell] of state.byId) {
    if (shell.directory !== directory || listed.has(id) || touchedSince(id, since)) continue;
    draft ??= new Map(state.byId);
    draft.delete(id);
  }
  for (const listedShell of shells) {
    if (touchedSince(listedShell.id, since)) continue;
    const shell: TrackedShell = { ...listedShell, directory, background: state.byId.get(listedShell.id)?.background ?? true };
    if (sameShell(state.byId.get(shell.id), shell)) continue;
    draft ??= new Map(state.byId);
    draft.set(shell.id, shell);
  }
  if (draft) publish(draft);
};

export const backgroundShellRevision = (): number => revision;

/**
 * Reads a directory's running commands and applies them. A failed read
 * rejects and changes nothing: it proves nothing about the commands.
 */
export const refreshBackgroundShells = async (
  directory: string,
  listRunningShells: (directory: string) => Promise<{ directory: string; shells: RunningShell[] }>,
): Promise<void> => {
  const startedGeneration = generation;
  const since = revision;
  const listed = await listRunningShells(directory);
  if (startedGeneration !== generation) return;
  // Keyed by the directory OpenCode answered for, which its events carry too.
  replaceDirectoryShells(listed.directory, listed.shells, since);
};

/** Directories the index holds running commands for. */
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
  useBackgroundShellsStore.setState({ byId: new Map(), sessionIds: EMPTY_SESSION_IDS });
};

/**
 * Which of `sessionIds` are `rootId` itself or one of its subagents, at any
 * depth, sorted. `parentOf` answers from the session list the caller holds; a
 * session it does not know ends its chain, so its commands stay out.
 */
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

/** Commands of the given sessions that went to the background, oldest first. */
export const backgroundShellsOfSessions = (
  byId: ReadonlyMap<string, TrackedShell>,
  sessionIds: ReadonlySet<string>,
): TrackedShell[] => {
  const shells: TrackedShell[] = [];
  for (const shell of byId.values()) {
    if (shell.background && sessionIds.has(shell.sessionID)) shells.push(shell);
  }
  return shells.sort((left, right) => left.startedAt - right.startedAt || left.id.localeCompare(right.id));
};

export const useRunningShell = (shellID: string | undefined): TrackedShell | undefined => (
  useBackgroundShellsStore(useCallback((state) => (shellID ? state.byId.get(shellID) : undefined), [shellID]))
);
