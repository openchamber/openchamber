import { describe, expect, it } from 'vitest';

import { REQUIRED_PLACE_METHODS, createPlaceRegistry } from './registry.js';

const createPlace = (id) => ({
  id,
  ...Object.fromEntries(REQUIRED_PLACE_METHODS.map((method) => [method, async () => null])),
});

describe('createPlaceRegistry', () => {
  it('registers places and finds them by id, ignoring case and spaces', () => {
    const docker = createPlace('docker');
    const registry = createPlaceRegistry([docker]);

    expect(registry.get(' Docker ')).toBe(docker);
    expect(registry.list()).toEqual([docker]);
  });

  it('returns null for an unknown or missing id', () => {
    const registry = createPlaceRegistry([createPlace('docker')]);

    expect(registry.get('cluster')).toBeNull();
    expect(registry.get(undefined)).toBeNull();
  });

  it('rejects a place without an id', () => {
    expect(() => createPlaceRegistry([createPlace('  ')])).toThrow('non-empty id');
    expect(() => createPlaceRegistry([null])).toThrow('non-empty id');
  });

  it.each(REQUIRED_PLACE_METHODS)('rejects a place without %s()', (method) => {
    const place = createPlace('docker');
    delete place[method];

    expect(() => createPlaceRegistry([place])).toThrow(`must implement ${method}()`);
  });

  it('rejects a second place with the same id', () => {
    const registry = createPlaceRegistry([createPlace('docker')]);

    expect(() => registry.register(createPlace('DOCKER'))).toThrow('already registered');
  });

  it('accepts nothing after it is sealed', () => {
    const registry = createPlaceRegistry();
    registry.seal();

    expect(() => registry.register(createPlace('docker'))).toThrow('sealed');
  });
});
