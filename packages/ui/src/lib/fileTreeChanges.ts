
import { getNormalizedParentDirectory, normalizePath } from '@/lib/pathNormalization';
import { isFinalToolStatus, type Part } from '@/lib/opencode/model';
import { toolListingChanges } from '@/lib/opencode/tools';

export type FileTreeChange = { directory: string; paths?: string[] };

type FileTreeChangeListener = (change: FileTreeChange) => void;

const listeners = new Set<FileTreeChangeListener>();
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
