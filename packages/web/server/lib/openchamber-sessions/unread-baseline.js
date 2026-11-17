
import fsDefault from 'node:fs';
import pathDefault from 'node:path';
import { z } from 'zod';

const FILE_NAME = 'sessions-unread.json';

const asTimestamp = (value) => (Number.isSafeInteger(value) && value > 0 ? value : null);

const turnTimesSchema = z.object({
  idle: z.number(),
  viewed: z.number().optional(),
});

export const withUnreadBaseline = (session, since) => {
  const times = turnTimesSchema.safeParse(session?.time);
  if (!times.success) return session;
  const { idle, viewed } = times.data;
  if (idle > since || (viewed !== undefined && viewed >= idle)) return session;
  return { ...session, time: { ...session.time, viewed: idle } };
};

/**
 * @param {object} options
 * @param {string} options.dataDir OpenChamber data directory for this instance.
 * @param {typeof fsDefault.promises} [options.fsPromises]
 * @param {typeof pathDefault} [options.path]
 * @param {() => number} [options.now]
 */
export const createUnreadBaseline = ({
  dataDir,
  fsPromises = fsDefault.promises,
  path = pathDefault,
  now = Date.now,
}) => {
  const filePath = path.join(dataDir, FILE_NAME);
  let loadPromise = null;

  const create = async () => {
    const since = now();
    try {
      await fsPromises.mkdir(dataDir, { recursive: true });
      const tmpPath = `${filePath}.${process.pid}.tmp`;
      await fsPromises.writeFile(tmpPath, JSON.stringify({ since }), 'utf8');
      await fsPromises.rename(tmpPath, filePath);
    } catch (error) {
      console.warn('[openchamber-sessions] could not save the unread baseline:', error?.message ?? error);
    }
    return since;
  };

  const read = async () => {
    let raw;
    try {
      raw = await fsPromises.readFile(filePath, 'utf8');
    } catch (error) {
      if (error?.code === 'ENOENT') return { since: await create(), retry: false };
      console.warn('[openchamber-sessions] could not read the unread baseline:', error?.message ?? error);
      return { since: null, retry: true };
    }
    try {
      const since = asTimestamp(JSON.parse(raw)?.since);
      if (since !== null) return { since, retry: false };
    } catch {
      // Falls through to the warning below.
    }
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
