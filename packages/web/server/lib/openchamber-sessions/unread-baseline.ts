
import fsDefault from 'node:fs';
import pathDefault from 'node:path';
import { z } from 'zod';
import { hasCode, hasMessage, isTimestamp } from './contracts.js';
import type { FileStoreOptions } from './contracts.js';

const FILE_NAME = 'sessions-unread.json';

const turnTimesSchema = z.object({
  idle: z.number(),
  viewed: z.number().optional(),
});

export interface UnreadBaselineOverlay {
  time: { viewed: number };
}

export function withUnreadBaseline<Session>(session: Session, since: number): Session | UnreadBaselineOverlay;
export function withUnreadBaseline<T extends { time?: object | null } | null | undefined>(session: T, since: number) {
  const times = turnTimesSchema.safeParse(session?.time);
  if (!times.success) return session;
  const { idle, viewed } = times.data;
  if (idle > since || (viewed !== undefined && viewed >= idle)) return session;
  return { ...session, time: { ...session?.time, viewed: idle } };
}

const hasSince = (value: unknown): value is { since: unknown } =>
  value !== null && value !== undefined && 'since' in Object(value);

const storedTimestamp = (raw: string) => {
  try {
    const stored: unknown = JSON.parse(raw);
    const since = hasSince(stored) ? stored.since : undefined;
    return isTimestamp(since) ? since : null;
  } catch {
    return null;
  }
};

export const createUnreadBaseline = ({
  dataDir,
  fsPromises = fsDefault.promises,
  path = pathDefault,
  now = Date.now,
}: FileStoreOptions) => {
  const filePath = path.join(dataDir, FILE_NAME);
  let loadPromise: Promise<number | null> | null = null;

  const create = async () => {
    const since = now();
    try {
      await fsPromises.mkdir(dataDir, { recursive: true });
      const tmpPath = `${filePath}.${process.pid}.tmp`;
      await fsPromises.writeFile(tmpPath, JSON.stringify({ since }), 'utf8');
      await fsPromises.rename(tmpPath, filePath);
    } catch (error) {
      console.warn('[openchamber-sessions] could not save the unread baseline:', (hasMessage(error) ? error.message : undefined) ?? error);
    }
    return since;
  };

  const read = async () => {
    let raw;
    try {
      raw = await fsPromises.readFile(filePath, 'utf8');
    } catch (error) {
      if (hasCode(error) && error.code === 'ENOENT') return { since: await create(), retry: false };
      console.warn('[openchamber-sessions] could not read the unread baseline:', (hasMessage(error) ? error.message : undefined) ?? error);
      return { since: null, retry: true };
    }
    const since = storedTimestamp(raw);
    if (since !== null) return { since, retry: false };
    console.warn(`[openchamber-sessions] the unread baseline in ${filePath} is unreadable; it is left as is`);
    return { since: null, retry: false };
  };

  const get = () => {
    if (!loadPromise) {
      loadPromise = read().then(({ since, retry }) => {
        if (retry) loadPromise = null;
        return since;
      });
    }
    return loadPromise;
  };

  return { get };
};
