/**
 * Tells file browsers which listings may be out of date, from signals the
 * client already receives. There is no watcher and no timer: OpenCode 2.x
 * reports no file events (its `filesystem.changed` covers the repository HEAD
 * only), so the agent's own activity is the source.
 *
 * - A finished `write` or `patch` names its files: their directories change.
 * - A finished `shell`, `execute`, MCP or plugin call could touch anything.
 *   Its session is remembered until the step ends; the step's snapshot then
 *   says whether any file changed. A step that changed nothing costs nothing,
 *   which is the common case for read-only commands.
 * - A finished user shell command and a revert are unknown changes.
 *
 * Changes outside the agent (an editor, a terminal) are not seen here.
 */

import { getNormalizedParentDirectory, normalizePath } from '@/lib/pathNormalization';
import { isFinalToolStatus, type Part } from '@/lib/opencode/model';
import { toolListingChanges } from '@/lib/opencode/tools';

/**
 * `paths` are absolute, normalized files whose parent listings changed.
 * Without `paths` anything under `directory` may have changed.
 */
export type FileTreeChange = { directory: string; paths?: string[] };

type FileTreeChangeListener = (change: FileTreeChange) => void;

const listeners = new Set<FileTreeChangeListener>();
/** Sessions with a finished call that could have touched any file, until their step ends. */
const sessionsAwaitingStep = new Set<string>();

export const subscribeFileTreeChanges = (listener: FileTreeChangeListener): (() => void) => {
  listeners.add(listener);
  return () => {
    listeners.delete(listener);
  };
};

export const notifyFileTreeChanged = (change: FileTreeChange): void => {
  const directory = normalizePath(change.directory);
  if (!directory) return;
  const next = change.paths ? { directory, paths: change.paths } : { directory };
  for (const listener of listeners) {
    listener(next);
  }
};

const isAbsolute = (path: string): boolean => path.startsWith('/') || /^[A-Za-z]:\//.test(path);

const resolveAgainst = (directory: string, path: string): string | null => {
  const normalized = normalizePath(path);
  if (!normalized) return null;
  if (isAbsolute(normalized)) return normalized;
  const segments = directory === '/' ? [''] : directory.split('/');
  for (const segment of normalized.split('/')) {
    if (segment === '' || segment === '.') continue;
    if (segment === '..') {
      if (segments.length > 1) segments.pop();
      continue;
    }
    segments.push(segment);
  }
  return segments.join('/') || '/';
};

export const fileTreeChanges = {
  toolTransition(directory: string, previousPart: Part | undefined, nextPart: Part): void {
    if (nextPart.type !== 'tool' || !isFinalToolStatus(nextPart.state.status)) return;
    if (previousPart?.type === 'tool' && isFinalToolStatus(previousPart.state.status)) return;
    const state = nextPart.state;
    const metadata = state.status === 'completed' || state.status === 'error' ? state.metadata : undefined;
    const named = toolListingChanges(nextPart.tool, state.input, metadata);
    if (named === null) {
      sessionsAwaitingStep.add(nextPart.sessionID);
      return;
    }
    const root = normalizePath(directory);
    if (!root || named.length === 0) return;
    const paths = named
      .map((path) => resolveAgainst(root, path))
      .filter((path): path is string => path !== null);
    if (paths.length > 0) notifyFileTreeChanged({ directory: root, paths });
  },

  /**
   * A step ended. `files` is its snapshot's changed files, or undefined when
   * there is no snapshot (snapshots off, not a Git repository, a failed step).
   */
  stepCompleted(directory: string, sessionID: string, files: readonly string[] | undefined): void {
    if (!sessionsAwaitingStep.delete(sessionID)) return;
    if (files && files.length === 0) return;
    notifyFileTreeChanged({ directory });
  },

  unknownChange(directory: string): void {
    notifyFileTreeChanged({ directory });
  },
};

const isWithin = (path: string, root: string): boolean =>
  path === root || path.startsWith(root === '/' ? '/' : `${root}/`);

/**
 * The directories of `root`'s tree a change can affect: each named file's
 * parent, or `null` when the whole tree is in question. An empty list means
 * the change is elsewhere.
 */
export const affectedDirectories = (change: FileTreeChange, root: string): string[] | null => {
  if (!change.paths) {
    return isWithin(change.directory, root) || isWithin(root, change.directory) ? null : [];
  }
  const directories = new Set<string>();
  for (const path of change.paths) {
    const parent = getNormalizedParentDirectory(path);
    if (parent && isWithin(parent, root)) directories.add(parent);
  }
  return [...directories];
};
