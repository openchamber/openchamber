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

    it('treats removing a missing space as done', async () => {
      expect(await place.remove(spec.id)).toEqual({ removed: [], failed: [] });
    });
  });
}
