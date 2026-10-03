import { describe, expect, test } from 'bun:test';
import type { HostClient, JsonValue } from '../src/index';
import { loadTasks, saveTask, TASKS } from '../examples/tasks-demo/panel/tasks';

const fixture = () => {
  const values = new Map<string, JsonValue>();
  const storage: HostClient['storage'] = {
    get: async (key) => values.get(key),
    set: async (key, value) => { values.set(key, structuredClone(value)); },
    delete: async (key) => { values.delete(key); },
    keys: async () => [...values.keys()],
  };
  return { storage, values };
};

describe('Task Board persistence', () => {
  test('editing one sample retains the other tasks and custom tasks survive reload', async () => {
    const host = fixture();
    await saveTask(host, { ...TASKS[0], title: 'My edited task' });
    await saveTask(host, { ...TASKS[1], id: 'TASK-custom', title: 'My new task' });
    const loaded = await loadTasks(host);
    expect(loaded.tasks.length).toBe(TASKS.length + 1);
    expect(loaded.tasks.find((task) => task.id === TASKS[0].id)?.title).toBe('My edited task');
    expect(loaded.tasks.find((task) => task.id === 'TASK-custom')?.title).toBe('My new task');
    expect(loaded.failedKeys).toEqual([]);
  });

  test('deleting a sample persists without deleting its linked sessions', async () => {
    const host = fixture();
    await saveTask(host, { ...TASKS[0], deleted: true, sessions: [{ id: 'session', projectId: 'project' }] });
    const loaded = await loadTasks(host);
    expect(loaded.tasks.some((task) => task.id === TASKS[0].id)).toBe(false);
    expect(host.values.has(`task:${TASKS[0].id}`)).toBe(true);
  });

  test('corrupt records cannot hide unrelated tasks or replace a saved task with its sample', async () => {
    const host = fixture();
    host.values.set(`task:${TASKS[0].id}`, { invalid: true });
    await saveTask(host, { ...TASKS[1], title: 'Still available' });
    const loaded = await loadTasks(host);
    expect(loaded.failedKeys).toEqual([`task:${TASKS[0].id}`]);
    expect(loaded.tasks.some((task) => task.id === TASKS[0].id)).toBe(false);
    expect(loaded.tasks.find((task) => task.id === TASKS[1].id)?.title).toBe('Still available');
  });

  test('an index failure is not an empty board', async () => {
    const host = fixture();
    host.storage.keys = async () => { throw new Error('Offline'); };
    await expect(loadTasks(host)).rejects.toThrow('Offline');
  });

  test('invalid task edits do not overwrite the saved record', async () => {
    const host = fixture();
    await saveTask(host, TASKS[0]);
    const before = host.values.get(`task:${TASKS[0].id}`);
    await expect(saveTask(host, { ...TASKS[0], title: '' })).rejects.toThrow();
    expect(host.values.get(`task:${TASKS[0].id}`)).toEqual(before);
  });

  test('a larger board keeps at most sixteen record reads in flight', async () => {
    const host = fixture();
    for (let index = 0; index < 40; index++) await saveTask(host, { ...TASKS[0], id: `TASK-${index}` });
    const get = host.storage.get; let active = 0; let peak = 0;
    host.storage.get = async (key) => {
      active++; peak = Math.max(peak, active);
      await Promise.resolve();
      try { return await get(key); } finally { active--; }
    };
    const loaded = await loadTasks(host);
    expect(loaded.tasks.length).toBe(44);
    expect(peak).toBe(16);
  });
});
