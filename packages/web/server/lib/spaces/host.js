// What the host server builds when the isolated-spaces switch is on, and nothing of it when it
// is off: the place, the manager, the dispatcher, the WebSocket forwarder, the session index
// with the event connection of every space, and the hooks the rest of the server takes.
//
// `server/index.js` reads the switch once at start. While it is off this module is never
// imported for its effect: no place, no manager, no route, no `docker`. A change of the switch
// takes effect at the next start of the server.

import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';

import { z } from 'zod';

import { createSpaceDispatcher } from './dispatcher.js';
import { createSpaceManager } from './manager.js';
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
 * `dataDir` is the host's data directory and `dockerPath` the docker CLI to run. `place`
 * replaces the Docker place, for the tests; `runCommand` and `openCommandStream` are the two
 * ways this module starts a process, injectable for the same reason.
 */
export function createSpacesHost({
  dataDir,
  dockerPath = 'docker',
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

  const listSpaceIds = async () => (await manager.listSpaces({ placeId: dockerPlace.id })).map((space) => space.id);
  const dispatcher = createSpaceDispatcher({
    logger,
    transport: {
      listSpaceIds,
      connect: (spaceId) => dockerPlace.connect(spaceId),
      readToken: (spaceId) => serverInside.readToken(spaceId),
    },
  });

  const index = createSpaceSessionIndex({ logger });
  let events = null;
  let unsubscribeHostEvents = null;
  let followTimer = null;
  let known = { ids: [], readAt: -Infinity };
  let listing = null;
  // When each space's session list was last read; within the TTL the accepted list is served again.
  const listReadAt = new Map();

  /** The ids of this host's spaces, read again when older than the TTL. A failed read keeps the last ones. */
  const spaceIds = async () => {
    if (now() - known.readAt < LIST_TTL_MS) return known.ids;
    if (!listing) {
      listing = listSpaceIds()
        .then((ids) => { known = { ids, readAt: now() }; })
        .catch((error) => { logger.warn?.(`[spaces] could not list the spaces: ${error?.code ?? error?.message ?? error}`); })
        .finally(() => { listing = null; });
    }
    await listing;
    return known.ids;
  };

  const follow = async () => {
    const ids = await spaceIds();
    events?.sync(ids);
  };

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
    const ids = await spaceIds();
    if (ids.length === 0) return hostPayload;
    await Promise.all(ids.map(async (spaceId) => {
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
    const known = new Map(index.snapshot().map((entry) => [entry.spaceId, entry]));
    return mergeSessionLists(hostPayload, ids.map((spaceId) => known.get(spaceId)).filter((entry) => entry !== undefined));
  };

  let sockets = null;

  return {
    manager,
    dispatcher,
    index,
    /** Mounts the dispatcher: after the API auth gate, before every route that reads a directory. */
    registerRoutes: (app) => { app.use(dispatcher.middleware); },
    /** Takes the WebSocket upgrades under the prefix, with the host's own auth and origin checks. */
    attachUpgrades: (server, { uiAuthController, isRequestOriginAllowed }) => {
      sockets = createSpaceWebSocketForwarder({ dispatcher, connect: (spaceId) => dockerPlace.connect(spaceId), uiAuthController, isRequestOriginAllowed, logger });
      server.on('upgrade', sockets.upgradeHandler);
    },
    /** Follows the spaces: an event connection for each, into the host's hub, and the host's own ids from its events. */
    startEvents: (globalEventHub) => {
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
