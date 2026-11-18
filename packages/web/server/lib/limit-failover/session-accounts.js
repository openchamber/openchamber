import { z } from 'zod';

/**
 * Per-session account choices for the limit failover: the account a session
 * pinned itself to, and whether hitting its limit may still move the session
 * (preferred) or fails the turn instead (fixed). Sessions following the global
 * settings have no record. Stored in `limit-failover/session-accounts.json`
 * under the data directory, so a restart keeps the pins.
 */

const FILE_NAME = 'session-accounts.json';
const MAX_SESSIONS = 500;

const id = z.string().min(1).max(200);
const entrySchema = z.object({
  sessionID: id,
  providerID: z.string().min(1).max(200),
  mode: z.enum(['preferred', 'fixed']),
  credentialID: id,
  updatedAt: z.number().finite().nonnegative(),
});
const storeSchema = z.object({ version: z.literal(1), sessions: z.array(entrySchema) });

export const createSessionAccountStore = ({ fsPromises, path, dataDir, now = Date.now }) => {
  const filePath = dataDir ? path.join(dataDir, 'limit-failover', FILE_NAME) : null;

  let loaded = null;
  let writing = Promise.resolve();
  const serialize = (task) => {
    const pending = writing.then(task, task);
    writing = pending.then(() => undefined, () => undefined);
    return pending;
  };

  const readStore = () => serialize(async () => {
    if (filePath === null) return { version: 1, sessions: [] };
    const raw = await fsPromises.readFile(filePath, 'utf8').catch((error) => {
      if (error?.code === 'ENOENT') return null;
      throw error;
    });
    if (raw === null) return { version: 1, sessions: [] };
    const parsed = storeSchema.safeParse(JSON.parse(raw));
    // A file that is not a store is a failure, never an empty list: dropping
    // every pin silently would turn pinned sessions into global ones.
    if (!parsed.success) throw new Error('Stored session accounts are malformed');
    return parsed.data;
  });

  const store = () => {
    if (loaded === null) loaded = readStore();
    return loaded;
  };

  const persist = (sessions) => serialize(async () => {
    if (filePath === null) return;
    await fsPromises.mkdir(path.dirname(filePath), { recursive: true });
    const tmp = `${filePath}.tmp-${process.pid}-${Date.now()}`;
    try {
      await fsPromises.writeFile(tmp, JSON.stringify({ version: 1, sessions }, null, 2), 'utf8');
      await fsPromises.rename(tmp, filePath);
    } catch (error) {
      await fsPromises.unlink(tmp).catch(() => {});
      throw error;
    }
  });

  return {
    /** The session's pin, or null when it follows the global settings. */
    get: async (sessionID) => {
      const { sessions } = await store();
      return sessions.find((entry) => entry.sessionID === sessionID) ?? null;
    },
    /** Upserts one session's pin; the oldest entries fall off the cap. */
    set: async (input) => {
      const parsed = entrySchema.safeParse({ ...input, updatedAt: now() });
      if (!parsed.success) throw new Error('Invalid session account');
      const entry = parsed.data;
      const { sessions } = await store();
      const kept = sessions.filter((existing) => existing.sessionID !== entry.sessionID);
      kept.push(entry);
      kept.sort((a, b) => b.updatedAt - a.updatedAt);
      const next = { version: 1, sessions: kept.slice(0, MAX_SESSIONS) };
      loaded = Promise.resolve(next);
      await persist(next.sessions);
      return entry;
    },
    /** Removes the session's pin; false when there was none. */
    clear: async (sessionID) => {
      const { sessions } = await store();
      if (!sessions.some((entry) => entry.sessionID === sessionID)) return false;
      const next = { version: 1, sessions: sessions.filter((entry) => entry.sessionID !== sessionID) };
      loaded = Promise.resolve(next);
      await persist(next.sessions);
      return true;
    },
  };
};
