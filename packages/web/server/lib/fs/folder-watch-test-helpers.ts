import { EventEmitter } from 'node:events';
import type { WatchOptions } from 'node:fs';
import type { FolderWatchTimers } from './folder-change-watch.js';

interface WatchJob {
  callback: () => void | Promise<void>;
  due: number;
  repeat: number;
  unref: () => void;
}

interface HarnessWatcher extends EventEmitter {
  root: string;
  options: WatchOptions;
  closed: boolean;
  close: () => void;
  signal: () => void;
}

export const folderWatchHarness = () => {
  let now = 0;
  let failure = false;
  const jobs = new Set<WatchJob>();
  const watchers: HarnessWatcher[] = [];
  const add = (callback: WatchJob['callback'], delay: number, repeat: number) => {
    const job = { callback, due: now + delay, repeat, unref() {} };
    jobs.add(job);
    return job;
  };
  return {
    jobs,
    watchers,
    fail: (value: boolean) => { failure = value; },
    fsWatch: (root: string, options: WatchOptions, callback: (event: 'change') => void) => {
      if (failure) throw new Error('watch unavailable');
      const watcher: HarnessWatcher = Object.assign(new EventEmitter(), {
        root,
        options,
        closed: false,
        close: () => { watcher.closed = true; watcher.emit('close'); },
        signal: () => { if (!watcher.closed) callback('change'); },
      });
      watchers.push(watcher);
      return watcher;
    },
    timers: {
      setTimeout: (callback: WatchJob['callback'], delay: number) => add(callback, delay, 0),
      setInterval: (callback: WatchJob['callback'], delay: number) => add(callback, delay, delay),
      clearTimeout: (job: WatchJob | null | undefined) => job ? jobs.delete(job) : false,
      clearInterval: (job: WatchJob | null | undefined) => job ? jobs.delete(job) : false,
    } satisfies FolderWatchTimers<WatchJob>,
    advance: async (ms: number) => {
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
