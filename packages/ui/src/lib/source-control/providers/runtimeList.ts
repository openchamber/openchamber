import { z } from 'zod';
import { isTransientRuntimeKey } from '@/lib/runtime-switch';


const MAX_RUNTIMES = 16;

export const createRuntimeListSnapshot = <T,>(storageKey: string, listSchema: z.ZodType<T[]>) => {
  const snapshotSchema = z.array(z.tuple([z.string(), listSchema]));
  const readAll = (): Array<[string, T[]]> => {
    try {
      const parsed = snapshotSchema.safeParse(JSON.parse(window.localStorage.getItem(storageKey) ?? '[]'));
      return parsed.success ? parsed.data : [];
    } catch {
      return [];
    }
  };
  return {
    read: (runtimeKey: string): T[] | null => (
      isTransientRuntimeKey(runtimeKey) ? null : readAll().find(([key]) => key === runtimeKey)?.[1] ?? null
    ),
    remember: (runtimeKey: string, list: readonly T[]): void => {
      if (isTransientRuntimeKey(runtimeKey)) return;
      const entries = readAll().filter(([key]) => key !== runtimeKey);
      entries.push([runtimeKey, [...list]]);
      try {
        window.localStorage.setItem(storageKey, JSON.stringify(entries.slice(-MAX_RUNTIMES)));
      // oxlint-disable-next-line no-empty
      } catch {
      }
    },
  };
};

export const sameList = <T,>(held: readonly T[], next: readonly T[]): boolean => (
  held === next || (held.length === next.length && JSON.stringify(held) === JSON.stringify(next))
);

export const listRetryDelayMs = (failures: number): number => Math.min(60_000, 2_000 * 2 ** Math.max(0, failures - 1));
