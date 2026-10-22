import { describe, expect, it, vi } from 'vitest';

import { LINEAR_TRACKER_DESCRIPTOR } from '../linear/tracker.js';
import { BUILT_IN_TRACKERS, createTrackerRegistry } from './registry.js';

const descriptorFor = (id) => ({ ...structuredClone(LINEAR_TRACKER_DESCRIPTOR), id, name: id });
const entryFor = (id, load = async () => ({ id })) => ({ descriptor: descriptorFor(id), load });

describe('createTrackerRegistry', () => {
  it('serves the built-in Linear descriptor as plain JSON', () => {
    const registry = createTrackerRegistry();
    expect(registry.list()).toEqual(['linear']);
    expect(registry.has('linear')).toBe(true);
    expect(JSON.parse(JSON.stringify(registry.descriptors()))).toEqual([LINEAR_TRACKER_DESCRIPTOR]);
    expect(BUILT_IN_TRACKERS.map((entry) => entry.descriptor.id)).toEqual(['linear']);
  });

  it('answers null for an unknown id', async () => {
    const registry = createTrackerRegistry([entryFor('jira')], { foreignIds: [] });
    expect(registry.has('nope')).toBe(false);
    expect(registry.descriptor('nope')).toBeNull();
    expect(await registry.implementation('nope')).toBeNull();
    // Object prototype names are not ids.
    expect(registry.descriptor('constructor')).toBeNull();
  });

  it('refuses reserved, malformed, duplicate and source-control ids', () => {
    for (const id of ['guest', 'link', 'external', 'repository']) {
      expect(() => createTrackerRegistry([entryFor(id)], { foreignIds: [] })).toThrow(/reserved/);
    }
    for (const id of ['', 'Linear', '1linear', 'a'.repeat(33), 'with space', undefined]) {
      expect(() => createTrackerRegistry([entryFor(id)], { foreignIds: [] })).toThrow(/malformed/);
    }
    expect(() => createTrackerRegistry([entryFor('jira'), entryFor('jira')], { foreignIds: [] })).toThrow(/duplicate/);
    expect(() => createTrackerRegistry([entryFor('gitlab')], { foreignIds: ['gitlab'] })).toThrow(/source-control/);
    expect(() => createTrackerRegistry([{ descriptor: descriptorFor('jira') }], { foreignIds: [] })).toThrow(/loader/);
  });

  it('refuses the built-in source-control ids by default', () => {
    expect(() => createTrackerRegistry([entryFor('github')])).toThrow(/source-control/);
    expect(() => createTrackerRegistry([entryFor('gitlab')])).toThrow(/source-control/);
  });

  it('loads an implementation once, also under concurrent requests', async () => {
    const load = vi.fn(async () => ({ name: 'impl' }));
    const registry = createTrackerRegistry([entryFor('jira', load)], { foreignIds: [] });
    expect(load).not.toHaveBeenCalled();
    const [first, second] = await Promise.all([registry.implementation('jira'), registry.implementation('jira')]);
    const third = await registry.implementation('jira');
    expect(first).toBe(second);
    expect(third).toBe(first);
    expect(load).toHaveBeenCalledTimes(1);
  });

  it('tries a failed load again on the next request', async () => {
    const load = vi.fn()
      .mockRejectedValueOnce(new Error('boom'))
      .mockResolvedValueOnce({ name: 'impl' });
    const registry = createTrackerRegistry([entryFor('jira', load)], { foreignIds: [] });
    await expect(registry.implementation('jira')).rejects.toThrow('boom');
    await expect(registry.implementation('jira')).resolves.toEqual({ name: 'impl' });
    expect(load).toHaveBeenCalledTimes(2);
  });

  it('keeps descriptors in registration order and out of reach of the module that registered them', () => {
    const jira = entryFor('jira');
    const registry = createTrackerRegistry([jira, entryFor('youtrack')], { foreignIds: [] });
    expect(registry.list()).toEqual(['jira', 'youtrack']);
    jira.descriptor.name = 'changed';
    expect(registry.descriptor('jira').name).toBe('jira');
    expect(Object.isFrozen(registry.descriptor('jira').capabilities.filters)).toBe(true);
  });

  it('loads the real Linear implementation lazily', async () => {
    const registry = createTrackerRegistry();
    const linear = await registry.implementation('linear');
    expect(linear.list).toBeInstanceOf(Function);
    expect(linear.sessionStatus.createRuntime).toBeInstanceOf(Function);
    expect(linear.matchUrl('https://linear.app/acme/issue/eng-12/title')).toBe('ENG-12');
    expect(linear.hostAccess.apiOrigin).toBe('https://api.linear.app');
  });
});
