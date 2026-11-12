import { describe, expect, it } from 'vitest';

import { SpaceError } from './errors.js';
import { hashProjectDirectory } from './labels.js';
import { PLACE_RETRY_BASE_MS, PLACE_RETRY_CAP_MS, createSpaceManager } from './manager.js';
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
    expect(await manager.listSpaces({ placeId: 'memory' })).toEqual([{ ...listedFields, state: 'running', stoppedIdle: false, gatekeeperRunning: true, orphans: [], damaged: false, missing: [] }]);
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

describe('createSpaceManager: more than one place', () => {
  const twoPlaces = ({ locate, recall, second = createMemoryPlace({ id: 'remote' }), now = () => NOW } = {}) => {
    const first = createMemoryPlace();
    const registry = createPlaceRegistry([first, second]);
    return { first, second, manager: createSpaceManager({ registry, locate, recall, now }) };
  };

  it('sends a space\'s operations to the place its record names, and never asks the other', async () => {
    const asked = [];
    const { first, second, manager } = twoPlaces({ locate: async (spaceId) => (spaceId === 'a1b2c3d4e5f6' ? 'remote' : null) });
    first.list = async () => { asked.push('first'); return []; };
    await second.create({ id: 'a1b2c3d4e5f6', name: 'Remote', project: 'p', created: '', memoryBytes: 1 });
    expect((await manager.placeOf('a1b2c3d4e5f6')).id).toBe('remote');
    expect(await manager.exec('a1b2c3d4e5f6', ['cat', '/etc/hostname'])).toMatchObject({ code: 0 });
    await manager.stopSpace({ spaceId: 'a1b2c3d4e5f6' });
    expect((await manager.listSpaces({ placeId: 'remote' }))[0].state).toBe('exited');
    await manager.startSpace({ spaceId: 'a1b2c3d4e5f6' });
    expect(await manager.verify('a1b2c3d4e5f6')).toEqual([]);
    expect(await manager.removeSpace({ spaceId: 'a1b2c3d4e5f6' })).toEqual({ removed: expect.any(Array), failed: [] });
    expect(asked).toEqual([]);
  });

  it('finds a space without a record on the place that lists it, and names a space no place lists', async () => {
    const { second, manager } = twoPlaces();
    await second.create({ id: 'a1b2c3d4e5f6', name: 'Remote', project: 'p', created: '', memoryBytes: 1 });
    expect((await manager.placeOf('a1b2c3d4e5f6')).id).toBe('remote');
    await expect(manager.placeOf('0f0f0f0f0f0f')).rejects.toMatchObject({ code: 'space_not_found' });
    await expect(manager.exec('not-an-id', ['true'])).rejects.toMatchObject({ code: 'invalid_space_id' });
  });

  it('does not call a space gone when a place could not be asked about it', async () => {
    const { second, manager } = twoPlaces();
    second.list = async () => { throw new SpaceError('place_unreachable', 'box did not answer'); };
    await expect(manager.placeOf('a1b2c3d4e5f6')).rejects.toMatchObject({ code: 'place_unreachable' });
  });

  it('lists every place\'s spaces, and the remembered spaces of a place that cannot be asked as unreachable', async () => {
    const remembered = { id: 'a1b2c3d4e5f6', name: 'On the box', project: 'p', created: '2026-10-11T10:00:00.000Z' };
    const { first, second, manager } = twoPlaces({ recall: async () => [{ placeId: 'remote', ...remembered }] });
    await first.create({ id: 'b1b2c3d4e5f6', name: 'Local', project: 'p', created: '', memoryBytes: 1 });
    const failure = new SpaceError('place_unreachable', 'box did not answer');
    second.list = async () => { throw failure; };

    const listed = await manager.listAllSpaces();
    expect(listed.spaces.map(({ id, placeId, state }) => [id, placeId, state])).toEqual([['b1b2c3d4e5f6', 'memory', 'running'], ['a1b2c3d4e5f6', 'remote', 'unreachable']]);
    expect(listed.spaces[1]).toEqual({ placeId: 'remote', ...remembered, state: 'unreachable', stoppedIdle: false, gatekeeperRunning: false, orphans: [], damaged: false, missing: [] });
    expect(listed.unavailable).toEqual([{ placeId: 'remote', failure }]);
  });

  it('lists nothing as unreachable while every place answers', async () => {
    const { manager } = twoPlaces({ recall: async () => [{ placeId: 'remote', id: 'a1b2c3d4e5f6', name: 'Stale', project: 'p', created: '' }] });
    expect(await manager.listAllSpaces()).toEqual({ spaces: [], unavailable: [] });
  });

  it('leaves a place that failed alone for a pause that doubles, and asks it again after it', async () => {
    let clock = NOW.getTime();
    let asked = 0;
    const failure = new SpaceError('place_unreachable', 'box did not answer');
    const { second, manager } = twoPlaces({ now: () => new Date(clock) });
    const answer = second.list;
    second.list = async () => { asked += 1; throw failure; };

    expect((await manager.listAllSpaces()).unavailable).toEqual([{ placeId: 'remote', failure }]);
    expect(asked).toBe(1);
    // Within the pause the same answer stands without a call, for the list and for a space's place alike.
    for (let i = 0; i < 5; i += 1) expect((await manager.listAllSpaces()).unavailable).toEqual([{ placeId: 'remote', failure }]);
    await expect(manager.placeOf('a1b2c3d4e5f6')).rejects.toBe(failure);
    expect(asked).toBe(1);
    // After the first pause one more attempt, and the next pause is twice as long.
    clock += PLACE_RETRY_BASE_MS;
    await manager.listAllSpaces();
    expect(asked).toBe(2);
    clock += PLACE_RETRY_BASE_MS;
    await manager.listAllSpaces();
    expect(asked).toBe(2);
    clock += PLACE_RETRY_BASE_MS;
    await manager.listAllSpaces();
    expect(asked).toBe(3);
    // The pause never grows past the cap.
    for (let i = 0; i < 10; i += 1) { clock += PLACE_RETRY_CAP_MS; await manager.listAllSpaces(); }
    expect(asked).toBe(13);
    // The place answers again: listed from itself, and a later failure starts a short pause again.
    clock += PLACE_RETRY_CAP_MS;
    second.list = answer;
    expect(await manager.listAllSpaces()).toEqual({ spaces: [], unavailable: [] });
    second.list = async () => { asked += 1; throw failure; };
    await manager.listAllSpaces();
    clock += PLACE_RETRY_BASE_MS;
    await manager.listAllSpaces();
    expect(asked).toBe(15);
  });

  it('lists the remembered spaces of a place the registry no longer has as unreachable, with the place not found', async () => {
    const { manager } = twoPlaces({ recall: async () => [{ placeId: 'cluster', id: 'a1b2c3d4e5f6', name: 'Elsewhere', project: 'p', created: '' }] });
    const listed = await manager.listAllSpaces();
    expect(listed.spaces).toEqual([{ placeId: 'cluster', id: 'a1b2c3d4e5f6', name: 'Elsewhere', project: 'p', created: '', state: 'unreachable', stoppedIdle: false, gatekeeperRunning: false, orphans: [], damaged: false, missing: [] }]);
    expect(listed.unavailable).toEqual([{ placeId: 'cluster', failure: expect.objectContaining({ code: 'place_not_found' }) }]);
    await expect(manager.removeSpace({ spaceId: 'a1b2c3d4e5f6' })).rejects.toMatchObject({ code: 'space_not_found' });
    // A record that names the vanished place is the answer, and no other place is searched for the space.
    const { manager: located, first } = twoPlaces({ locate: async () => 'cluster' });
    await first.create({ id: 'a1b2c3d4e5f6', name: 'Same id elsewhere', project: 'p', created: '', memoryBytes: 1 });
    await expect(located.removeSpace({ spaceId: 'a1b2c3d4e5f6' })).rejects.toMatchObject({ code: 'place_not_found' });
    expect((await first.list()).map((space) => space.id)).toEqual(['a1b2c3d4e5f6']);
  });
});
