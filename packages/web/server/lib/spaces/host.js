// What the host server builds when the isolated-spaces switch is on, and nothing of it when it
// is off: the place, the manager, the dispatcher, and the two hooks the rest of the server takes.
//
// `server/index.js` reads the switch once at start. While it is off this module is never
// imported for its effect: no place, no manager, no route, no `docker`. A change of the switch
// takes effect at the next start of the server.

import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';

import { createSpaceDispatcher } from './dispatcher.js';
import { createSpaceManager } from './manager.js';
import { createDockerPlace } from './places/docker.js';
import { createPlaceRegistry } from './places/registry.js';
import { openCommandStream as openCommandStreamProcess, runCommand as runCommandProcess } from './run-command.js';
import { createSpaceServerChannel } from './space-server.js';
import { createRegistryToolsSource, readHostToolVersions } from './tools.js';

const OWNER_FILE = path.join('spaces', 'owner');

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

  const dispatcher = createSpaceDispatcher({
    logger,
    transport: {
      listSpaceIds: async () => (await manager.listSpaces({ placeId: dockerPlace.id })).map((space) => space.id),
      connect: (spaceId) => dockerPlace.connect(spaceId),
      readToken: (spaceId) => serverInside.readToken(spaceId),
    },
  });

  return {
    manager,
    dispatcher,
    /** Mounts the dispatcher: after the API auth gate, before every route that reads a directory. */
    registerRoutes: (app) => { app.use(dispatcher.middleware); },
    /** For the body parsers: a request to a space keeps its body for the space. */
    skipsBodyParsing: (req) => dispatcher.isSpaceRequestPath(req.path),
    /** For the directory gate: the reason a directory is refused on the host, or null. */
    refuseDirectory: (candidate) => (dispatcher.isSpaceDirectory(candidate)
      ? 'A directory under /spaces/ belongs to an isolated space and is addressed as /api/spaces/<id>/... only'
      : null),
    close: () => dispatcher.close(),
  };
}
