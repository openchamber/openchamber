/**
 * Archiving sessions, held by OpenCode since 2.1.
 *
 * Every archive and unarchive goes to OpenCode (`PATCH /api/session/{id}` with
 * `archived`), so the TUI and every other client share one archive.
 *
 * OpenCode builds the session's location for that PATCH and answers
 * `LocationNotFoundError` once its directory is gone, which is where every
 * session of a removed worktree ends up. `POST /api/session/{id}/move` still
 * works there, so such a session moves to its project's main folder (the
 * project's `canonical` directory) and is archived there. The transcript gets
 * OpenCode's "moved" note; the worktree is gone, so the session could not run
 * in it anyway.
 *
 * `archive-store.js` holds a session's state while that runs, and for good
 * when the move fails too (the whole project is gone, or the session has no
 * project). An entry in that file wins over OpenCode's record (the proxy folds
 * it in), so it is written before the move when archiving: the session is
 * already archived on screen when OpenCode announces the move, and never
 * flashes in the sidebar under the project. A session OpenCode now holds
 * leaves the file.
 *
 * `migrateLegacy` pushes the file's entries written before 2.1 to OpenCode in
 * one pass. A PATCH starts the session's location with all its MCP servers,
 * so the pass takes one directory at a time and unloads every location it
 * started; the ones running before it stay.
 *
 * One operation per session at a time: a migration push decided from an old
 * entry cannot land after the user's own archive or unarchive of that session.
 */

/** PATCHes in flight at once; one batch is a worktree's sessions or a sweep. */
const CONCURRENCY = 6;

/** OpenCode's project for sessions outside any repository; its folder is no home for a session. */
const GLOBAL_PROJECT_ID = 'global';

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
 * @param {() => string | null | undefined} [options.getDefaultDirectory]
 *   Where the project list is read: a location OpenCode already runs.
 */
export const createOpenCodeSessionArchive = ({ clientFor, getDefaultDirectory = () => null }) => {
  const readSession = async (sessionID) => {
    try {
      return await clientFor().session.get({ sessionID });
    } catch (error) {
      if (errorTag(error) === 'SessionNotFoundError') return undefined;
      throw error;
    }
  };
  return {
    setArchived: (sessionID, archived) => clientFor().session.update({ sessionID, archived }),
    move: (sessionID, directory) => clientFor().session.move({ sessionID, directory }),
    /** Unloads a location, MCP servers included. */
    unload: (directory) => clientFor().debug.location.evict({ location: { directory } }),
    /** Directories of the locations OpenCode runs now. Reading them starts none. */
    listLoadedDirectories: async () => (await clientFor().debug.location.list()).map((location) => location.directory),
    /** `projectID → main folder` for every project OpenCode knows. */
    readProjectFolders: async () => {
      const projects = await clientFor(getDefaultDirectory() || undefined).project.list({ archived: true });
      return new Map(projects.map((project) => [project.id, project.canonical]));
    },
    /** `{ directory, projectID }`, or `undefined` for a session OpenCode does not know. */
    readPlace: async (sessionID) => {
      const session = await readSession(sessionID);
      return session ? { directory: session.location.directory, projectID: session.projectID } : undefined;
    },
    readArchivedAt: async (sessionID) => {
      const session = await readSession(sessionID);
      return session ? session.time?.archived ?? null : undefined;
    },
  };
};

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

  const warnFailure = (action, id, error) => {
    if (errorTag(error) === 'SessionNotFoundError') return;
    console.warn(`[openchamber-sessions] could not ${action} ${id}:`, error?.message ?? error);
  };

  /** `'opencode'`, `'location-gone'`, `'unknown-session'` or `'failed'` for one push. */
  const pushToOpenCode = async (id, archived) => {
    try {
      await openCode.setArchived(id, archived);
      return 'opencode';
    } catch (error) {
      if (errorTag(error) === 'LocationNotFoundError') return 'location-gone';
      if (errorTag(error) === 'SessionNotFoundError') return 'unknown-session';
      warnFailure(archived ? 'archive' : 'unarchive', id, error);
      return 'failed';
    }
  };

  /** Main folders by project, read once per batch that needs one. */
  const projectFoldersLoader = () => {
    let folders = null;
    return async () => {
      folders ??= openCode.readProjectFolders().catch((error) => {
        console.warn('[openchamber-sessions] could not read the project list:', error?.message ?? error);
        return new Map();
      });
      return folders;
    };
  };

  /**
   * Moves a session whose directory is gone to its project's main folder and
   * sets its state there. Resolves the folder it moved to, or null when there
   * is none or a step failed.
   */
  const relocate = async (id, archived, projectFolders) => {
    try {
      const place = await openCode.readPlace(id);
      if (!place || place.projectID === GLOBAL_PROJECT_ID) return null;
      const folder = (await projectFolders()).get(place.projectID);
      if (!folder || folder === place.directory) return null;
      await openCode.move(id, folder);
      await openCode.setArchived(id, archived);
      return folder;
    } catch (error) {
      if (errorTag(error) !== 'LocationNotFoundError') warnFailure('move', id, error);
      return null;
    }
  };

  /**
   * Sets one session's state. True when it holds, on OpenCode or in the file.
   * Clients hear the state whenever the file changed, since OpenCode stays
   * silent when its own record already matched.
   */
  const apply = (id, archivedAt, projectFolders) => runForSession(id, async () => {
    const archived = archivedAt !== null;
    const outcome = await pushToOpenCode(id, archived);
    if (outcome === 'failed' || outcome === 'unknown-session') return false;
    if (outcome === 'opencode') {
      const hadEntry = (await store.entry(id)) !== undefined;
      const { failedIds } = await store.forget([id]);
      if (failedIds.length > 0) return false;
      if (hadEntry) announce(id, archivedAt);
      return true;
    }
    if (archived) {
      // Archived on screen first, so the move OpenCode announces happens inside the archive.
      const { failedIds } = await store.archive([id], archivedAt);
      if (failedIds.length > 0) return false;
      announce(id, archivedAt);
      if (await relocate(id, true, projectFolders)) await store.forget([id]);
      return true;
    }
    if (await relocate(id, false, projectFolders)) {
      const { failedIds } = await store.forget([id]);
      if (failedIds.length > 0) return false;
      announce(id, null);
      return true;
    }
    const { failedIds } = await store.unarchive([id]);
    if (failedIds.length > 0) return false;
    announce(id, null);
    return true;
  });

  const applyBatch = async (ids, archivedAt) => {
    const projectFolders = projectFoldersLoader();
    const held = await mapLimited(ids, CONCURRENCY, (id) => apply(id, archivedAt, projectFolders));
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
   * Pushes one legacy entry: `'took'`, `'location-gone'` when its directory is
   * gone, or `'kept'`. The entry leaves the file when OpenCode took it or no
   * longer knows the session.
   */
  const migrateEntry = (id) => runForSession(id, async () => {
    // Read again inside the chain: the user may have changed it meanwhile.
    const entry = await store.entry(id);
    if (entry === undefined) return 'kept';
    const outcome = await pushToOpenCode(id, entry !== null);
    if (outcome === 'location-gone' || outcome === 'failed') return outcome === 'failed' ? 'kept' : outcome;
    await store.forget([id]);
    return outcome === 'opencode' ? 'took' : 'kept';
  });

  /** Moves one legacy entry out of a deleted directory; resolves the folder it went to, or null. */
  const migrateGoneEntry = (id, projectFolders) => runForSession(id, async () => {
    const entry = await store.entry(id);
    if (entry === undefined) return null;
    const folder = await relocate(id, entry !== null, projectFolders);
    if (folder) await store.forget([id]);
    return folder;
  });

  /**
   * Pushes the file's entries to OpenCode, moving sessions of deleted
   * directories to their project's main folder, and unloads every location
   * the pass started. Resolves the number of entries left: sessions with no
   * folder to move to, and failures the next start retries.
   */
  const migrateLegacy = async () => {
    const pending = Object.keys(await store.getAll());
    if (pending.length === 0) return 0;
    const loaded = new Set(await openCode.listLoadedDirectories());
    const unloadIfStarted = (directory) => (loaded.has(directory)
      ? Promise.resolve()
      : openCode.unload(directory).catch((error) => {
        console.warn(`[openchamber-sessions] could not unload ${directory} after the archive migration:`, error?.message ?? error);
      }));

    const byDirectory = new Map();
    await mapLimited(pending, CONCURRENCY, async (id) => {
      let place;
      try {
        place = await openCode.readPlace(id);
      } catch (error) {
        warnFailure('read the directory of', id, error);
        return;
      }
      // A session OpenCode does not know has nothing to archive.
      if (place === undefined) {
        await runForSession(id, () => store.forget([id]));
        return;
      }
      if (!byDirectory.has(place.directory)) byDirectory.set(place.directory, []);
      byDirectory.get(place.directory).push(id);
    });

    const gone = [];
    for (const [directory, ids] of byDirectory) {
      const outcomes = await mapLimited(ids, CONCURRENCY, migrateEntry);
      gone.push(...ids.filter((_, index) => outcomes[index] === 'location-gone'));
      if (outcomes.includes('took')) await unloadIfStarted(directory);
    }

    // Sessions of deleted directories land in their projects' main folders, one at a time.
    const projectFolders = projectFoldersLoader();
    const landed = new Set();
    for (const id of gone) {
      const folder = await migrateGoneEntry(id, projectFolders);
      if (folder) landed.add(folder);
    }
    for (const folder of landed) await unloadIfStarted(folder);

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
