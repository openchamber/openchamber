// Test support. A place that keeps spaces in a Map, for the contract suite and the manager tests.
//
// It models the two containers of a space, the space and its gatekeeper, because the contract
// suite is meant to fail a place that has no gatekeeper. A place that answered both targets from
// one container would pass nothing here.

import crypto from 'node:crypto';

import { SpaceError } from '../errors.js';
import { ROLE_GATEKEEPER, ROLE_SPACE, requireSpaceId } from '../labels.js';

const TARGETS = [ROLE_SPACE, ROLE_GATEKEEPER];

export function createMemoryPlace({ id = 'memory' } = {}) {
  const spaces = new Map();
  // Every container of every space that was ever made here, by `<space id>:<role>`.
  const containers = new Map();

  const requireSpace = (spaceId) => {
    const space = spaces.get(requireSpaceId(spaceId));
    if (!space) {
      throw new SpaceError('space_not_found', `Space ${spaceId} does not exist`);
    }
    return space;
  };

  const requireContainer = (spaceId, target = ROLE_SPACE) => {
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
    create: async ({ id: spaceId, name, project, created }) => {
      if (spaces.has(requireSpaceId(spaceId))) {
        throw new SpaceError('space_name_taken', `Space ${spaceId} already exists`);
      }
      spaces.set(spaceId, { id: spaceId, name, project, created, state: 'running', orphans: [], damaged: false, missing: [] });
      for (const target of TARGETS) {
        // A container has a hostname of its own, as a real one does, so a caller can tell them apart.
        containers.set(`${spaceId}:${target}`, { hostname: crypto.randomBytes(6).toString('hex') });
      }
    },
    list: async () => Array.from(spaces.values(), (space) => ({ ...space })),
    exec: async (spaceId, argv, options = {}) => {
      // The container, and not the space record: a place that removed the space and left its
      // gatekeeper running would still answer here, and the contract suite must see that.
      const container = requireContainer(spaceId, options.target);
      const command = argv.join(' ');
      if (command === 'id -u') {
        return { code: 0, stdout: '1000\n', stderr: '' };
      }
      if (command === 'cat /etc/hostname') {
        return { code: 0, stdout: `${container.hostname}\n`, stderr: '' };
      }
      // The work directory of the space is in the space and not in its gatekeeper.
      if (command === `test -d /spaces/${spaceId}`) {
        return { code: options.target === ROLE_GATEKEEPER ? 1 : 0, stdout: '', stderr: '' };
      }
      return { code: 127, stdout: '', stderr: 'not found' };
    },
    stop: async (spaceId) => { requireSpace(spaceId).state = 'exited'; },
    start: async (spaceId) => { requireSpace(spaceId).state = 'running'; },
    remove: async (spaceId) => {
      const removed = [];
      for (const target of TARGETS) {
        if (containers.delete(`${requireSpaceId(spaceId)}:${target}`)) removed.push({ kind: 'container', name: `${spaceId}-${target}` });
      }
      if (spaces.delete(spaceId)) removed.push({ kind: 'space', name: spaceId });
      return { removed, failed: [] };
    },
    verify: async (spaceId) => {
      requireSpace(spaceId);
      requireContainer(spaceId, ROLE_GATEKEEPER);
      return [];
    },
  };
}
