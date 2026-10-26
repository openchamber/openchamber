/**
 * Where OpenChamber's unread marks start.
 *
 * OpenCode keeps whether a session's last turn was seen: `time.idle` is when
 * the turn ended, `time.viewed` a watermark of the last ending a viewer saw. No
 * OpenChamber client recorded views before the UI read this state, so every
 * session that ever finished a turn would show as unread at once. The baseline
 * is the moment this data dir first ran with unread marks: a turn that ended
 * before it counts as seen, and the proxy serves `time.viewed` up to
 * `time.idle` for it. Nothing is written to OpenCode.
 *
 * One JSON file per data dir, `{ since }`, written once. The VS Code extension
 * keeps the same file in the same directory (`openchamberSessionState.ts`), so
 * both read one baseline.
 */

import fsDefault from 'node:fs';
import pathDefault from 'node:path';
import { z } from 'zod';

const FILE_NAME = 'sessions-unread.json';

const asTimestamp = (value) => (Number.isSafeInteger(value) && value > 0 ? value : null);

const turnTimesSchema = z.object({
  idle: z.number(),
  viewed: z.number().optional(),
});

/**
 * The record as served: a turn that ended before `since` and has no newer view
 * reads as viewed when it ended. Anything else is left as OpenCode sent it.
 */
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
      // This process still serves its baseline; the next start tries again.
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
    // Not replaced: a new baseline would quietly mark every turn up to now as
    // seen. Without one the records go out as OpenCode sent them.
    console.warn(`[openchamber-sessions] the unread baseline in ${filePath} is unreadable; it is left as is`);
    return { since: null, retry: false };
  };

  /** The baseline in epoch ms, or `null` when it cannot be known. A failed read is retried on the next call. */
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
