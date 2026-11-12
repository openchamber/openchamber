import { z } from 'zod';
import { isTransientRuntimeKey } from '@/lib/runtime-switch';

/**
 * What the source-control provider registry and the tracker registry share:
 * a server's list remembered per runtime, the no-op check and the retry wait.
 */

const MAX_RUNTIMES = 16;

/**
 * A list remembered per runtime in `localStorage`, at most 16 runtimes, the
 * longest unvisited trimmed first. A transient runtime key (no instance yet,
 * the phone disconnected) is never a slot: it names no server, so nothing is
 * read from or written under it.
 */
export const createRuntimeListSnapshot = <T,>(storageKey: string, listSchema: z.ZodType<T[]>) => {
  const snapshotSchema = z.array(z.tuple([z.string(), listSchema]));
  const readAll = (): Array<[string, T[]]> => {
    try {
      const parsed = snapshotSchema.safeParse(JSON.parse(window.localStorage.getItem(storageKey) ?? '[]'));
      // A corrupt snapshot only costs the head start; the server still answers.
      return parsed.success ? parsed.data : [];
    } catch {
      return [];
    }
  };
  return {
    /** The list remembered for this runtime; null when there is none. */
    read: (runtimeKey: string): T[] | null => (
      isTransientRuntimeKey(runtimeKey) ? null : readAll().find(([key]) => key === runtimeKey)?.[1] ?? null
    ),
    remember: (runtimeKey: string, list: readonly T[]): void => {
      if (isTransientRuntimeKey(runtimeKey)) return;
      // Re-inserted last, so the runtimes visited longest ago are the ones trimmed.
      const entries = readAll().filter(([key]) => key !== runtimeKey);
      entries.push([runtimeKey, [...list]]);
      try {
        window.localStorage.setItem(storageKey, JSON.stringify(entries.slice(-MAX_RUNTIMES)));
      } catch {
        // Storage full or blocked: the list still holds for this session.
      }
    },
  };
};

/**
 * Whether a refreshed list says the same as the held one. Lists hold at most a
 * handful of parsed descriptors, so their JSON is a cheap and exact check, and
 * a no-op refresh keeps the held objects for every selector that reads them.
 */
export const sameList = <T,>(held: readonly T[], next: readonly T[]): boolean => (
  held === next || (held.length === next.length && JSON.stringify(held) === JSON.stringify(next))
);

/** The wait before asking again after the n-th failed read in a row with nothing to show: 2 s, doubling, at most a minute. */
export const listRetryDelayMs = (failures: number): number => Math.min(60_000, 2_000 * 2 ** Math.max(0, failures - 1));
