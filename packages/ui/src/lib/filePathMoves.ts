import { getRuntimeKey } from '@/lib/runtime-switch';


type FilePathMoveEvent = {
  runtimeKey: string;
  from: string;
  to: string;
};

type FilePathMoveListener = (move: FilePathMoveEvent) => void;

type FilePathMove = {
  commit: (to: string) => void;
  abort: () => void;
};

const listeners = new Set<FilePathMoveListener>();
const inFlightMoves = new Set<{ runtimeKey: string; from: string }>();

const toComparablePath = (value: string): string => (
  /^[A-Za-z]:\//.test(value) ? value.toLowerCase() : value
);

export const rebaseMovedPath = (path: string, from: string, to: string): string | null => {
  const comparablePath = toComparablePath(path);
  const comparableFrom = toComparablePath(from);
  if (comparablePath === comparableFrom) return to;
  if (comparablePath.startsWith(`${comparableFrom}/`)) return `${to}${path.slice(from.length)}`;
  return null;
};

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

export const isFilePathMoveInFlight = (path: string): boolean => {
  const runtimeKey = getRuntimeKey();
  for (const move of inFlightMoves) {
    if (move.runtimeKey === runtimeKey && rebaseMovedPath(path, move.from, move.from) !== null) {
      return true;
    }
  }
  return false;
};

export const subscribeToFilePathMoves = (listener: FilePathMoveListener): (() => void) => {
  listeners.add(listener);
  return () => listeners.delete(listener);
};
