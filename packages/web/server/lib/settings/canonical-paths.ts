import fs from 'node:fs';
import pathModule from 'node:path';
import { promisify } from 'node:util';

import { isString } from '../shared/object-guards.js';
import { directoryReachability, type Reachability } from '../directory-reachability/index.js';

const REFRESH_WAIT_MS = 500;
const STUCK_LOOKUP_MS = 3000;
const CASE_INSENSITIVE_PLATFORMS = new Set(['win32', 'darwin']);

type DirectoryListings = Map<string, Promise<string[] | null>>;

export interface CanonicalPathsDependencies {
  path: Pick<typeof pathModule, 'join'>;
  platform: string;
  realpath: (value: string) => Promise<string>;
  readdir: (value: string) => Promise<string[]>;
  checkDirectory: (value: string) => Promise<Reachability>;
  refreshWaitMs?: number;
}

const rootLengthOf = (value: string) => {
  if (/^[a-zA-Z]:[\\/]/.test(value)) return 3;
  return value.startsWith('/') ? 1 : 0;
};

export const createCanonicalPaths = ({ path, platform, realpath, readdir, checkDirectory, refreshWaitMs = REFRESH_WAIT_MS }: CanonicalPathsDependencies) => {
  const known = new Map<string, string>();
  const queued = new Map<string, Promise<void>>();
  const attempts = new Map<string, symbol>();
  let tail: Promise<void> = Promise.resolve();
  let stalled = false;

  const list = (directory: string, listings: DirectoryListings) => {
    let entries = listings.get(directory);
    if (!entries) {
      entries = readdir(directory).catch(() => null);
      listings.set(directory, entries);
    }
    return entries;
  };

  const recoverCase = async (value: string, listings: DirectoryListings) => {
    const rootLength = CASE_INSENSITIVE_PLATFORMS.has(platform) ? rootLengthOf(value) : 0;
    if (rootLength === 0) return value;
    const separator = platform === 'win32' ? /[\\/]+/ : /\/+/;
    let current = value.slice(0, rootLength);
    for (const segment of value.slice(rootLength).split(separator).filter(Boolean)) {
      const entries = await list(current, listings);
      const next = entries?.includes(segment)
        ? segment
        : entries?.find((entry) => entry.toLowerCase() === segment.toLowerCase());
      if (!next) return value;
      current = path.join(current, next);
    }
    return current;
  };

  const resolve = async (value: string, listings: DirectoryListings) => {
    const attempt = Symbol();
    attempts.set(value, attempt);
    const resolved = await realpath(value).catch(() => null);
    const canonical = resolved === null ? null : await recoverCase(resolved, listings);
    if (attempts.get(value) !== attempt) return;
    if (canonical === null) known.delete(value);
    else known.set(value, canonical);
  };

  const enqueue = (value: string, listings: DirectoryListings) => {
    const current = queued.get(value);
    if (current) return current;
    const turn = checkDirectory(value).then((reachability) => {
      if (reachability === 'unreachable') {
        attempts.delete(value);
        return undefined;
      }
      const lookup = tail.then(() => resolve(value, listings));
      tail = Promise.race([lookup, tail.then(() => new Promise<void>((done) => { setTimeout(done, STUCK_LOOKUP_MS).unref?.(); }))]);
      return tail;
    }).finally(() => { queued.delete(value); });
    queued.set(value, turn);
    return turn;
  };

  return {
    of: (value: string) => known.get(value) ?? value,
    refresh: async (values: Iterable<string>) => {
      const listings: DirectoryListings = new Map();
      const all = Promise.all([...new Set(values)].filter((value) => isString(value) && value.length > 0).map((value) => enqueue(value, listings)));
      if (stalled) return;
      let timer: ReturnType<typeof setTimeout> | undefined;
      const late = new Promise<boolean>((done) => { timer = setTimeout(done, refreshWaitMs, true); });
      if (await Promise.race([all.then(() => false), late])) {
        stalled = true;
        void all.then(() => { stalled = false; });
      }
      clearTimeout(timer);
    },
  };
};

export const createServerCanonicalPaths = () => createCanonicalPaths({
  path: pathModule,
  platform: process.platform,
  realpath: promisify(fs.realpath),
  readdir: (directory) => fs.promises.readdir(directory),
  checkDirectory: directoryReachability.check,
});
