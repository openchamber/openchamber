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

import { getProviderAuth, getStoredLogin, renewStoredLogin } from '../opencode/auth.js';
import { createCodeIn } from './code-in.js';
import { createCodeOut } from './code-out.js';
import { createSpaceDispatcher } from './dispatcher.js';
import { SpaceError } from './errors.js';
import { createGatekeeperChannel } from './gatekeeper-channel.js';
import { createHostGit } from './host-git.js';
import { createHostProviders } from './host-providers.js';
import { createSpaceJourney } from './journey.js';
import { KEEP_INTERVAL_MS, createLoginExchange, createLoginKeeper } from './login-keeper.js';
import { hashProjectDirectory } from './labels.js';
import { spaceProjectPath } from './layout.js';
import { createSpaceManager } from './manager.js';
import { createSpaceRecords } from './space-records.js';
import { createSpaceEventSources } from './space-events.js';
import { createSpaceFetch } from './space-fetch.js';
import { createSpaceOpenCode } from './space-opencode.js';
import { createSpaceSessionIndex, mergeSessionLists } from './space-sessions.js';
import { createSpaceWebSocketForwarder } from './websocket.js';
import { DOCKER_SSH_PLACE_ID, createDockerPlace } from './places/docker.js';
import { createDockerSetup } from './places/docker-setup.js';
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
// The server inside restarts its OpenCode and answers once it is ready again, which on a slow
// machine takes a while; past this the restart is reported as not answered.
const RESTART_OPENCODE_TIMEOUT_MS = 180_000;
const MAX_RESTART_ANSWER_BYTES = 64 * 1024;
// A managed OpenCode that restarted; an external one answers `success` with no restart at all.
const restartedSchema = z.object({ success: z.literal(true), requiresReload: z.literal(true) });
// The cursor of a next page, as the server inside names it; anything else ends the read.
const nextCursorSchema = z.string().min(1);

// A body from inside, read up to a cap and never past it.
const readBody = (response, cap) => new Promise((resolve, reject) => {
  const chunks = [];
  let size = 0;
  response.on('data', (chunk) => {
    size += chunk.length;
    if (size > cap) { response.destroy(); reject(new Error(`the answer exceeds ${cap} bytes`)); return; }
    chunks.push(chunk);
  });
  response.on('end', () => resolve(Buffer.concat(chunks).toString('utf8')));
  response.on('error', reject);
});

/**
 * Asks the server inside a space to restart the OpenCode it manages, the route its own settings
 * use for that, over the dispatcher's `requestInside`. The answer comes from inside and is
 * data: anything but a 200 that says OpenCode was restarted is a failure, and its text never
 * travels further than a code.
 */
export const restartOpenCodeInside = async (requestInside, spaceId) => {
  const response = await requestInside(spaceId, {
    method: 'POST',
    path: '/api/config/reload',
    headers: { accept: 'application/json', 'content-length': '0' },
    timeoutMs: RESTART_OPENCODE_TIMEOUT_MS,
  });
  let succeeded = false;
  try {
    succeeded = response.statusCode === 200 && restartedSchema.safeParse(JSON.parse(await readBody(response, MAX_RESTART_ANSWER_BYTES))).success;
  } catch {
    succeeded = false;
  } finally {
    response.destroy();
  }
  if (!succeeded) throw new SpaceError('opencode_restart_failed', `OpenCode inside the space did not restart (status ${response.statusCode}).`);
};

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
 * `dataDir` is the host's data directory, `dockerPath` the docker CLI to run, `colimaPath` the
 * colima CLI or null, used only after a disk clean-up on a Colima machine, `findProgram(name)`
 * the path of a program on this computer or null, asked again at every look of the Docker setup
 * (`places/docker-setup.js`), `sshDockerHost` the
 * `ssh://<machine>` of the Docker over SSH place or null for none, and `gitPath` the
 * host git that moves code in and out, with `hostEnvironment` as its environment: git starts
 * `docker exec` itself, so the PATH in it must find docker. `place` replaces the Docker place,
 * for the tests; `runCommand` and `openCommandStream` are the two ways this module starts a
 * process, injectable for the same reason. `listProjectDirectories` answers the host's registered
 * project paths, so a space's project label can be resolved to the project it was made for;
 * without it every space is marked as of an unknown project. `readIdleStop` and `saveIdleStop`
 * read and keep the user's idle stop setting in the host's settings. `archive` is the chat archive
 * of `space-archive.js`, which a delete saves the space's chats to; without it they go with it.
 * `readHostLogin(provider)` reads the host's own browser login for a provider from the host's
 * OpenCode, for a login grant, and `renewHostLogin(provider, exchange)` replaces it with the one
 * the issuer gives for its refresh token; the tests give a login of their own, and `loginWindowOf`
 * lets the live test point that grant's upstream at its stand-in. `hostProviders` reads the
 * providers the user defined in the host's OpenCode configuration, `host-providers.js` over the
 * host's configuration and OpenCode's stored keys unless a test gives its own. `userAgent` names
 * this OpenChamber to the issuer.
 */
export function createSpacesHost({
  dataDir,
  dockerPath = 'docker',
  colimaPath = null,
  findProgram = () => null,
  sshDockerHost = null,
  gitPath = 'git',
  hostEnvironment = process.env,
  listProjectDirectories = async () => [],
  readIdleStop,
  saveIdleStop,
  archive = null,
  readHostLogin = getStoredLogin,
  renewHostLogin = renewStoredLogin,
  loginWindowOf = undefined,
  hostProviders = null,
  userAgent = 'OpenChamber',
  runCommand = runCommandProcess,
  openCommandStream = openCommandStreamProcess,
  place = null,
  logger = console,
  now = Date.now,
  setTimer = setInterval,
  clearTimer = clearInterval,
}) {
  const owner = readOrCreateOwner(dataDir);
  const toolsSource = createRegistryToolsSource(readHostToolVersions());
  const dockerPlace = place ?? createDockerPlace({ runCommand, openCommandStream, dockerPath, colimaPath, owner, toolsSource });
  // The same Docker place on another machine's daemon: the local CLI runs every command there
  // over SSH, so the image, the tools volume and the spaces' volumes live on that machine.
  const sshPlace = sshDockerHost === null ? null : createDockerPlace({ runCommand, openCommandStream, dockerPath, dockerHost: sshDockerHost, id: DOCKER_SSH_PLACE_ID, owner, toolsSource });
  // Getting Docker ready on this computer, for the local place only.
  const dockerSetup = createDockerSetup({ runCommand, findProgram, dockerPath, environment: hostEnvironment, check: () => dockerPlace.check(), logger });
  const registry = createPlaceRegistry(sshPlace ? [dockerPlace, sshPlace] : [dockerPlace]);
  registry.seal();
  const records = createSpaceRecords({ dataDir, logger });
  // A space's operations go to the place its record names; the records also list the spaces of a
  // place that cannot be asked, by name and time, so the user still sees them.
  const manager = createSpaceManager({
    registry,
    locate: async (spaceId) => records.read(spaceId).record?.placeId ?? null,
    recall: async () => records.list()
      .map(({ id, record }) => ({ placeId: record.placeId, id, name: record.name ?? id, project: record.repository === null ? '' : hashProjectDirectory(record.repository), created: record.created ?? '' })),
  });
  const serverInside = createSpaceServerChannel({ exec: manager.exec });
  const gatekeeper = createGatekeeperChannel({ exec: manager.exec });
  const git = createHostGit({ runCommand, gitPath, environment: hostEnvironment });
  const codeIn = createCodeIn({ git, place: manager });
  const codeOut = createCodeOut({ git, place: manager });

  const listSpaces = async () => (await manager.listAllSpaces()).spaces;
  /** The spaces whose place cannot be asked right now, from the last list; nothing is asked of them. */
  const unreachableIds = async () => new Set((await knownSpaces()).filter((space) => space.state === 'unreachable').map((space) => space.id));
  // A space on a place that cannot be asked is refused here, at once, for the connection and for
  // the token read before it: the place's own attempt would wait on the connection to a machine
  // that is off, once per request.
  const requireReachable = async (spaceId) => {
    if ((await unreachableIds()).has(spaceId)) throw new SpaceError('place_unreachable', 'The machine this space runs on cannot be reached.');
  };
  const connectReachable = async (spaceId) => {
    await requireReachable(spaceId);
    return manager.connect(spaceId);
  };
  const dispatcher = createSpaceDispatcher({
    logger,
    transport: {
      // A miss is an answer only when every configured place answered. A place the settings no
      // longer name is not one of them: nothing here reaches a space on it either way.
      listSpaceIds: async () => {
        const { spaces, unavailable } = await manager.listAllSpaces();
        const failure = unavailable.find(({ placeId }) => registry.get(placeId))?.failure ?? null;
        return { ids: spaces.map((space) => space.id), failure };
      },
      connect: connectReachable,
      readToken: async (spaceId) => {
        await requireReachable(spaceId);
        return serverInside.readToken(spaceId);
      },
    },
  });

  const spaceOpenCode = createSpaceOpenCode({ exec: manager.exec, requestInside: dispatcher.requestInside });

  const index = createSpaceSessionIndex({ logger });
  let events = null;
  let unsubscribeHostEvents = null;
  let followTimer = null;
  let keepTimer = null;
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
                state: space.state,
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
    events?.sync(ids, { paused: await unreachableIds() });
  };
  /** The list is read again at once, and the event connections follow it: for a space just made or removed. */
  const refresh = () => {
    known = { spaces: known.spaces, readAt: -Infinity };
    return follow();
  };

  let hub = null;
  // The host's login, kept fresh for the running spaces that hold it; the journey reads the
  // login through it, so a grant and a start renew a login about to end before saying it.
  const keeper = createLoginKeeper({
    readLogin: readHostLogin,
    renewLogin: renewHostLogin,
    exchange: createLoginExchange({ userAgent }),
    holders: async () => {
      const holding = [];
      for (const space of await knownSpaces()) {
        if (space.state !== 'running') continue;
        for (const grant of records.read(space.id).record?.grants ?? []) if (grant.kind === 'login') holding.push({ spaceId: space.id, grant });
      }
      return holding;
    },
    say: (spaceId, grant, login) => journey.sayLogin(spaceId, grant, login),
    now,
    logger,
  });
  const journey = createSpaceJourney({
    manager,
    places: registry,
    gatekeeper,
    codeIn,
    codeOut,
    records,
    spaceOpenCode,
    serverInside,
    restartOpenCodeInside: (spaceId) => restartOpenCodeInside(dispatcher.requestInside, spaceId),
    listProjectDirectories,
    archiveChats: archive ? ({ spaceId, name, projectDirectory, running, allowUnsaved }) => archive.saveChats({
      spaceId,
      name,
      projectDirectory,
      allowUnsaved,
      source: {
        // The space's own list, read whole; a stopped space that did not start has none to give.
        listChats: async () => {
          if (!running) throw new SpaceError('space_not_running', 'The space is not running');
          const { records: chats, complete } = await readSpaceSessions(spaceId);
          return { chats: chats.map((chat) => ({ id: chat?.id, title: chat?.title })), complete };
        },
        exportChat: (chatId) => spaceOpenCode.exportChat(spaceId, chatId),
      },
    }) : null,
    // A key named by an environment variable is read from the host's own environment, now, and
    // its value is kept nowhere (decision 5).
    readHostSecret: (name) => hostEnvironment[name],
    readHostLogin: keeper.fresh,
    loginWindowOf,
    // A custom provider's key is OpenCode's stored one, else the variable its entry names, read now and kept nowhere.
    hostProviders: hostProviders ?? createHostProviders({ readStoredKey: async (providerId) => (await getProviderAuth(providerId))?.key ?? null, hostEnvironment }),
    readIdleStop,
    saveIdleStop,
    announce: (spaceId, payload) => { hub?.injectEvent({ payload, directory: 'global', spaceId }); },
    onSpacesChanged: () => { void refresh().catch(() => {}); },
    logger,
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
    await Promise.all(spaces.map(async ({ id: spaceId, state }) => {
      // A space whose place cannot be asked keeps its last list, stale, with no attempt made.
      if (state === 'unreachable') {
        index.markUnreachable(spaceId);
        listReadAt.delete(spaceId);
        return;
      }
      if (now() - (listReadAt.get(spaceId) ?? -Infinity) < LIST_TTL_MS) return;
      try {
        const { records, complete } = await readSpaceSessions(spaceId);
        index.acceptSpaceList(spaceId, records, { complete });
        listReadAt.set(spaceId, now());
      } catch (error) {
        logger.warn?.(`[spaces] the session list of space ${spaceId} did not come: ${error?.code ?? error?.message ?? error}`);
        index.markUnreachable(spaceId);
        // The next merge asks the space again whatever the last good read's age: a space that
        // did not answer during its own restart is otherwise listed as not answering until the
        // read's time runs out, after the restart has long gone through.
        listReadAt.delete(spaceId);
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
    /** A `fetch` for the host's own reads of one space's sessions, for its notifications. */
    openCodeFetchFor: createSpaceFetch({ requestInside: dispatcher.requestInside }),
    /** The places a space can be made on, for the funnel. */
    places: () => registry.list(),
    /** What gets Docker going on this computer, and the action that does it, for the local place. */
    dockerSetup,
    /** The id of the place that `dockerSetup` is about. */
    localPlaceId: dockerPlace.id,
    /** The dispatcher, to mount after the API auth gate and before every route that reads a directory. */
    middleware: dispatcher.middleware,
    /**
     * Makes the WebSocket forwarder, with the host's own auth and origin checks. `upgradeHandler`
     * then takes the upgrades under the prefix, and nothing before this call.
     */
    prepareUpgrades: ({ uiAuthController, isRequestOriginAllowed }) => {
      sockets = createSpaceWebSocketForwarder({ dispatcher, connect: connectReachable, uiAuthController, isRequestOriginAllowed, logger });
    },
    upgradeHandler: (...args) => sockets?.upgradeHandler(...args),
    /**
     * Follows the spaces: an event connection for each, into the host's hub, and the host's own ids
     * from its events; with `broadcastUiEvent`, the host's control stream, also each space's queue
     * changes, and with `broadcastGlobalUiEvent`, its notification stream, each space's permission modes.
     */
    startEvents: (globalEventHub, { broadcastUiEvent = null, broadcastGlobalUiEvent = null } = {}) => {
      hub = globalEventHub;
      events = createSpaceEventSources({ requestInside: dispatcher.requestInside, index, hub: globalEventHub, broadcastUiEvent, broadcastGlobalUiEvent, logger, now });
      unsubscribeHostEvents = globalEventHub.subscribeEvent((event) => { if (event.spaceId === null) index.observeHostEvent(event.payload); });
      followTimer = setTimer(() => { void follow(); }, FOLLOW_INTERVAL_MS);
      followTimer?.unref?.();
      keepTimer = setTimer(() => { void keeper.tick(); }, KEEP_INTERVAL_MS);
      keepTimer?.unref?.();
      // A running space whose gatekeeper lost its grants, from a start cut short, gets them again.
      void journey.restoreLostGrants();
      return follow();
    },
    /** One look of the login keeper, now: what its timer does every minute, for the tests. */
    keepLoginsFresh: () => keeper.tick(),
    /** For the proxy: the merged session list, or the host's own when no space exists. */
    mergeSessionList,
    /** For the body parsers: a request to a space keeps its body for the space. */
    skipsBodyParsing: (req) => dispatcher.isSpaceRequest(req),
    /** For the directory gate: the reason a directory is refused on the host, or null. */
    refuseDirectory: (candidate) => (dispatcher.isSpaceDirectory(candidate)
      ? 'A directory under /spaces/ belongs to an isolated space and is named in the query or the directory header of a request to it'
      : null),
    close: () => {
      if (followTimer !== null) clearTimer(followTimer);
      followTimer = null;
      if (keepTimer !== null) clearTimer(keepTimer);
      keepTimer = null;
      unsubscribeHostEvents?.();
      unsubscribeHostEvents = null;
      events?.close();
      sockets?.close();
      dispatcher.close();
    },
  };
}
