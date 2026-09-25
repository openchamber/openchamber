// The journey of a space as the host drives it: made with its network choice and the project's
// code, listed with its state, started again with its network said again to a gatekeeper that
// forgot it, stopped, removed with everything the host kept for it, its journal read, and its
// work brought out and applied. Everything here is written once on top of the manager, the
// gatekeeper channel, code in and code out; the routes in `routes.js` only translate HTTP.
//
// A creation runs in the background: the request comes back at once with the space's id, and the
// steps are announced as `openchamber:space-progress` events on the host's hub, so the group in
// the sidebar can say what is happening now (DESIGN.md, journey step 2). A creation that fails
// after the containers exist removes them again, and its failure stays listed until the user
// dismisses it, so an error is never silent.

import { z } from 'zod';

import { SpaceError } from './errors.js';
import { createSpaceId, hashProjectDirectory } from './labels.js';
import { spaceProjectPath } from './layout.js';
import { networkSchema } from './space-records.js';

// The four choices of the create dialog, parsed at the boundary. Each field refuses with a code
// of its own, so the dialog can point at the field.
const createRequestSchema = z.object({
  projectDirectory: z.string().min(1),
  name: z.string().trim().min(1),
  start: z.enum(['clean', 'uncommitted']).default('uncommitted'),
  network: networkSchema.default({ mode: 'allowlist', domains: [] }),
});
const CREATE_REFUSALS = {
  projectDirectory: ['project_not_registered', 'A space is made for a project this OpenChamber knows. Add the project first, then create the space.'],
  name: ['invalid_space_name', 'A space needs a name.'],
  start: ['invalid_snapshot_mode', 'A space starts from a clean commit or with the uncommitted changes.'],
  network: ['invalid_network', 'The network of a space is allowlist or open, with a list of domain names for the allowlist.'],
};
const applyRequestSchema = z.discriminatedUnion('as', [
  z.object({ as: z.literal('branch'), branch: z.string(), removeAfterwards: z.boolean().default(false) }),
  z.object({ as: z.literal('changes'), removeAfterwards: z.boolean().default(false) }),
]);

const failureOf = (error) => ({
  code: error instanceof SpaceError ? error.code : 'space_journey_failed',
  message: error?.message ?? String(error),
  details: error instanceof SpaceError ? error.details ?? null : null,
});

/**
 * `listProjectDirectories` answers the host's registered projects; a space is made for one of them
 * and its label carries the project's hash. `announce(spaceId, payload)` enters an event into the
 * host's hub, `onSpacesChanged()` tells the host to read its list again at once.
 */
export function createSpaceJourney({
  manager,
  place,
  gatekeeper,
  codeIn,
  codeOut,
  records,
  listProjectDirectories,
  announce = () => {},
  onSpacesChanged = () => {},
  logger = console,
  now = () => new Date(),
}) {
  // Creations under way or failed, by space id, until they succeed or the user dismisses them.
  const pending = new Map();
  // Spaces with an action under way: start, stop, remove, journal or apply. One at a time per space,
  // so a remove cannot pull the refs from under an apply that is writing them.
  const busy = new Set();
  // Set while the switch is being turned off: no creation may slip in between the stop of the
  // spaces and the moment the feature is gone.
  let closing = false;

  const exclusive = async (spaceId, work) => {
    if (busy.has(spaceId)) throw new SpaceError('space_busy', 'Another action on this space is still running. Wait for it to finish.');
    busy.add(spaceId);
    try {
      return await work();
    } finally {
      busy.delete(spaceId);
    }
  };

  /** Refuses an action on a creation under way, and names a failed one for what it is. */
  const requireNotPending = (spaceId) => {
    const waiting = pending.get(spaceId);
    if (!waiting) return;
    if (waiting.state === 'failed') throw new SpaceError('space_creation_failed', 'Making this space failed. Dismiss it, then create a new one.');
    throw new SpaceError('space_preparing', 'This space is still being made.');
  };

  const registeredProjects = async () => {
    const directories = await listProjectDirectories();
    return new Map(directories.map((directory) => [hashProjectDirectory(directory), directory]));
  };

  const requireRegisteredProject = async (directory) => {
    const projects = await registeredProjects();
    if (projects.get(hashProjectDirectory(directory)) !== directory) {
      throw new SpaceError(...CREATE_REFUSALS.projectDirectory);
    }
    return directory;
  };

  const progress = (entry, step, failure = null) => {
    entry.step = step;
    entry.state = step === 'failed' ? 'failed' : step === 'ready' ? 'running' : 'preparing';
    entry.failure = failure;
    announce(entry.id, { type: 'openchamber:space-progress', properties: { spaceId: entry.id, step, failure, timestamp: now().getTime() } });
  };

  /** Removes the space and everything the host kept for it, and says what did not go. */
  const removeEverything = async (spaceId, repository) => {
    const outcome = { removed: false, refsRemoved: null, failures: [] };
    try {
      await manager.removeSpace({ placeId: place.id, spaceId });
      outcome.removed = true;
    } catch (error) {
      outcome.failures.push(failureOf(error));
    }
    if (repository) {
      try {
        await codeIn.removeSpaceRefs({ repository, spaceId });
        outcome.refsRemoved = true;
      } catch (error) {
        outcome.refsRemoved = false;
        outcome.failures.push(failureOf(error));
      }
    }
    records.remove(spaceId);
    return outcome;
  };

  const sendHistoryInBackground = ({ repository, spaceId, spacePath, base }) => {
    codeIn.sendHistory({ repository, spaceId, spacePath, base })
      .then((result) => { records.update(spaceId, { history: result.status }); })
      .catch((error) => {
        logger.warn?.(`[spaces] the history of space ${spaceId} did not arrive: ${error?.details?.cause ?? error?.code ?? error?.message}`);
        records.update(spaceId, { history: 'failed' });
      });
  };

  const prepare = async (entry, { projectDirectory, name, start, network }) => {
    let created = false;
    try {
      progress(entry, 'checking_place');
      const check = await place.check();
      if (!check.available) throw new SpaceError(check.code, check.message);
      if (network.mode === 'allowlist' && check.hostIsolation !== true) {
        throw new SpaceError('place_cannot_restrict_network', 'This place cannot keep a space away from the machine it runs on, so an allowlist would not hold. Use a newer Docker engine, or choose the open network with that in mind.');
      }
      progress(entry, 'creating');
      await manager.createSpace({ id: entry.id, placeId: place.id, projectDirectory, name });
      created = true;
      records.write(entry.id, { network, repository: projectDirectory });
      progress(entry, 'setting_network');
      await gatekeeper.setNetwork(entry.id, network);
      progress(entry, 'bringing_code');
      const arrived = await codeIn.bringCodeIn({ repository: projectDirectory, spaceId: entry.id, mode: start });
      records.update(entry.id, { spacePath: arrived.spacePath, base: arrived.base });
      entry.identityCopied = arrived.identityCopied;
      pending.delete(entry.id);
      progress(entry, 'ready');
      onSpacesChanged();
      sendHistoryInBackground({ repository: projectDirectory, spaceId: entry.id, spacePath: arrived.spacePath, base: arrived.base });
    } catch (error) {
      const failure = failureOf(error);
      if (created) {
        const cleanup = await removeEverything(entry.id, projectDirectory);
        if (cleanup.failures.length > 0) failure.cleanup = cleanup.failures;
      }
      logger.warn?.(`[spaces] creating space ${entry.id} failed at ${entry.step}: ${failure.code}`);
      progress(entry, 'failed', failure);
    }
  };

  /**
   * Starts making a space and answers at once with the entry the list will carry. The four
   * choices of the create dialog come in: the project, the name, the starting point and the
   * network. The place is checked inside, as decision 19 asks: nothing probes a runtime before
   * the user acts.
   */
  const createSpace = async (request) => {
    if (closing) throw new SpaceError('isolated_spaces_off', 'Isolated spaces are being turned off.');
    const parsed = createRequestSchema.safeParse(request ?? {});
    if (!parsed.success) {
      const [code, message] = CREATE_REFUSALS[parsed.error.issues[0]?.path?.[0]] ?? CREATE_REFUSALS.network;
      throw new SpaceError(code, message);
    }
    const { name, start, network } = parsed.data;
    const projectDirectory = await requireRegisteredProject(parsed.data.projectDirectory);
    const id = createSpaceId();
    const entry = {
      id,
      name,
      placeId: place.id,
      projectDirectory,
      directory: spaceProjectPath(id, projectDirectory),
      created: now().toISOString(),
      state: 'preparing',
      step: 'checking_place',
      failure: null,
      network,
    };
    pending.set(entry.id, entry);
    void prepare(entry, { projectDirectory, name, start, network });
    return describePending(entry);
  };

  const describePending = (entry) => ({
    id: entry.id,
    name: entry.name,
    placeId: entry.placeId,
    projectDirectory: entry.projectDirectory,
    directory: entry.directory,
    created: entry.created,
    state: entry.state,
    step: entry.step,
    failure: entry.failure,
    network: entry.network,
    history: 'pending',
    damaged: false,
    missing: [],
    orphans: [],
  });

  /**
   * Every space of this host: the place's list with what the host remembers about each, the
   * creations under way in their place, and the failed ones after it. A record the host cannot read leaves `network` null,
   * which the UI must show as "unknown" and never as "open".
   */
  const listSpaces = async () => {
    const [spaces, projects] = await Promise.all([manager.listSpaces({ placeId: place.id }), registeredProjects()]);
    const listed = spaces.map((space) => {
      const projectDirectory = projects.get(space.project) ?? null;
      const { record } = records.read(space.id);
      return {
        id: space.id,
        name: space.name,
        placeId: space.placeId,
        projectDirectory,
        directory: projectDirectory === null ? null : spaceProjectPath(space.id, projectDirectory),
        created: space.created,
        state: space.state,
        step: null,
        failure: null,
        network: record?.network ?? null,
        history: record?.history ?? 'unknown',
        damaged: space.damaged,
        missing: space.missing,
        orphans: space.orphans,
      };
    });
    // A creation under way wins over the place's view of it: the containers run before the code is there.
    const waiting = new Map(Array.from(pending.values(), (entry) => [entry.id, describePending(entry)]));
    const merged = listed.map((space) => waiting.get(space.id) ?? space);
    const known = new Set(listed.map((space) => space.id));
    return [...merged, ...Array.from(waiting.values()).filter((entry) => !known.has(entry.id))];
  };

  const requireListed = async (spaceId) => {
    const space = (await listSpaces()).find((entry) => entry.id === spaceId);
    if (!space) throw new SpaceError('space_not_found', `There is no space ${spaceId}`);
    return space;
  };

  /**
   * Starts a stopped space. Its gatekeeper comes up allowing nothing, so the network the user
   * chose is said again from the record; without a readable record the space stays closed, and
   * the answer says so with `networkRestored` false.
   */
  const startSpace = (spaceId) => exclusive(spaceId, async () => {
    // As for a creation: no start may slip in while the switch is stopping the spaces one by one.
    if (closing) throw new SpaceError('isolated_spaces_off', 'Isolated spaces are being turned off.');
    requireNotPending(spaceId);
    await manager.startSpace({ placeId: place.id, spaceId });
    const { record } = records.read(spaceId);
    let networkRestored = false;
    if (record) {
      await gatekeeper.setNetwork(spaceId, record.network);
      networkRestored = true;
      // A history that never arrived, or that failed, is sent again: a stop right after the
      // creation is the usual way it fails, and the space would otherwise stay shallow for good.
      if ((record.history === 'pending' || record.history === 'failed') && record.repository && record.spacePath && record.base) {
        sendHistoryInBackground({ repository: record.repository, spaceId, spacePath: record.spacePath, base: record.base });
      }
    }
    onSpacesChanged();
    return { ...(await requireListed(spaceId)), networkRestored };
  });

  const stopSpace = (spaceId) => exclusive(spaceId, async () => {
    requireNotPending(spaceId);
    await manager.stopSpace({ placeId: place.id, spaceId });
    onSpacesChanged();
    return requireListed(spaceId);
  });

  /**
   * Removes a space and everything the host kept for it: the containers, networks and volumes,
   * the service refs in the user's repository and the record. A failed creation is forgotten here.
   * The chat archive of decision 9 is a later stage; today the sessions go with the space.
   */
  const removeUnlocked = async (spaceId) => {
    const waiting = pending.get(spaceId);
    if (waiting) {
      if (waiting.state !== 'failed') throw new SpaceError('space_preparing', 'This space is still being made. Wait for it, then remove it.');
      pending.delete(spaceId);
      // A failed creation whose clean-up failed still has containers; those go now, or the space
      // comes back in the list as damaged. One that was cleaned up has nothing left to remove.
      const still = (await manager.listSpaces({ placeId: place.id })).some((space) => space.id === spaceId);
      if (!still) return { id: spaceId, removed: true, refsRemoved: null, failures: [] };
      return { id: spaceId, ...(await removeEverything(spaceId, waiting.projectDirectory)) };
    }
    const space = await requireListed(spaceId);
    const { record } = records.read(spaceId);
    const outcome = await removeEverything(spaceId, record?.repository ?? space.projectDirectory);
    onSpacesChanged();
    return { id: spaceId, ...outcome };
  };
  const removeSpace = (spaceId) => exclusive(spaceId, () => removeUnlocked(spaceId));

  /**
   * Stops every running space, for the switch being turned off. Each space is tried on its own:
   * one that could not be stopped is reported as still running, never counted as stopped.
   */
  const stopAllSpaces = async () => {
    const preparing = Array.from(pending.values()).filter((entry) => entry.state === 'preparing');
    if (preparing.length > 0) throw new SpaceError('space_preparing', `${preparing.length === 1 ? 'A space is' : `${preparing.length} spaces are`} still being made. Wait for that to finish first.`, { spaces: preparing.map((entry) => entry.id) });
    closing = true;
    const spaces = await manager.listSpaces({ placeId: place.id });
    const stopped = [];
    const stillRunning = [];
    for (const space of spaces) {
      if (space.state !== 'running') continue;
      try {
        await manager.stopSpace({ placeId: place.id, spaceId: space.id });
        stopped.push({ id: space.id, name: space.name });
      } catch (error) {
        stillRunning.push({ id: space.id, name: space.name, ...failureOf(error) });
      }
    }
    return { stopped, stillRunning };
  };

  /** For a turn-off that did not go through after the spaces were stopped: creations are taken again. */
  const reopen = () => { closing = false; };

  /** What the gatekeeper allowed and refused since it last started; a stopped space has no journal. */
  const readJournal = (spaceId) => exclusive(spaceId, async () => {
    const space = await requireListed(spaceId);
    if (space.state !== 'running') {
      throw new SpaceError('space_not_running', 'The journal lives in the memory of the space\'s gatekeeper and is gone with a stop. Start the space to record new attempts.');
    }
    return gatekeeper.readJournal(spaceId);
  });

  const requireRepository = async (spaceId) => {
    requireNotPending(spaceId);
    const space = await requireListed(spaceId);
    const { record } = records.read(spaceId);
    const repository = record?.repository ?? space.projectDirectory;
    if (!repository) throw new SpaceError('project_not_registered', 'The project this space was made for is no longer registered, so its work has nowhere to go.');
    return { space, repository, spacePath: record?.spacePath ?? space.directory };
  };

  /** Brings the work out and describes what an apply would do, for the apply dialog. */
  const previewApply = (spaceId) => exclusive(spaceId, async () => {
    const { repository, spacePath } = await requireRepository(spaceId);
    const brought = await codeOut.bringCodeOut({ repository, spaceId, spacePath });
    const state = await codeOut.describeApplyState({ repository, spaceId });
    return { ...brought, ...state };
  });

  /**
   * Brings the work out once more and applies it as a branch or as uncommitted changes. What is
   * applied is what this call fetched, whatever a preview showed. With `removeAfterwards` the
   * space goes once the apply went through, and only then.
   */
  const applySpace = (spaceId, request) => exclusive(spaceId, async () => {
    const parsed = applyRequestSchema.safeParse(request ?? {});
    if (!parsed.success) throw new SpaceError('invalid_apply_request', 'The work is applied as a branch, with its name, or as uncommitted changes.');
    const { as, removeAfterwards } = parsed.data;
    const branch = as === 'branch' ? parsed.data.branch : null;
    const { repository, spacePath } = await requireRepository(spaceId);
    const brought = await codeOut.bringCodeOut({ repository, spaceId, spacePath });
    const applied = as === 'branch'
      ? { status: 'applied', ...(await codeOut.applyAsBranch({ repository, spaceId, branch })) }
      : await codeOut.applyAsChanges({ repository, spaceId });
    const removal = removeAfterwards && applied.status === 'applied' ? await removeUnlocked(spaceId) : null;
    return { brought, applied, removal };
  });

  return { createSpace, listSpaces, startSpace, stopSpace, removeSpace, stopAllSpaces, reopen, readJournal, previewApply, applySpace };
}
