import type { GuestEndedShell, GuestRunningShell, GuestRunningShellsSnapshot, GuestShellOutputResult, GuestShellsScope } from '@openchamber/sdk';
import { GUEST_SHELLS_MAX, HostRequestError } from '@openchamber/sdk';
import { OpencodeApiError, opencodeClient } from '@/lib/opencode/client';
import { sessionsInTree, useBackgroundShellsStore, type EndedShell, type TrackedShell } from '@/sync/background-shells';
import { useGlobalSessionsStore } from '@/stores/useGlobalSessionsStore';
import { useProjectsStore } from '@/stores/useProjectsStore';
import { useSessionUIStore } from '@/sync/session-ui-store';
import { getRuntimeKey, subscribeRuntimeEndpointChanged } from '@/lib/runtime-switch';
import { normalizePath } from '@/lib/pathNormalization';
import { guestProject, guestProjectWorktrees } from './workspace';

/**
 * The sessions a scope covers, or null for every session. A project scope
 * covers the sessions that run in the project root or one of its worktrees,
 * the same membership the workspace projection reports.
 */
const scopeSessionIds = (scope: GuestShellsScope): ReadonlySet<string> | null => {
  if (scope.kind === 'global') return null;
  const sessions = useGlobalSessionsStore.getState().entityById;
  if (scope.kind === 'project') {
    const directories = new Set<string>();
    const project = useProjectsStore.getState().projects.find((entry) => entry.id === scope.projectId);
    if (project) {
      directories.add(normalizePath(project.path) ?? project.path);
      for (const worktree of guestProjectWorktrees(project.path)) {
        const directory = normalizePath(worktree.path);
        if (directory) directories.add(directory);
      }
    }
    const ids = new Set<string>();
    for (const session of sessions.values()) {
      if (directories.has(normalizePath(session.directory) ?? session.directory)) ids.add(session.id);
    }
    return ids;
  }
  const known = new Set<string>();
  const store = useBackgroundShellsStore.getState();
  for (const shell of store.byId.values()) known.add(shell.sessionID);
  for (const shell of store.ended.values()) known.add(shell.sessionID);
  return new Set(sessionsInTree(known, scope.sessionId, (id) => sessions.get(id)?.parentID ?? undefined));
};

const guestShell = (shell: TrackedShell): GuestRunningShell => ({
  id: shell.id, sessionID: shell.sessionID, command: shell.command, startedAt: shell.startedAt, background: shell.background,
});

const guestEndedShell = (shell: EndedShell): GuestEndedShell => (shell.exit === undefined
  ? { ...guestShell(shell), status: shell.status, endedAt: shell.endedAt }
  : { ...guestShell(shell), status: shell.status, exit: shell.exit, endedAt: shell.endedAt });

/**
 * The running shells a scope covers, oldest first, and the ones that ended,
 * oldest end first with the newest kept. Local store only; never a network read.
 */
export const readGuestShells = (scope: GuestShellsScope): GuestRunningShellsSnapshot => {
  const store = useBackgroundShellsStore.getState();
  const inScope = scopeSessionIds(scope);
  const shells: GuestRunningShell[] = [];
  for (const shell of store.byId.values()) {
    if (inScope && !inScope.has(shell.sessionID)) continue;
    shells.push(guestShell(shell));
  }
  shells.sort((left, right) => left.startedAt - right.startedAt || left.id.localeCompare(right.id));
  const ended: GuestEndedShell[] = [];
  for (const shell of store.ended.values()) {
    if (inScope && !inScope.has(shell.sessionID)) continue;
    ended.push(guestEndedShell(shell));
  }
  ended.sort((left, right) => left.endedAt - right.endedAt || left.id.localeCompare(right.id));
  return { kind: 'shells', scope, shells: shells.slice(0, GUEST_SHELLS_MAX), ended: ended.slice(-GUEST_SHELLS_MAX) };
};

/**
 * One page of a command's output, running or ended. OpenCode keeps an ended
 * command's output until it evicts the command (it retains the latest 25 per
 * directory); a stopped command's output goes with it at once.
 */
export const readGuestShellOutput = async (shellId: string, cursor?: number, tailBytes?: number): Promise<GuestShellOutputResult> => {
  const store = useBackgroundShellsStore.getState();
  const ended = store.ended.get(shellId);
  if (ended?.status === 'stopped') throw new HostRequestError('NOT_FOUND', 'A stopped shell keeps no output.');
  const shell = store.byId.get(shellId) ?? ended;
  if (!shell) throw new HostRequestError('NOT_FOUND', 'OpenChamber has not seen that shell.');
  try {
    return await opencodeClient.readShellOutput(shell.id, shell.directory, cursor, tailBytes);
  } catch (error) {
    if (error instanceof OpencodeApiError && error.status === 404) throw new HostRequestError('NOT_FOUND', 'OpenCode no longer keeps that shell\'s output.');
    throw error;
  }
};

const scopeKey = (scope: GuestShellsScope): string => {
  if (scope.kind === 'session') return `session:${scope.sessionId}`;
  if (scope.kind === 'project') return `project:${scope.projectId}`;
  return 'global';
};

type Observer = { listeners: Set<(snapshot: GuestRunningShellsSnapshot) => void>; snapshot: GuestRunningShellsSnapshot; dispose: () => void };
const observers = new Map<string, Observer>();

/** One shared observer per runtime and scope, mirroring the workspace observer lifecycle. */
export const observeGuestShells = (scope: GuestShellsScope, listener: (snapshot: GuestRunningShellsSnapshot) => void): (() => void) => {
  if (scope.kind === 'project') guestProject(scope.projectId);
  const key = `${getRuntimeKey()}|${scopeKey(scope)}`;
  let observer = observers.get(key);
  if (!observer) {
    const listeners = new Set<(snapshot: GuestRunningShellsSnapshot) => void>();
    const current: Observer = { listeners, snapshot: readGuestShells(scope), dispose: () => {} };
    let queued = false;
    let disposed = false;
    let serialized = JSON.stringify(current.snapshot);
    const update = () => {
      if (queued || disposed) return;
      queued = true;
      queueMicrotask(() => {
        queued = false;
        if (disposed) return;
        const next = readGuestShells(scope);
        const json = JSON.stringify(next);
        if (json === serialized) return;
        serialized = json;
        current.snapshot = next;
        for (const notify of listeners) notify(next);
      });
    };
    const unsubs = [
      useBackgroundShellsStore.subscribe(update),
      useGlobalSessionsStore.subscribe((state, previous) => { if (state.entityById !== previous.entityById) update(); }),
    ];
    if (scope.kind === 'project') {
      unsubs.push(useProjectsStore.subscribe((state, previous) => {
        if (state.projects !== previous.projects || state.hasServerSnapshot !== previous.hasServerSnapshot) update();
      }));
      unsubs.push(useSessionUIStore.subscribe((state, previous) => {
        if (state.availableWorktreesByProject !== previous.availableWorktreesByProject) update();
      }));
    }
    current.dispose = () => { disposed = true; for (const unsubscribe of unsubs) unsubscribe(); observers.delete(key); };
    unsubs.push(subscribeRuntimeEndpointChanged(current.dispose));
    observers.set(key, current);
    observer = current;
  }
  observer.listeners.add(listener);
  listener(observer.snapshot);
  const current = observer;
  return () => { current.listeners.delete(listener); if (current.listeners.size === 0) current.dispose(); };
};
