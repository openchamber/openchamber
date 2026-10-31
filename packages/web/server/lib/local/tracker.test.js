import { beforeEach, describe, expect, it } from 'vitest';
import fs from 'fs';
import os from 'os';
import path from 'path';
import { createLocalTracker, LOCAL_TRACKER_DESCRIPTOR } from './tracker.js';

let root;
beforeEach(() => { root = fs.mkdtempSync(path.join(os.tmpdir(), 'oc-track-')); });
const tracker = () => createLocalTracker({ listProjects: async () => [{ id: 'p1', path: root, label: 'P1' }] });

describe('descriptor', () => {
  it('is frozen and declares create/edit', () => {
    expect(Object.isFrozen(LOCAL_TRACKER_DESCRIPTOR)).toBe(true);
    expect(LOCAL_TRACKER_DESCRIPTOR.id).toBe('local');
    expect(LOCAL_TRACKER_DESCRIPTOR.capabilities.create).toBe(true);
    expect(LOCAL_TRACKER_DESCRIPTOR.capabilities.edit).toBe(true);
    expect(LOCAL_TRACKER_DESCRIPTOR.authMethods).toEqual([]);
  });
});

describe('auth', () => {
  it('is always connected as Local', async () => {
    const t = await tracker();
    expect(await t.auth.status()).toEqual({ connected: true, account: { id: 'local', name: 'Local', user: null, current: true } });
    await expect(t.auth.start()).rejects.toThrow();
  });
});

describe('list/get/create/edit/updateState', () => {
  it('creates, lists, gets with description and comments, edits, moves state', async () => {
    const t = await tracker();
    const { item } = await t.create({ containerId: 'p1', title: 'First', description: 'Body', priority: 'high', labels: ['bug'] });
    expect(item.identifier).toBe('LOCAL-1');
    expect(item.url).toBe('https://openchamber.local/tracker/local/LOCAL-1');
    expect(item.container).toEqual({ id: 'p1', key: null, name: 'P1' });
    expect(item.priority).toBe('high');
    const listed = await t.list({ state: 'open' });
    expect(listed).toMatchObject({ connected: true, hasMore: false, cursor: null });
    expect(listed.items).toHaveLength(1);
    const detail = await t.get('LOCAL-1');
    expect(detail.item.description).toBe('Body');
    const edited = await t.edit({ id: 'LOCAL-1', title: 'Renamed', labels: ['a', 'b'] });
    expect(edited.item.title).toBe('Renamed');
    expect(edited.item.labels.map((l) => l.name)).toEqual(['a', 'b']);
    const moved = await t.updateState({ id: 'LOCAL-1', stateId: 'done' });
    expect(moved.item.state.category).toBe('done');
    const empty = await t.get('LOCAL-99');
    expect(empty).toEqual({ connected: true, item: null });
  });
  it('returns connected:false-shaped UNSUPPORTED errors as user errors', async () => {
    const t = await tracker();
    await expect(t.create({ containerId: 'unknown', title: 'x' })).rejects.toThrow();
  });
});

describe('states and matchUrl', () => {
  it('returns the six fixed states with positions', async () => {
    const t = await tracker();
    const { states } = await t.states('p1');
    expect(states.map((s) => s.id)).toEqual(['triage', 'backlog', 'todo', 'in-progress', 'done', 'canceled']);
    expect(states.map((s) => s.position)).toEqual([0, 1, 2, 3, 4, 5]);
  });
  it('matches issue URLs like the Linear rules', async () => {
    const t = await tracker();
    expect(t.matchUrl('https://openchamber.local/tracker/local/LOCAL-3')).toBe('LOCAL-3');
    expect(t.matchUrl('http://www.openchamber.local/tracker/local/LOCAL-3/')).toBe('LOCAL-3');
    expect(t.matchUrl('https://evil.example/tracker/local/LOCAL-3')).toBeNull();
  });
});
