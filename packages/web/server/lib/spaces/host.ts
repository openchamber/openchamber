
import crypto from 'node:crypto';
import fs from 'node:fs';
import type { IncomingMessage } from 'node:http';
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
import { createSshConnections } from './places/ssh-connections.js';
import { openCommandStream as openCommandStreamProcess, runCommand as runCommandProcess } from './run-command.js';
import { createSpaceServerChannel } from './space-server.js';
import { createRegistryToolsSource, readHostToolVersions } from './tools.js';
import { isJsonObject, parseJson } from './json.js';
import { isRecord } from '../shared/object-guards.js';
import type { JsonValue } from './json.js';
import { spaceErrorProperty } from './errors.js';
import type { RunCommand } from './command-contracts.js';
import type { InsideRequest, InsideResponse } from './dispatcher.js';
import type { SpaceJourneyOptions } from './journey.js';
import type { LoginKeeperOptions } from './login-keeper.js';
import type { HostCatalogOptions } from './host-catalog.js';
import type { createSpaceArchive } from './space-archive.js';
import type { SpaceEventSourcesOptions } from './space-events.js';
import type { createGlobalMessageStreamHub } from '../event-stream/global-hub.js';
import type { RequestOriginChecker } from '../security/request-security.js';
import type { createUiAuth } from '../ui-auth/ui-auth.js';

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

const readBody = (response: IncomingMessage, cap: number) => new Promise<string>((resolve, reject) => {
  const chunks: Buffer[] = [];
  let size = 0;
  response.on('data', (chunk: Buffer) => {
    size += chunk.length;
    if (size > cap) { response.destroy(); reject(new Error(`the answer exceeds ${cap} bytes`)); return; }
    chunks.push(chunk);
  });
  response.on('end', () => resolve(Buffer.concat(chunks).toString('utf8')));
  response.on('error', reject);
});

const fieldOf = (value: JsonValue | undefined, key: string) => (value !== undefined && isJsonObject(value) ? value[key] : undefined);

type AnnouncedPayload = Parameters<NonNullable<SpaceJourneyOptions<string, unknown>['announce']>>[1];

const wirePayload = (payload: AnnouncedPayload): JsonValue => JSON.parse(JSON.stringify(payload));

const errorSummary = <Cause>(error: Cause) => spaceErrorProperty(error, 'code') ?? spaceErrorProperty(error, 'message') ?? error;

type RequestInside = (spaceId: string, request: InsideRequest) => Promise<InsideResponse>;

type GlobalEventHub = ReturnType<typeof createGlobalMessageStreamHub>;
type SpaceSockets = ReturnType<typeof createSpaceWebSocketForwarder>;

interface KnownSpaces {
  spaces: KnownSpace[];
  readAt: number;
}

interface KnownSpace {
  id: string;
  name: string;
  state: string;
  projectDirectory: string | null;
  directory: string | null;
}

export interface SpacesHostOptions {
  dataDir: string;
  dockerPath?: string;
  colimaPath?: string | null;
  findProgram?: (name: string) => string | null;
  sshDockerHost?: string | null;
  gitPath?: string;
  hostEnvironment?: NodeJS.ProcessEnv;
  listProjectDirectories?: () => Promise<string[]>;
  readIdleStop?: SpaceJourneyOptions<string, unknown>['readIdleStop'];
  saveIdleStop?: SpaceJourneyOptions<string, unknown>['saveIdleStop'];
  readPermissionDefault?: SpaceJourneyOptions<string, unknown>['readPermissionDefault'];
  archive?: Pick<ReturnType<typeof createSpaceArchive>, 'saveChats'> | null;
  readHostLogin?: LoginKeeperOptions['readLogin'];
  renewHostLogin?: LoginKeeperOptions['renewLogin'];
  loginWindowOf?: SpaceJourneyOptions<string, unknown>['loginWindowOf'];
  hostProviders?: SpaceJourneyOptions<string, unknown>['hostProviders'] | null;
  readHostCatalog?: HostCatalogOptions['readCatalog'];
  userAgent?: string;
  runCommand?: RunCommand;
  openCommandStream?: typeof openCommandStreamProcess;
  place?: ReturnType<typeof createDockerPlace> | null;
  logger?: Pick<Console, 'warn'> & Partial<Pick<Console, 'info'>>;
  now?: () => number;
  setTimer?: (callback: () => void, milliseconds: number) => ReturnType<typeof setInterval>;
  clearTimer?: (timer: ReturnType<typeof setInterval>) => void;
}

export const restartOpenCodeInside = async (requestInside: RequestInside, spaceId: string) => {
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

const readOwnerFile = (file: string) => {
  try {
    return fs.readFileSync(file, 'utf8').trim();
  } catch {
    return null;
  }
};

export function readOrCreateOwner(dataDir: string) {
  const file = path.join(dataDir, OWNER_FILE);
  const existing = readOwnerFile(file);
  if (existing !== null && /^[a-z0-9]{16,64}$/.test(existing)) return existing;
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
}: SpacesHostOptions) {
  const owner = readOrCreateOwner(dataDir);
  const toolsSource = createRegistryToolsSource(readHostToolVersions());
  const dockerPlace = place ?? createDockerPlace({ runCommand, openCommandStream, dockerPath, colimaPath, owner, toolsSource });
  const sshPlace = sshDockerHost === null ? null : createDockerPlace({
    runCommand,
    openCommandStream,
    dockerPath,
    dockerHost: sshDockerHost,
    connections: createSshConnections({ dockerHost: sshDockerHost, directory: path.join(dataDir, 'spaces', 'ssh') }),
    id: DOCKER_SSH_PLACE_ID,
    owner,
    toolsSource,
  });
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
  const unreachableIds = async (): Promise<Set<string>> => new Set((await knownSpaces()).filter((space) => space.state === 'unreachable').map((space) => space.id));
  const requireReachable = async (spaceId: string) => {
    if ((await unreachableIds()).has(spaceId)) throw new SpaceError('place_unreachable', 'The machine this space runs on cannot be reached.');
  };
  const connectReachable = async (spaceId: string) => {
    await requireReachable(spaceId);
    return manager.connect(spaceId);
  };
  const dispatcher = createSpaceDispatcher({
    logger,
    now,
    transport: {
      listSpaceIds: async () => {
        const { spaces, unavailable } = await manager.listAllSpaces();
        await remember(spaces);
        const failure = unavailable.find(({ placeId }) => registry.get(placeId))?.failure ?? null;
        return { ids: spaces.map((space) => space.id), failure };
      },
      connect: connectReachable,
      readToken: async (spaceId: string) => {
        await requireReachable(spaceId);
        return serverInside.readToken(spaceId);
      },
    },
  });

  const spaceOpenCode = createSpaceOpenCode({ exec: manager.exec, requestInside: dispatcher.requestInside });

  const index = createSpaceSessionIndex({ logger });
  let events: ReturnType<typeof createSpaceEventSources> | null = null;
  let unsubscribeHostEvents: (() => void) | null = null;
  let followTimer: ReturnType<typeof setInterval> | null = null;
  let keepTimer: ReturnType<typeof setInterval> | null = null;
  let known: KnownSpaces = { spaces: [], readAt: -Infinity };
  let listing: Promise<void> | null = null;
  const listReadAt = new Map<string, number>();

  const resolveProjects = async (spaces: Awaited<ReturnType<typeof listSpaces>>) => {
    if (spaces.length === 0) return new Map<string, string | null>();
    let directories: string[] = [];
    try {
      directories = await listProjectDirectories();
    } catch (error) {
      logger.warn?.(`[spaces] could not read the projects: ${errorSummary(error)}`);
    }
    const byHash = new Map(directories.map((directory) => [hashProjectDirectory(directory), directory]));
    return new Map(spaces.map((space) => [space.id, byHash.get(space.project) ?? null]));
  };

  const remember = async (spaces: Awaited<ReturnType<typeof listSpaces>>) => {
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
  };

  const knownSpaces = async () => {
    if (now() - known.readAt < LIST_TTL_MS) return known.spaces;
    if (!listing) {
      listing = listSpaces()
        .then(remember)
        .catch((error) => { logger.warn?.(`[spaces] could not list the spaces: ${errorSummary(error)}`); })
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

  let hub: GlobalEventHub | null = null;
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
          return { chats: chats.map((chat) => ({ id: fieldOf(chat, 'id'), title: fieldOf(chat, 'title') })), complete };
        },
        exportChat: (chatId: string) => spaceOpenCode.exportChat(spaceId, chatId),
      },
    }) : null,
    readHostSecret: (name) => hostEnvironment[name],
    readHostLogin: keeper.fresh,
    loginWindowOf,
    hostProviders: hostProviders ?? createHostProviders({ readStoredKey: async (providerId) => {
      const entry = await getProviderAuth(providerId);
      return (entry !== null && 'key' in entry ? entry.key : undefined) ?? null;
    }, hostEnvironment }),
    hostCatalog: createHostCatalog({ readCatalog: readHostCatalog, readStoredKey: async (integration) => storedApiKeySchema.safeParse(await getProviderAuth(integration)).data?.key ?? null }),
    readIdleStop,
    saveIdleStop,
    readPermissionDefault,
    announce: (spaceId, payload) => { hub?.injectEvent({ payload: wirePayload(payload), directory: 'global', spaceId }); },
    onSpacesChanged: () => { void refresh().catch(() => {}); },
    logger,
  });

  const readSpaceSessions = async (spaceId: string) => {
    const records: JsonValue[] = [];
    let cursor: string | null = null;
    for (let page = 0; page < SESSION_MAX_PAGES; page += 1) {
      const query = new URLSearchParams({ limit: String(SESSION_PAGE_LIMIT) });
      if (cursor !== null) query.set('cursor', cursor);
      const response = await dispatcher.requestInside(spaceId, { path: `/api/session?${query}`, headers: { accept: 'application/json' }, timeoutMs: SESSION_LIST_TIMEOUT_MS });
      if (response.statusCode !== 200) { response.resume(); throw new Error(`status ${response.statusCode}`); }
      const payload = parseJson(await readBody(response, MAX_SESSION_LIST_BYTES));
      const data = Array.isArray(payload) ? payload : fieldOf(payload, 'data');
      if (!Array.isArray(data)) throw new Error('the list is not a list');
      records.push(...data);
      const next = nextCursorSchema.safeParse(fieldOf(fieldOf(payload, 'cursor'), 'next'));
      if (!next.success || data.length === 0) return { records, complete: true };
      cursor = next.data;
    }
    return { records, complete: false };
  };

  const mergeSessionList = async <Payload>(hostPayload: Payload) => {
    const hostRecords: unknown = Array.isArray(hostPayload) ? hostPayload : (isRecord(hostPayload) ? hostPayload.data : undefined);
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
        logger.warn?.(`[spaces] the session list of space ${spaceId} did not come: ${errorSummary(error)}`);
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

  let sockets: SpaceSockets | null = null;

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
    prepareUpgrades: ({ uiAuthController, isRequestOriginAllowed }: { uiAuthController: ReturnType<typeof createUiAuth> | null; isRequestOriginAllowed: RequestOriginChecker }) => {
      sockets = createSpaceWebSocketForwarder({ dispatcher, connect: connectReachable, uiAuthController, isRequestOriginAllowed, logger });
    },
    upgradeHandler: (...args: Parameters<SpaceSockets['upgradeHandler']>) => sockets?.upgradeHandler(...args),
    startEvents: (globalEventHub: GlobalEventHub, { broadcastUiEvent = null, broadcastGlobalUiEvent = null }: Pick<SpaceEventSourcesOptions, 'broadcastUiEvent' | 'broadcastGlobalUiEvent'> = {}) => {
      hub = globalEventHub;
      events = createSpaceEventSources({ requestInside: dispatcher.requestInside, index, hub: globalEventHub, broadcastUiEvent, broadcastGlobalUiEvent, logger, now,
        onTaskTitle: (spaceId, title) => {
          try {
            const result = records.setTaskTitle(spaceId, { title, by: 'agent' });
            if (result.applied) globalEventHub.injectEvent({ payload: { type: 'openchamber:space-task-title.updated', properties: { spaceId, taskTitle: result.taskTitle } }, directory: 'global', spaceId });
          } catch (error) {
            logger.warn?.(`[spaces] could not save the task title of space ${spaceId}: ${errorSummary(error)}`);
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
    skipsBodyParsing: (req: Parameters<typeof dispatcher.isSpaceRequest>[0]) => dispatcher.isSpaceRequest(req),
    refuseDirectory: (candidate: Parameters<typeof dispatcher.isSpaceDirectory>[0]) => (dispatcher.isSpaceDirectory(candidate)
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
      sshPlace?.close();
    },
  };
}
