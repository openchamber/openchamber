/**
 * Archiving sessions, held by OpenCode since 2.1.
 *
 * Every archive and unarchive goes to OpenCode (`PATCH /api/session/{id}` with
 * `archived`), so the TUI and every other client share one archive. Since 2.2
 * that PATCH writes the record without building the session's location, so it
 * also works for a session whose directory is gone and starts no MCP servers.
 *
 * `archive-store.js` holds entries written before OpenCode could take them:
 * before 2.1, and for sessions of deleted directories before 2.2. An entry
 * wins over OpenCode's record (the proxy folds it in) until it leaves the
 * file: `migrateLegacy` pushes the entries to OpenCode at start, and the
 * user's own archive or restore of a session drops its entry.
 *
 * One operation per session at a time: a migration push decided from an old
 * entry cannot land after the user's own archive or unarchive of that session.
 */

/** PATCHes in flight at once; one batch is a worktree's sessions or a sweep. */
const CONCURRENCY = 6;

const errorTag = (error) => error?._tag;

/** Runs `work` over `items` with at most `limit` in flight; results keep order. */
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
  readArchivedAt: async (sessionID) => {
    try {
      const session = await clientFor().session.get({ sessionID });
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

  /** `'opencode'`, `'unknown-session'` or `'failed'` for one push. */
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

  /**
   * Sets one session's state on OpenCode and drops its file entry. True when
   * both hold. Clients hear the state whenever the file changed, since
   * OpenCode stays silent when its own record already matched.
   */
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

  /**
   * Whether a session is archived: the file's entry when it has one, else
   * OpenCode's record. A session OpenCode cannot be asked about counts as
   * active, the same answer as for one nobody archived.
   */
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

  /**
   * Pushes one legacy entry. It leaves the file when OpenCode took it or no
   * longer knows the session; a failed push keeps it for the next start.
   */
  const migrateEntry = (id) => runForSession(id, async () => {
    // Read again inside the chain: the user may have changed it meanwhile.
    const entry = await store.entry(id);
    if (entry === undefined) return;
    if (await pushToOpenCode(id, entry !== null) === 'failed') return;
    await store.forget([id]);
  });

  /** Pushes the file's entries to OpenCode. Resolves the number left for the next start. */
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
    migrateLegacy,
  };
};
