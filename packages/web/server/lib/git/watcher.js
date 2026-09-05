import { existsSync, readFileSync, statSync, watch } from 'node:fs';
import path from 'node:path';

const DEFAULT_DEBOUNCE_MS = 1_000;
const DEFAULT_IDLE_EVICT_MS = 30 * 60 * 1_000;
const DEFAULT_MAX_WATCHED = 20;
const isFunction = (value) => Object.prototype.toString.call(value) === '[object Function]';
const readFilename = (value) => {
  if (Object.prototype.toString.call(value) === '[object String]') {
    return String(value);
  }
  if (value instanceof Buffer) {
    return value.toString('utf8');
  }
  return '';
};

const resolveExistingDirectory = (target) => {
  try {
    return statSync(target).isDirectory() ? target : null;
  } catch {
    return null;
  }
};

const resolveGitDir = (directory) => {
  const dotGit = path.join(directory, '.git');

  try {
    const stats = statSync(dotGit);
    if (stats.isDirectory()) {
      return dotGit;
    }

    if (!stats.isFile()) {
      return null;
    }

    const match = readFileSync(dotGit, 'utf8').match(/^gitdir:\s*(.+)\s*$/m);
    if (!match) {
      return null;
    }

    const resolved = path.isAbsolute(match[1])
      ? match[1]
      : path.resolve(directory, match[1]);
    return resolveExistingDirectory(resolved);
  } catch {
    return null;
  }
};

export function createGitChangeWatcher({
  broadcast,
  debounceMs = DEFAULT_DEBOUNCE_MS,
  idleEvictMs = DEFAULT_IDLE_EVICT_MS,
  maxWatched = DEFAULT_MAX_WATCHED,
  now = Date.now,
  watchImpl = watch,
  setTimer = setTimeout,
  clearTimer = clearTimeout,
} = {}) {
  const emit = isFunction(broadcast) ? broadcast : () => {};
  const entries = new Map();

  const closeEntry = (directory) => {
    const entry = entries.get(directory);
    if (!entry) {
      return;
    }

    if (entry.timer) {
      clearTimer(entry.timer);
    }

    for (const watcher of entry.watchers) {
      try {
        watcher.close();
      } catch {
      }
    }

    entries.delete(directory);
  };

  const scheduleBroadcast = (directory) => {
    const entry = entries.get(directory);
    if (!entry) {
      return;
    }

    if (entry.timer) {
      clearTimer(entry.timer);
    }

    entry.timer = setTimer(() => {
      const current = entries.get(directory);
      if (!current) {
        return;
      }
      current.timer = null;
      emit(directory);
    }, debounceMs);
  };

  const handleFsEvent = (directory, gitDir, filename) => {
    const name = readFilename(filename);
    if (!name) {
      if (existsSync(path.join(gitDir, 'index.lock'))) {
        return;
      }
      scheduleBroadcast(directory);
      return;
    }
    if (name.endsWith('.lock')) {
      return;
    }
    scheduleBroadcast(directory);
  };

  const attachWatch = (directory, gitDir, target, options, watchers) => {
    try {
      const watcher = watchImpl(target, options, (_eventType, filename) => {
        handleFsEvent(directory, gitDir, filename);
      });
      watcher.on('error', () => {
        closeEntry(directory);
      });
      watchers.push(watcher);
      return true;
    } catch {
      return false;
    }
  };

  const evictStaleEntries = () => {
    const cutoff = now() - idleEvictMs;
    for (const [directory, entry] of entries) {
      if (entry.lastTouched < cutoff) {
        closeEntry(directory);
      }
    }
  };

  const evictLeastRecentlyTouchedEntry = () => {
    if (entries.size < maxWatched) {
      return;
    }

    let oldestDirectory = null;
    let oldestTouched = Infinity;
    for (const [directory, entry] of entries) {
      if (entry.lastTouched < oldestTouched) {
        oldestDirectory = directory;
        oldestTouched = entry.lastTouched;
      }
    }

    if (oldestDirectory) {
      closeEntry(oldestDirectory);
    }
  };

  const ensureWatch = (directory) => {
    const existing = entries.get(directory);
    if (existing) {
      existing.lastTouched = now();
      return;
    }

    evictStaleEntries();
    evictLeastRecentlyTouchedEntry();

    const gitDir = resolveGitDir(directory);
    if (!gitDir) {
      return;
    }

    const watchers = [];
    if (!attachWatch(directory, gitDir, gitDir, undefined, watchers)) {
      return;
    }

    const entry = {
      watchers,
      timer: null,
      lastTouched: now(),
    };
    entries.set(directory, entry);

    const refsDir = path.join(gitDir, 'refs');
    if (!attachWatch(directory, gitDir, refsDir, { recursive: true }, watchers)) {
      for (const child of ['heads', 'remotes']) {
        const childDir = path.join(refsDir, child);
        if (existsSync(childDir)) {
          attachWatch(directory, gitDir, childDir, undefined, watchers);
        }
      }
    }
  };

  const dispose = () => {
    for (const directory of Array.from(entries.keys())) {
      closeEntry(directory);
    }
  };

  return {
    ensureWatch,
    dispose,
  };
}
