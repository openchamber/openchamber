import crypto from 'node:crypto';
import http from 'node:http';
import net from 'node:net';

import { SpaceError } from '../errors.js';
import { ROLE_GATEKEEPER, ROLE_SPACE, requireSpaceId } from '../labels.js';
import { isString } from '../../shared/object-guards.js';
import type { SpaceSpec } from '../manager.js';
import type { CommandOptions } from '../command-contracts.js';

interface MemorySpace extends Pick<SpaceSpec, 'id' | 'name' | 'project' | 'created'> {
  state: 'running' | 'exited';
  stoppedIdle: boolean;
  gatekeeperRunning: boolean;
  orphans: { kind: string; name: string }[];
  damaged: boolean;
  missing: string[];
}

interface MemoryContainer {
  hostname: string;
  server?: http.Server;
}

const TARGETS = [ROLE_SPACE, ROLE_GATEKEEPER];

const CONTAINER_PROGRAM = [
  'const [hostname, ...command] = process.argv.slice(1);',
  'const line = command.join(" ");',
  'if (line === "cat /etc/hostname") process.stdout.write(hostname + "\\n");',
  'else process.exitCode = 127;',
].join(' ');

export function createMemoryPlace({ id = 'memory' } = {}) {
  const spaces = new Map<string, MemorySpace>();
  const containers = new Map<string, MemoryContainer>();

  const requireSpace = (spaceId: string) => {
    const space = spaces.get(requireSpaceId(spaceId));
    if (!space) {
      throw new SpaceError('space_not_found', `Space ${spaceId} does not exist`);
    }
    return space;
  };

  const requireContainer = (spaceId: string, target = ROLE_SPACE) => {
    if (!TARGETS.includes(target)) {
      throw new SpaceError('invalid_exec_target', `A command runs in the space or in its gatekeeper, not in '${target}'`);
    }
    const container = containers.get(`${requireSpaceId(spaceId)}:${target}`);
    if (!container) {
      throw new SpaceError(target === ROLE_GATEKEEPER ? 'gatekeeper_missing' : 'space_not_found', `Space ${spaceId} has no ${target} container`);
    }
    return container;
  };

  return {
    id,
    check: async () => ({ available: true, version: 'memory', os: 'none', arch: 'none', hostIsolation: true }),
    pullImage: async () => {},
    imagePulling: () => false,
    create: async ({ id: spaceId, name, project, created }: Pick<SpaceSpec, 'id' | 'name' | 'project' | 'created'>) => {
      if (spaces.has(requireSpaceId(spaceId))) {
        throw new SpaceError('space_name_taken', `Space ${spaceId} already exists`);
      }
      spaces.set(spaceId, { id: spaceId, name, project, created, state: 'running', stoppedIdle: false, gatekeeperRunning: true, orphans: [], damaged: false, missing: [] });
      for (const target of TARGETS) {
        containers.set(`${spaceId}:${target}`, { hostname: crypto.randomBytes(6).toString('hex') });
      }
      const server = http.createServer((request, response) => {
        response.setHeader('content-type', 'application/json');
        response.end(JSON.stringify({ status: 'ok', isOpenCodeReady: true, spaceId, path: request.url }));
      });
      await new Promise<void>((resolve) => { server.listen(0, '127.0.0.1', resolve); });
      requireContainer(spaceId).server = server;
    },
    list: async () => Array.from(spaces.values(), (space) => ({ ...space })),
    exec: async (spaceId: string, argv: string[], options: CommandOptions & { target?: string } = {}) => {
      const container = requireContainer(spaceId, options.target);
      const command = argv.join(' ');
      if (command === 'id -u') {
        return { code: 0, stdout: '1000\n', stderr: '' };
      }
      if (command === 'cat /etc/hostname') {
        return { code: 0, stdout: `${container.hostname}\n`, stderr: '' };
      }
      if (command === `test -d /spaces/${spaceId}`) {
        return { code: options.target === ROLE_GATEKEEPER ? 1 : 0, stdout: '', stderr: '' };
      }
      return { code: 127, stdout: '', stderr: 'not found' };
    },
    execArgv: async (spaceId: string) => {
      const { hostname } = requireContainer(spaceId);
      if (requireSpace(spaceId).state !== 'running') {
        throw new SpaceError('space_not_running', `Space ${spaceId} is stopped`);
      }
      return [process.execPath, '-e', CONTAINER_PROGRAM, hostname];
    },
    connect: async (spaceId: string) => {
      const { server } = requireContainer(spaceId);
      if (requireSpace(spaceId).state !== 'running') {
        throw new SpaceError('space_not_running', `Space ${spaceId} is stopped`);
      }
      if (!server) throw new TypeError('Missing memory space server');
      const address = server.address();
      if (address === null || isString(address)) throw new TypeError('Missing memory space TCP address');
      return net.connect({ host: '127.0.0.1', port: address.port });
    },
    stop: async (spaceId: string) => { Object.assign(requireSpace(spaceId), { state: 'exited', gatekeeperRunning: false }); },
    start: async (spaceId: string) => { Object.assign(requireSpace(spaceId), { state: 'running', stoppedIdle: false, gatekeeperRunning: true }); },
    remove: async (spaceId: string) => {
      const removed = [];
      for (const target of TARGETS) {
        const container = containers.get(`${requireSpaceId(spaceId)}:${target}`);
        if (!container) continue;
        container.server?.close();
        containers.delete(`${spaceId}:${target}`);
        removed.push({ kind: 'container', name: `${spaceId}-${target}` });
      }
      if (spaces.delete(spaceId)) removed.push({ kind: 'space', name: spaceId });
      return { removed, failed: [] };
    },
    verify: async (spaceId: string) => {
      requireSpace(spaceId);
      requireContainer(spaceId, ROLE_GATEKEEPER);
      return [];
    },
  };
}
