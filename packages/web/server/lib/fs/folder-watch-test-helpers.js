import { EventEmitter } from 'node:events';

/** Deterministic clock and OS signals for the package/theme watch contracts. */
export const folderWatchHarness = () => {
  let now = 0;
  let failure = false;
  const jobs = new Set();
  const watchers = [];
  const add = (callback, delay, repeat) => {
    const job = { callback, due: now + delay, repeat, unref() {} };
    jobs.add(job);
    return job;
  };
  return {
    jobs,
    watchers,
    fail: (value) => { failure = value; },
    fsWatch: (root, options, callback) => {
      if (failure) throw new Error('watch unavailable');
      const watcher = new EventEmitter();
      watcher.root = root;
      watcher.options = options;
      watcher.closed = false;
      watcher.close = () => { watcher.closed = true; watcher.emit('close'); };
      watcher.signal = () => { if (!watcher.closed) callback('change'); };
      watchers.push(watcher);
      return watcher;
    },
    timers: {
      setTimeout: (callback, delay) => add(callback, delay, 0),
      setInterval: (callback, delay) => add(callback, delay, delay),
      clearTimeout: (job) => jobs.delete(job),
      clearInterval: (job) => jobs.delete(job),
    },
    advance: async (ms) => {
      const end = now + ms;
      while (true) {
        const next = [...jobs].filter((job) => job.due <= end).sort((a, b) => a.due - b.due)[0];
        if (!next) break;
        now = next.due;
        if (next.repeat) next.due += next.repeat;
        else jobs.delete(next);
        await next.callback();
      }
      now = end;
    },
  };
};
