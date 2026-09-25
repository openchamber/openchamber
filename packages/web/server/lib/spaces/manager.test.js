import { describe, expect, it } from 'vitest';

import { SpaceError } from './errors.js';
import { hashProjectDirectory } from './labels.js';
import { createSpaceManager } from './manager.js';
import { createMemoryPlace } from './places/memory-place.js';
import { createPlaceRegistry } from './places/registry.js';

const NOW = new Date('2026-09-19T10:00:00.000Z');
const REQUEST = { placeId: 'memory', projectDirectory: '/home/me/project', name: '  Fix login  ' };

const managerFor = (place) => createSpaceManager({ registry: createPlaceRegistry([place]), now: () => NOW });

describe('createSpaceManager', () => {
  it('creates a space with a fresh id, the project hash and the creation time', async () => {
    const manager = managerFor(createMemoryPlace());

    const space = await manager.createSpace(REQUEST);
    expect(space).toEqual({
      placeId: 'memory',
      id: expect.stringMatching(/^[0-9a-f]{12}$/),
      name: 'Fix login',
      project: hashProjectDirectory('/home/me/project'),
      created: '2026-09-19T10:00:00.000Z',
      memoryBytes: 4 * 1024 * 1024 * 1024,
    });
    const { memoryBytes, ...listedFields } = space;
    expect(memoryBytes).toBeGreaterThan(0);
    expect(await manager.listSpaces({ placeId: 'memory' })).toEqual([{ ...listedFields, state: 'running', orphans: [], damaged: false, missing: [] }]);
  });

  it('takes the id a caller announced before the creation, and refuses one that is not a space id', async () => {
    const manager = managerFor(createMemoryPlace());
    expect((await manager.createSpace({ ...REQUEST, id: 'a1b2c3d4e5f6' })).id).toBe('a1b2c3d4e5f6');
    await expect(manager.createSpace({ ...REQUEST, id: 'not-an-id' })).rejects.toMatchObject({ code: 'invalid_space_id' });
  });

  it('names the place that does not exist', async () => {
    const manager = managerFor(createMemoryPlace());

    await expect(manager.createSpace({ ...REQUEST, placeId: 'cluster' })).rejects.toMatchObject({ code: 'place_not_found' });
    await expect(manager.listSpaces({ placeId: 'cluster' })).rejects.toMatchObject({ code: 'place_not_found' });
    await expect(manager.stopSpace({ placeId: 'cluster', spaceId: 'a1b2c3d4e5f6' })).rejects.toMatchObject({ code: 'place_not_found' });
  });

  it('rejects a bad name or directory before it asks the place', async () => {
    const place = createMemoryPlace();
    const manager = managerFor(place);

    await expect(manager.createSpace({ ...REQUEST, name: '' })).rejects.toMatchObject({ code: 'invalid_space_name' });
    await expect(manager.createSpace({ ...REQUEST, projectDirectory: '' })).rejects.toMatchObject({ code: 'invalid_project_directory' });
    expect(await place.list()).toEqual([]);
  });

  it('removes and refuses a space whose verification reports violations', async () => {
    const place = { ...createMemoryPlace(), verify: async () => [{ check: 'privileged', message: 'The container is privileged' }] };
    const manager = managerFor(place);

    const error = await manager.createSpace(REQUEST).catch((caught) => caught);
    expect(error).toBeInstanceOf(SpaceError);
    expect(error.code).toBe('space_verification_failed');
    expect(error.message).toContain('The container is privileged');
    expect(error.details.violations).toHaveLength(1);
    expect(error.details.removal.failed).toEqual([]);
    expect(await place.list()).toEqual([]);
  });

  it('removes a space that could not be verified at all', async () => {
    const place = { ...createMemoryPlace(), verify: async () => { throw new SpaceError('command_timeout', 'docker inspect did not finish'); } };
    const manager = managerFor(place);

    await expect(manager.createSpace(REQUEST)).rejects.toMatchObject({ code: 'command_timeout' });
    expect(await place.list()).toEqual([]);
  });

  it('reports a space it could neither verify nor remove', async () => {
    const place = {
      ...createMemoryPlace(),
      verify: async () => [{ check: 'user', message: 'Runs as root' }],
      remove: async () => { throw new SpaceError('docker_command_failed', 'daemon went away'); },
    };

    const error = await managerFor(place).createSpace(REQUEST).catch((caught) => caught);
    expect(error.details.removal.failed).toEqual([{ kind: 'space', name: expect.any(String), message: 'daemon went away' }]);
  });

  it('lets a failed create through', async () => {
    const place = { ...createMemoryPlace(), create: async () => { throw new SpaceError('image_pull_failed', 'no internet'); } };
    await expect(managerFor(place).createSpace(REQUEST)).rejects.toMatchObject({ code: 'image_pull_failed' });
  });

  it('lets a list failure through instead of an empty list', async () => {
    const place = { ...createMemoryPlace(), list: async () => { throw new SpaceError('docker_command_failed', 'daemon went away'); } };
    await expect(managerFor(place).listSpaces({ placeId: 'memory' })).rejects.toMatchObject({ code: 'docker_command_failed' });
  });

  it('reads status from the place on every call', async () => {
    const manager = managerFor(createMemoryPlace());
    const { id: spaceId } = await manager.createSpace(REQUEST);
    const state = async () => (await manager.listSpaces({ placeId: 'memory' }))[0].state;

    await manager.stopSpace({ placeId: 'memory', spaceId });
    expect(await state()).toBe('exited');
    await manager.startSpace({ placeId: 'memory', spaceId });
    expect(await state()).toBe('running');
    await manager.removeSpace({ placeId: 'memory', spaceId });
    expect(await manager.listSpaces({ placeId: 'memory' })).toEqual([]);
  });

  it('fails a removal that left something behind', async () => {
    const failed = [{ kind: 'volume', name: 'openchamber-space-a1b2c3d4e5f6-volume-work', message: 'volume is in use' }];
    const place = { ...createMemoryPlace(), remove: async () => ({ removed: [], failed }) };

    await expect(managerFor(place).removeSpace({ placeId: 'memory', spaceId: 'a1b2c3d4e5f6' })).rejects.toMatchObject({
      code: 'space_remove_incomplete',
      message: 'Could not remove: volume openchamber-space-a1b2c3d4e5f6-volume-work',
      details: { failed },
    });
  });
});
