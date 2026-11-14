import { watch } from 'node:fs';

const SAFETY_POLL_MS = 30_000;

/** Signals only request a fingerprint check; two equal checks settle a change. */
export const createFolderChangeWatch = ({
  root, fingerprint, onChange, pollMs, recursive = false, fsWatch = watch,
  timers = globalThis, logger = console,
}) => {
  let watcher = null;
  let pending = null;
  let running = null;
  let stopped = false;
  let reported = null;
  let seen = null;

  const schedule = () => {
    if (stopped || pending !== null) return;
    pending = timers.setTimeout(() => {
      pending = null;
      return check();
    }, pollMs);
    pending.unref?.();
  };

  const check = () => {
    if (stopped) return Promise.resolve();
    if (running) {
      schedule();
      return running;
    }
    running = (async () => {
      try {
        const current = await fingerprint();
        if (stopped) return;
        if (reported === null) {
          reported = seen = current;
          return;
        }
        const settled = current === seen;
        seen = current;
        if (!settled) schedule();
        else if (current !== reported) {
          await onChange();
          if (!stopped) reported = current;
        }
      } catch (error) {
        logger.warn('Failed to check a watched folder:', error?.message ?? error);
      } finally {
        running = null;
        if (!watcher) schedule();
      }
    })();
    return running;
  };

  const closeWatcher = () => {
    const previous = watcher;
    watcher = null;
    previous?.close();
  };

  const arm = () => {
    closeWatcher();
    if (stopped) return;
    try {
      const next = fsWatch(root, { recursive, persistent: false }, schedule);
      watcher = next;
      next.on('error', () => {
        if (watcher !== next) return;
        closeWatcher();
        schedule();
      });
      next.on('close', () => {
        if (watcher !== next) return;
        watcher = null;
        schedule();
      });
    } catch {
      // An unsupported watch or missing root keeps the previous fast cadence.
      schedule();
    }
  };

  // Reopening also replaces a silently stale Linux/Windows inode watch.
  arm();
  const ready = check();
  const safety = timers.setInterval(() => {
    arm();
    return check();
  }, SAFETY_POLL_MS);
  safety.unref?.();

  return {
    ready,
    check,
    stop: () => {
      stopped = true;
      closeWatcher();
      timers.clearTimeout(pending);
      pending = null;
      timers.clearInterval(safety);
    },
  };
};
