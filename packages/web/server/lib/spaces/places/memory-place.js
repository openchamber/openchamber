// Test support. A place that keeps spaces in a Map, for the contract suite and the manager tests.

import { SpaceError } from '../errors.js';
import { requireSpaceId } from '../labels.js';

export function createMemoryPlace({ id = 'memory' } = {}) {
  const spaces = new Map();

  const requireSpace = (spaceId) => {
    const space = spaces.get(requireSpaceId(spaceId));
    if (!space) {
      throw new SpaceError('space_not_found', `Space ${spaceId} does not exist`);
    }
    return space;
  };

  return {
    id,
    check: async () => ({ available: true, version: 'memory', os: 'none', arch: 'none', hostIsolation: true }),
    create: async ({ id: spaceId, name, project, created }) => {
      if (spaces.has(requireSpaceId(spaceId))) {
        throw new SpaceError('space_name_taken', `Space ${spaceId} already exists`);
      }
      spaces.set(spaceId, { id: spaceId, name, project, created, state: 'running', orphans: [], damaged: false, missing: [] });
    },
    list: async () => Array.from(spaces.values(), (space) => ({ ...space })),
    exec: async (spaceId, argv) => {
      requireSpace(spaceId);
      return argv.join(' ') === 'id -u' ? { code: 0, stdout: '1000\n', stderr: '' } : { code: 127, stdout: '', stderr: 'not found' };
    },
    stop: async (spaceId) => { requireSpace(spaceId).state = 'exited'; },
    start: async (spaceId) => { requireSpace(spaceId).state = 'running'; },
    remove: async (spaceId) => {
      const removed = spaces.delete(requireSpaceId(spaceId)) ? [{ kind: 'space', name: spaceId }] : [];
      return { removed, failed: [] };
    },
    verify: async (spaceId) => {
      requireSpace(spaceId);
      return [];
    },
  };
}
