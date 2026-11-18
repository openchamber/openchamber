
import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';

import { z } from 'zod';

import { getProviderAuth, getStoredLogin, renewStoredLogin } from '../opencode/auth.js';
import { readOpenCodeCatalog } from '../small-model/client.js';
import { createCodeIn } from './code-in.js';
import { createCodeOut } from './code-out.js';
import { createSpaceDispatcher } from './dispatcher.js';
import { SpaceError } from './errors.js';
import { createGatekeeperChannel } from './gatekeeper-channel.js';
import { createHostGit } from './host-git.js';
import { createHostCatalog } from './host-catalog.js';
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

const storedApiKeySchema = z.object({ type: z.literal('api'), key: z.string().min(1) });

const OWNER_FILE = path.join('spaces', 'owner');

const FOLLOW_INTERVAL_MS = 15_000;
const LIST_TTL_MS = 2_000;
const SESSION_PAGE_LIMIT = 100;
const SESSION_MAX_PAGES = 10;
const SESSION_LIST_TIMEOUT_MS = 10_000;
const MAX_SESSION_LIST_BYTES = 8 * 1024 * 1024;
const RESTART_OPENCODE_TIMEOUT_MS = 180_000;
const MAX_RESTART_ANSWER_BYTES = 64 * 1024;
const restartedSchema = z.object({ success: z.literal(true), requiresReload: z.literal(true) });
const nextCursorSchema = z.string().min(1);

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
  readPermissionDefault,
  archive = null,
  readHostLogin = getStoredLogin,
  renewHostLogin = renewStoredLogin,
  loginWindowOf = undefined,
  hostProviders = null,
  readHostCatalog = readOpenCodeCatalog,
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
  const sshPlace = sshDockerHost === null ? null : createDockerPlace({ runCommand, openCommandStream, dockerPath, dockerHost: sshDockerHost, id: DOCKER_SSH_PLACE_ID, owner, toolsSource });
  const dockerSetup = createDockerSetup({ runCommand, findProgram, dockerPath, environment: hostEnvironment, check: () => dockerPlace.check(), logger });
  const registry = createPlaceRegistry(sshPlace ? [dockerPlace, sshPlace] : [dockerPlace]);
  registry.seal();
  const records = createSpaceRecords({ dataDir, logger });
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
  const unreachableIds = async () => new Set((await knownSpaces()).filter((space) => space.state === 'unreachable').map((space) => space.id));
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
  const listReadAt = new Map();

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
  const refresh = () => {
    known = { spaces: known.spaces, readAt: -Infinity };
    return follow();
  };

  let hub = null;
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
        listChats: async () => {
          if (!running) throw new SpaceError('space_not_running', 'The space is not running');
          const { records: chats, complete } = await readSpaceSessions(spaceId);
          return { chats: chats.map((chat) => ({ id: chat?.id, title: chat?.title })), complete };
        },
        exportChat: (chatId) => spaceOpenCode.exportChat(spaceId, chatId),
      },
    }) : null,
    readHostSecret: (name) => hostEnvironment[name],
    readHostLogin: keeper.fresh,
    loginWindowOf,
    hostProviders: hostProviders ?? createHostProviders({ readStoredKey: async (providerId) => (await getProviderAuth(providerId))?.key ?? null, hostEnvironment }),
    hostCatalog: createHostCatalog({ readCatalog: readHostCatalog, readStoredKey: async (integration) => storedApiKeySchema.safeParse(await getProviderAuth(integration)).data?.key ?? null }),
    readIdleStop,
    saveIdleStop,
    readPermissionDefault,
    announce: (spaceId, payload) => { hub?.injectEvent({ payload, directory: 'global', spaceId }); },
    onSpacesChanged: () => { void refresh().catch(() => {}); },
    logger,
  });

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

  const mergeSessionList = async (hostPayload) => {
    const hostRecords = Array.isArray(hostPayload) ? hostPayload : hostPayload?.data;
    if (Array.isArray(hostRecords)) index.observeHostRecords(hostRecords);
    const spaces = await knownSpaces();
    if (spaces.length === 0) return hostPayload;
    await Promise.all(spaces.map(async ({ id: spaceId, state }) => {
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
        listReadAt.delete(spaceId);
      }
    }));
    const answers = new Map(index.snapshot().map((entry) => [entry.spaceId, entry]));
    return mergeSessionLists(hostPayload, spaces.flatMap((space) => {
      const answer = answers.get(space.id);
      return answer === undefined ? [] : [{ ...answer, name: space.name, taskTitle: records.read(space.id).record?.taskTitle ?? null, projectDirectory: space.projectDirectory, directory: space.directory }];
    }));
  };

  let sockets = null;

  return {
    manager,
    dispatcher,
    index,
    journey,
    openCodeFetchFor: createSpaceFetch({ requestInside: dispatcher.requestInside }),
    places: () => registry.list(),
    dockerSetup,
    localPlaceId: dockerPlace.id,
    middleware: dispatcher.middleware,
    prepareUpgrades: ({ uiAuthController, isRequestOriginAllowed }) => {
      sockets = createSpaceWebSocketForwarder({ dispatcher, connect: connectReachable, uiAuthController, isRequestOriginAllowed, logger });
    },
    upgradeHandler: (...args) => sockets?.upgradeHandler(...args),
    startEvents: (globalEventHub, { broadcastUiEvent = null, broadcastGlobalUiEvent = null } = {}) => {
      hub = globalEventHub;
      events = createSpaceEventSources({ requestInside: dispatcher.requestInside, index, hub: globalEventHub, broadcastUiEvent, broadcastGlobalUiEvent, logger, now,
        onTaskTitle: (spaceId, title) => {
          try {
            const result = records.setTaskTitle(spaceId, { title, by: 'agent' });
            if (result.applied) globalEventHub.injectEvent({ payload: { type: 'openchamber:space-task-title.updated', properties: { spaceId, taskTitle: result.taskTitle } }, directory: 'global', spaceId });
          } catch (error) {
            logger.warn?.(`[spaces] could not save the task title of space ${spaceId}: ${error?.code ?? error?.message ?? error}`);
          }
        },
      });
      unsubscribeHostEvents = globalEventHub.subscribeEvent((event) => { if (event.spaceId === null) index.observeHostEvent(event.payload); });
      followTimer = setTimer(() => { void follow(); }, FOLLOW_INTERVAL_MS);
      followTimer?.unref?.();
      keepTimer = setTimer(() => { void keeper.tick(); }, KEEP_INTERVAL_MS);
      keepTimer?.unref?.();
      void journey.restoreLostGrants();
      return follow();
    },
    keepLoginsFresh: () => keeper.tick(),
    mergeSessionList,
    skipsBodyParsing: (req) => dispatcher.isSpaceRequest(req),
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
