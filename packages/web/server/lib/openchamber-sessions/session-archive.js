// external: https://www.npmjs.com/package/@opencode/client/v/2.3.0 Archive PATCH works without building the location, including when its directory is gone.

const CONCURRENCY = 6;

const errorTag = (error) => error?._tag;

const mapLimited = async (items, limit, work) => {
  const results = new Array(items.length);
  let next = 0;
  const lane = async () => {
    while (next < items.length) {
      const index = next;
      next += 1;
      results[index] = await work(items[index]);
    }
  };
  await Promise.all(Array.from({ length: Math.min(limit, items.length) }, lane));
  return results;
};

/**
 * Archive state on OpenCode. Calls throw OpenCode's tagged errors; reads of a
 * session OpenCode does not know resolve `undefined`.
 *
 * @param {object} options
 * @param {(directory?: string) => any} options.clientFor
 */
export const createOpenCodeSessionArchive = ({ clientFor }) => ({
  setArchived: (sessionID, archived) => clientFor().session.update({ sessionID, archived }),
  readArchivedAt: async (sessionID, { signal } = {}) => {
    try {
      const session = await clientFor().session.get({ sessionID }, { signal });
      return session.time?.archived ?? null;
    } catch (error) {
      if (errorTag(error) === 'SessionNotFoundError') return undefined;
      throw error;
    }
  },
});

/**
 * @param {object} options
 * @param {ReturnType<typeof import('./archive-store.js').createArchiveStore>} options.store
 * @param {ReturnType<typeof createOpenCodeSessionArchive>} options.openCode
 * @param {(sessionID: string, archivedAt: number | null) => void} [options.announce]
 *   Tells clients a session's state when OpenCode may not: it announces only
 *   changes of its own record.
 */
export const createSessionArchive = ({ store, openCode, announce = () => {} }) => {
  const sessionChains = new Map();
  const runForSession = (id, work) => {
    const previous = sessionChains.get(id) ?? Promise.resolve();
    const next = previous.then(work, work);
    const settled = next.then(() => undefined, () => undefined);
    sessionChains.set(id, settled);
    void settled.then(() => {
      if (sessionChains.get(id) === settled) sessionChains.delete(id);
    });
    return next;
  };

  const pushToOpenCode = async (id, archived) => {
    try {
      await openCode.setArchived(id, archived);
      return 'opencode';
    } catch (error) {
      if (errorTag(error) === 'SessionNotFoundError') return 'unknown-session';
      console.warn(`[openchamber-sessions] could not ${archived ? 'archive' : 'unarchive'} ${id}:`, error?.message ?? error);
      return 'failed';
    }
  };

  // external: https://www.npmjs.com/package/@opencode/client/v/2.3.0 OpenCode emits no state change when its archive record already matches.
  const apply = (id, archivedAt) => runForSession(id, async () => {
    if (await pushToOpenCode(id, archivedAt !== null) !== 'opencode') return false;
    const hadEntry = (await store.entry(id)) !== undefined;
    const { failedIds } = await store.forget([id]);
    if (failedIds.length > 0) return false;
    if (hadEntry) announce(id, archivedAt);
    return true;
  });

  const applyBatch = async (ids, archivedAt) => {
    const held = await mapLimited(ids, CONCURRENCY, (id) => apply(id, archivedAt));
    return {
      applied: ids.filter((_, index) => held[index]),
      failedIds: ids.filter((_, index) => !held[index]),
    };
  };

  const archivedAt = async (sessionID) => {
    const entry = await store.entry(sessionID);
    if (entry !== undefined) return entry;
    try {
      return (await openCode.readArchivedAt(sessionID)) ?? null;
    } catch (error) {
      console.warn(`[openchamber-sessions] could not read the archive state of ${sessionID}:`, error?.message ?? error);
      return null;
    }
  };

  const archiveState = async (sessionID, { signal } = {}) => {
    try {
      const entry = await store.entry(sessionID);
      const at = entry !== undefined ? entry : await openCode.readArchivedAt(sessionID, { signal });
      return Number.isFinite(at) ? 'archived' : 'active';
    } catch {
      return 'unknown';
    }
  };

  const migrateEntry = (id) => runForSession(id, async () => {
    const entry = await store.entry(id);
    if (entry === undefined) return;
    if (await pushToOpenCode(id, entry !== null) === 'failed') return;
    await store.forget([id]);
  });

  const migrateLegacy = async () => {
    const pending = Object.keys(await store.getAll());
    if (pending.length === 0) return 0;
    await mapLimited(pending, CONCURRENCY, migrateEntry);
    return Object.keys(await store.getAll()).length;
  };

  return {
    archive: async (ids, stamp) => {
      const { applied, failedIds } = await applyBatch(ids, stamp);
      return { archived: applied.map((id) => ({ id, archivedAt: stamp })), failedIds };
    },
    unarchive: async (ids) => {
      const { applied, failedIds } = await applyBatch(ids, null);
      return { restored: applied.map((id) => ({ id, archivedAt: null })), failedIds };
    },
    archivedAt,
    isArchived: async (sessionID) => typeof (await archivedAt(sessionID)) === 'number',
    archiveState,
    migrateLegacy,
  };
};
