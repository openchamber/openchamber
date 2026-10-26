import { getRuntimeKey } from '@/lib/runtime-switch';

/**
 * Lets an open editor follow its file through a move or rename.
 *
 * The editor holds unsaved edits for one path. A move has two moments that
 * matter to it: while the rename request is in flight a save would write the
 * old path and recreate the file there, and once the move lands the editor
 * must adopt the new path instead of re-reading the file (which would drop the
 * draft). Paths are normalized workspace paths with forward slashes and no
 * trailing slash.
 */

type FilePathMoveEvent = {
  runtimeKey: string;
  from: string;
  to: string;
};

type FilePathMoveListener = (move: FilePathMoveEvent) => void;

type FilePathMove = {
  /** The rename landed: editors under `from` now live under `to`. */
  commit: (to: string) => void;
  /** The rename failed: nothing moved. */
  abort: () => void;
};

const listeners = new Set<FilePathMoveListener>();
const inFlightMoves = new Set<{ runtimeKey: string; from: string }>();

const toComparablePath = (value: string): string => (
  /^[A-Za-z]:\//.test(value) ? value.toLowerCase() : value
);

/** `path` rebased from `from` to `to`, or null when `path` is not `from` or inside it. */
export const rebaseMovedPath = (path: string, from: string, to: string): string | null => {
  const comparablePath = toComparablePath(path);
  const comparableFrom = toComparablePath(from);
  if (comparablePath === comparableFrom) return to;
  if (comparablePath.startsWith(`${comparableFrom}/`)) return `${to}${path.slice(from.length)}`;
  return null;
};

/** A copy of a path-keyed record with keys at or under `from` moved under `to`. */
export const rebaseMovedPathKeys = <T>(record: Record<string, T>, from: string, to: string): Record<string, T> => {
  let next: Record<string, T> | null = null;
  for (const [path, value] of Object.entries(record)) {
    const moved = rebaseMovedPath(path, from, to);
    if (moved === null) continue;
    next ??= { ...record };
    delete next[path];
    next[moved] = value;
  }
  return next ?? record;
};

export const beginFilePathMove = (from: string): FilePathMove => {
  const entry = { runtimeKey: getRuntimeKey(), from };
  inFlightMoves.add(entry);
  let settled = false;
  const settle = (): boolean => {
    if (settled) return false;
    settled = true;
    inFlightMoves.delete(entry);
    return true;
  };
  return {
    commit: (to) => {
      if (!settle()) return;
      for (const listener of listeners) {
        listener({ runtimeKey: entry.runtimeKey, from, to });
      }
    },
    abort: () => {
      settle();
    },
  };
};

/** True while a move of `path`, or of a folder containing it, is in flight. */
export const isFilePathMoveInFlight = (path: string): boolean => {
  const runtimeKey = getRuntimeKey();
  for (const move of inFlightMoves) {
    if (move.runtimeKey === runtimeKey && rebaseMovedPath(path, move.from, move.from) !== null) {
      return true;
    }
  }
  return false;
};

/** Listeners run synchronously on commit, before the tab stores are rebased. */
export const subscribeToFilePathMoves = (listener: FilePathMoveListener): (() => void) => {
  listeners.add(listener);
  return () => listeners.delete(listener);
};
