// What the host server builds when the isolated-spaces switch is on, and nothing of it when it
// is off: the place, the manager, the dispatcher, the WebSocket forwarder, the session index
// with the event connection of every space, and the hooks the rest of the server takes.
//
// `server/index.js` reads the switch at start and changes it live through the switch route.
// While it is off this module is never imported for its effect: no place, no manager, no
// route, no `docker`.

import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';

import { z } from 'zod';

import { createCodeIn } from './code-in.js';
import { createCodeOut } from './code-out.js';
import { createSpaceDispatcher } from './dispatcher.js';
import { createGatekeeperChannel } from './gatekeeper-channel.js';
import { createHostGit } from './host-git.js';
import { createSpaceJourney } from './journey.js';
import { hashProjectDirectory } from './labels.js';
import { spaceProjectPath } from './layout.js';
import { createSpaceManager } from './manager.js';
import { createSpaceRecords } from './space-records.js';
import { createSpaceEventSources } from './space-events.js';
import { createSpaceSessionIndex, mergeSessionLists } from './space-sessions.js';
import { createSpaceWebSocketForwarder } from './websocket.js';
import { createDockerPlace } from './places/docker.js';
import { createPlaceRegistry } from './places/registry.js';
import { openCommandStream as openCommandStreamProcess, runCommand as runCommandProcess } from './run-command.js';
import { createSpaceServerChannel } from './space-server.js';
import { createRegistryToolsSource, readHostToolVersions } from './tools.js';

const OWNER_FILE = path.join('spaces', 'owner');

// How often the host reads its list of spaces to follow their event streams, and how long a
// read serves the merged session list before it is repeated.
const FOLLOW_INTERVAL_MS = 15_000;
const LIST_TTL_MS = 2_000;
// A space's session list is read in pages; more than this many is reported as partial.
const SESSION_PAGE_LIMIT = 100;
const SESSION_MAX_PAGES = 10;
const SESSION_LIST_TIMEOUT_MS = 10_000;
const MAX_SESSION_LIST_BYTES = 8 * 1024 * 1024;
// The cursor of a next page, as the server inside names it; anything else ends the read.
const nextCursorSchema = z.string().min(1);

/**
 * The installation id that labels this host's spaces, so two installations that share a Docker
 * daemon never see each other's. Made once, at the first start with the switch on, and kept in
 * the data directory. It is a random token and names nothing about the machine.
 */
export function readOrCreateOwner(dataDir) {
  const file = path.join(dataDir, OWNER_FILE);
  try {
    const existing = fs.readFileSync(file, 'utf8').trim();
    if (/^[a-z0-9]{16,64}$/.test(existing)) return existing;
  } catch {
    // Made below.
  }
  const owner = crypto.randomBytes(12).toString('hex');
  fs.mkdirSync(path.dirname(file), { recursive: true, mode: 0o700 });
  fs.writeFileSync(file, `${owner}\n`, { encoding: 'utf8', mode: 0o600 });
  return owner;
}

/**
 * `dataDir` is the host's data directory, `dockerPath` the docker CLI to run and `gitPath` the
 * host git that moves code in and out, with `hostEnvironment` as its environment: git starts
 * `docker exec` itself, so the PATH in it must find docker. `place` replaces the Docker place,
 * for the tests; `runCommand` and `openCommandStream` are the two ways this module starts a
 * process, injectable for the same reason. `listProjectDirectories` answers the host's registered
 * project paths, so a space's project label can be resolved to the project it was made for;
 * without it every space is marked as of an unknown project.
 */
export function createSpacesHost({
  dataDir,
  dockerPath = 'docker',
  gitPath = 'git',
  hostEnvironment = process.env,
  listProjectDirectories = async () => [],
  runCommand = runCommandProcess,
  openCommandStream = openCommandStreamProcess,
  place = null,
  logger = console,
  now = Date.now,
  setTimer = setInterval,
  clearTimer = clearInterval,
}) {
  const dockerPlace = place ?? createDockerPlace({
    runCommand,
    openCommandStream,
    dockerPath,
    owner: readOrCreateOwner(dataDir),
    toolsSource: createRegistryToolsSource(readHostToolVersions()),
  });
  const registry = createPlaceRegistry([dockerPlace]);
  registry.seal();
  const manager = createSpaceManager({ registry });
  const serverInside = createSpaceServerChannel({ exec: dockerPlace.exec });
  const gatekeeper = createGatekeeperChannel({ exec: dockerPlace.exec });
  const git = createHostGit({ runCommand, gitPath, environment: hostEnvironment });
  const codeIn = createCodeIn({ git, place: dockerPlace });
  const codeOut = createCodeOut({ git, place: dockerPlace });
  const records = createSpaceRecords({ dataDir, logger });

  const listSpaces = () => manager.listSpaces({ placeId: dockerPlace.id });
  const dispatcher = createSpaceDispatcher({
    logger,
    transport: {
      listSpaceIds: async () => (await listSpaces()).map((space) => space.id),
      connect: (spaceId) => dockerPlace.connect(spaceId),
      readToken: (spaceId) => serverInside.readToken(spaceId),
    },
  });

  const index = createSpaceSessionIndex({ logger });
  let events = null;
  let unsubscribeHostEvents = null;
  let followTimer = null;
  let known = { spaces: [], readAt: -Infinity };
  let listing = null;
  // When each space's session list was last read; within the TTL the accepted list is served again.
  const listReadAt = new Map();

  /**
   * Which registered project a space was made for, by the label's hash of the project path. A
   * failed read of the projects, or a project since removed, leaves the space with no project.
   */
  const resolveProjects = async (spaces) => {
    if (spaces.length === 0) return new Map();
    let directories = [];
    try {
      directories = await listProjectDirectories();
    } catch (error) {
      logger.warn?.(`[spaces] could not read the projects: ${error?.code ?? error?.message ?? error}`);
    }
    const byHash = new Map(directories.map((directory) => [hashProjectDirectory(directory), directory]));
    return new Map(spaces.map((space) => [space.id, byHash.get(space.project) ?? null]));
  };

  /**
   * This host's spaces, each with its name and the project it was made for, read again when
   * older than the TTL. A failed read keeps the last ones.
   */
  const knownSpaces = async () => {
    if (now() - known.readAt < LIST_TTL_MS) return known.spaces;
    if (!listing) {
      listing = listSpaces()
        .then(async (spaces) => {
          const projects = await resolveProjects(spaces);
          known = {
            spaces: spaces.map((space) => {
              const projectDirectory = projects.get(space.id) ?? null;
              return {
                id: space.id,
                name: space.name,
                projectDirectory,
                directory: projectDirectory === null ? null : spaceProjectPath(space.id, projectDirectory),
              };
            }),
            readAt: now(),
          };
        })
        .catch((error) => { logger.warn?.(`[spaces] could not list the spaces: ${error?.code ?? error?.message ?? error}`); })
        .finally(() => { listing = null; });
    }
    await listing;
    return known.spaces;
  };
  const spaceIds = async () => (await knownSpaces()).map((space) => space.id);

  const follow = async () => {
    const ids = await spaceIds();
    events?.sync(ids);
  };
  /** The list is read again at once, and the event connections follow it: for a space just made or removed. */
  const refresh = () => {
    known = { spaces: known.spaces, readAt: -Infinity };
    return follow();
  };

  let hub = null;
  const journey = createSpaceJourney({
    manager,
    place: dockerPlace,
    gatekeeper,
    codeIn,
    codeOut,
    records,
    listProjectDirectories,
    announce: (spaceId, payload) => { hub?.injectEvent({ payload, directory: 'global', spaceId }); },
    onSpacesChanged: () => { void refresh().catch(() => {}); },
    logger,
  });

  const readBody = (response, cap) => new Promise((resolve, reject) => {
    const chunks = [];
    let size = 0;
    response.on('data', (chunk) => {
      size += chunk.length;
      if (size > cap) { response.destroy(); reject(new Error(`the list exceeds ${cap} bytes`)); return; }
      chunks.push(chunk);
    });
    response.on('end', () => resolve(Buffer.concat(chunks).toString('utf8')));
    response.on('error', reject);
  });

  /** One space's whole session list, page by page, or as much of it as the page cap allows. */
  const readSpaceSessions = async (spaceId) => {
    const records = [];
    let cursor = null;
    for (let page = 0; page < SESSION_MAX_PAGES; page += 1) {
      const query = new URLSearchParams({ limit: String(SESSION_PAGE_LIMIT) });
      if (cursor !== null) query.set('cursor', cursor);
      const response = await dispatcher.requestInside(spaceId, { path: `/api/session?${query}`, headers: { accept: 'application/json' }, timeoutMs: SESSION_LIST_TIMEOUT_MS });
      if (response.statusCode !== 200) { response.resume(); throw new Error(`status ${response.statusCode}`); }
      const payload = JSON.parse(await readBody(response, MAX_SESSION_LIST_BYTES));
      const data = Array.isArray(payload) ? payload : payload?.data;
      if (!Array.isArray(data)) throw new Error('the list is not a list');
      records.push(...data);
      const next = nextCursorSchema.safeParse(payload?.cursor?.next);
      if (!next.success || data.length === 0) return { records, complete: true };
      cursor = next.data;
    }
    return { records, complete: false };
  };

  /**
   * The host's session list with every space's after it. Each reachable space is asked once,
   * all of them at the same time; one that does not answer keeps its last known list, marked
   * stale. A host list without spaces goes back exactly as it came.
   */
  const mergeSessionList = async (hostPayload) => {
    const hostRecords = Array.isArray(hostPayload) ? hostPayload : hostPayload?.data;
    if (Array.isArray(hostRecords)) index.observeHostRecords(hostRecords);
    const spaces = await knownSpaces();
    if (spaces.length === 0) return hostPayload;
    await Promise.all(spaces.map(async ({ id: spaceId }) => {
      if (now() - (listReadAt.get(spaceId) ?? -Infinity) < LIST_TTL_MS) return;
      try {
        const { records, complete } = await readSpaceSessions(spaceId);
        index.acceptSpaceList(spaceId, records, { complete });
        listReadAt.set(spaceId, now());
      } catch (error) {
        logger.warn?.(`[spaces] the session list of space ${spaceId} did not come: ${error?.code ?? error?.message ?? error}`);
        index.markUnreachable(spaceId);
      }
    }));
    // In the place's order, so the merged list reads the same from one call to the next.
    const answers = new Map(index.snapshot().map((entry) => [entry.spaceId, entry]));
    return mergeSessionLists(hostPayload, spaces.flatMap((space) => {
      const answer = answers.get(space.id);
      return answer === undefined ? [] : [{ ...answer, name: space.name, projectDirectory: space.projectDirectory, directory: space.directory }];
    }));
  };

  let sockets = null;

  return {
    manager,
    dispatcher,
    index,
    journey,
    /** The places a space can be made on, for the funnel. */
    places: () => registry.list(),
    /** The dispatcher, to mount after the API auth gate and before every route that reads a directory. */
    middleware: dispatcher.middleware,
    /**
     * Makes the WebSocket forwarder, with the host's own auth and origin checks. `upgradeHandler`
     * then takes the upgrades under the prefix, and nothing before this call.
     */
    prepareUpgrades: ({ uiAuthController, isRequestOriginAllowed }) => {
      sockets = createSpaceWebSocketForwarder({ dispatcher, connect: (spaceId) => dockerPlace.connect(spaceId), uiAuthController, isRequestOriginAllowed, logger });
    },
    upgradeHandler: (...args) => sockets?.upgradeHandler(...args),
    /** Follows the spaces: an event connection for each, into the host's hub, and the host's own ids from its events. */
    startEvents: (globalEventHub) => {
      hub = globalEventHub;
      events = createSpaceEventSources({ requestInside: dispatcher.requestInside, index, hub: globalEventHub, logger, now });
      unsubscribeHostEvents = globalEventHub.subscribeEvent((event) => { if (event.spaceId === null) index.observeHostEvent(event.payload); });
      followTimer = setTimer(() => { void follow(); }, FOLLOW_INTERVAL_MS);
      followTimer?.unref?.();
      return follow();
    },
    /** For the proxy: the merged session list, or the host's own when no space exists. */
    mergeSessionList,
    /** For the body parsers: a request to a space keeps its body for the space. */
    skipsBodyParsing: (req) => dispatcher.isSpaceRequestPath(req.path),
    /** For the directory gate: the reason a directory is refused on the host, or null. */
    refuseDirectory: (candidate) => (dispatcher.isSpaceDirectory(candidate)
      ? 'A directory under /spaces/ belongs to an isolated space and is addressed as /api/spaces/<id>/... only'
      : null),
    close: () => {
      if (followTimer !== null) clearTimer(followTimer);
      followTimer = null;
      unsubscribeHostEvents?.();
      unsubscribeHostEvents = null;
      events?.close();
      sockets?.close();
      dispatcher.close();
    },
  };
}
