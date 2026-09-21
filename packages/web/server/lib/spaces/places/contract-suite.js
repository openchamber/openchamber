// The contract every place must pass. Stage 8 to 10 places run this same suite.
// `setup` resolves `{ place, dispose }`. `dispose` cleans up and may assert that nothing is left.

import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { createSpaceId, hashProjectDirectory } from '../labels.js';
import { REQUIRED_PLACE_METHODS } from './registry.js';

const CREATE_TIMEOUT_MS = 25 * 60_000;

export function runPlaceContractSuite(title, { enabled = true, setup }) {
  describe.skipIf(!enabled)(`place contract: ${title}`, () => {
    const spec = {
      id: createSpaceId(),
      name: 'Contract suite, a=b',
      project: hashProjectDirectory('/contract/suite/project'),
      created: new Date().toISOString(),
      memoryBytes: 512 * 1024 * 1024,
    };
    let place;
    let dispose = async () => {};

    const listed = async () => (await place.list()).find((space) => space.id === spec.id);

    beforeAll(async () => {
      ({ place, dispose } = await setup());
    });

    afterAll(async () => {
      await dispose();
    });

    it('has an id and every operation', () => {
      expect(place.id).toMatch(/\S/);
      for (const method of REQUIRED_PLACE_METHODS) {
        expect(place[method]).toBeInstanceOf(Function);
      }
    });

    it('is available', async () => {
      expect(await place.check()).toMatchObject({ available: true });
    });

    it('creates a space that verifies clean', async () => {
      await place.create(spec);
      expect(await place.verify(spec.id)).toEqual([]);
    }, CREATE_TIMEOUT_MS);

    it('lists the space as running, with what it was created with', async () => {
      const { id, name, project, created } = spec;
      expect(await listed()).toEqual({ id, name, project, created, state: 'running', orphans: [], damaged: false, missing: [] });
    });

    it('refuses to create the same space again, and leaves it alone', async () => {
      await expect(place.create(spec)).rejects.toMatchObject({ code: 'space_name_taken' });
      expect(await listed()).toMatchObject({ state: 'running' });
    });

    it('runs commands as uid 1000', async () => {
      const result = await place.exec(spec.id, ['id', '-u']);
      expect(result).toMatchObject({ code: 0, stdout: '1000\n' });
    });

    // Added in stage 2. From here on a place cannot host a space without a gatekeeper, so this
    // is part of the contract every later place is held to. Nothing that was here changed.
    it('runs a command in the gatekeeper, which is a container of its own', async () => {
      // Two containers, not one target answering for both: a hostname is per container.
      const space = await place.exec(spec.id, ['cat', '/etc/hostname']);
      const gatekeeper = await place.exec(spec.id, ['cat', '/etc/hostname'], { target: 'gatekeeper' });
      expect(space).toMatchObject({ code: 0 });
      expect(gatekeeper).toMatchObject({ code: 0 });
      expect(space.stdout.trim()).not.toBe('');
      expect(gatekeeper.stdout.trim()).not.toBe('');
      expect(gatekeeper.stdout.trim()).not.toBe(space.stdout.trim());

      // And it is not the space: the space's work directory is not in it.
      const work = `/spaces/${spec.id}`;
      expect(await place.exec(spec.id, ['test', '-d', work])).toMatchObject({ code: 0 });
      expect((await place.exec(spec.id, ['test', '-d', work], { target: 'gatekeeper' })).code).not.toBe(0);
      expect(await place.exec(spec.id, ['id', '-u'], { target: 'gatekeeper' })).toMatchObject({ code: 0, stdout: '1000\n' });
    });

    // Added in stage 2. The place contract names two targets, and a place that quietly took a
    // third would be running commands somewhere this suite never looks.
    it('knows the two exec targets and no others', async () => {
      for (const target of ['setup', 'host', '', 'space-old']) {
        await expect(place.exec(spec.id, ['id', '-u'], { target })).rejects.toMatchObject({ code: 'invalid_exec_target' });
      }
    });

    it('stops the space and lists it as exited', async () => {
      await place.stop(spec.id);
      expect(await listed()).toMatchObject({ state: 'exited' });
    });

    it('starts the space again', async () => {
      await place.start(spec.id);
      expect(await listed()).toMatchObject({ state: 'running' });
      expect(await place.verify(spec.id)).toEqual([]);
    });

    it('removes the space and leaves no labelled resource behind', async () => {
      const result = await place.remove(spec.id);
      expect(result.failed).toEqual([]);
      // `list` also reports orphaned networks and volumes, so an absent id means nothing is left.
      expect(await listed()).toBeUndefined();
    });

    // Added in stage 2, for the same reason as the gatekeeper exec above. The test before this
    // one ran a command in the gatekeeper, so this failure is the removal and nothing else.
    // A place that removed the space and left its gatekeeper running would still answer here.
    it('removes the gatekeeper with the space', async () => {
      await expect(place.exec(spec.id, ['cat', '/etc/hostname'], { target: 'gatekeeper' })).rejects.toThrow();
      await expect(place.exec(spec.id, ['cat', '/etc/hostname'])).rejects.toThrow();
    });

    it('treats removing a missing space as done', async () => {
      expect(await place.remove(spec.id)).toEqual({ removed: [], failed: [] });
    });
  });
}
