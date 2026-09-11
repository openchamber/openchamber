import { describe, expect, it, vi } from 'vitest';
import { mkdtemp } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { createDockerInstanceStore } from './store.js';

const makeStore = async () => {
  const dir = await mkdtemp(join(tmpdir(), 'oc-docker-store-'));
  const fsPromises = await import('node:fs/promises');
  const store = createDockerInstanceStore({ filePath: join(dir, 'docker-instances.json'), fsPromises });
  return { store, dir, fsPromises };
};

const sampleRecord = (overrides = {}) => ({
  id: 'docker-abc',
  label: 'Project A',
  image: 'opencode-instance:local',
  containerId: null,
  containerName: 'openchamber-opencode-docker-abc',
  port: null,
  workspaceHostPath: 'C:\\proj\\a',
  workspaceContainerPath: '/workspace',
  mappingRules: [{ hostPrefix: 'C:\\proj\\a', remotePrefix: '/workspace' }],
  sharing: { config: true, skills: true, credentials: false, skillsHostDir: null },
  lifecycleState: 'creating',
  lastError: null,
  resourceJournal: [],
  ...overrides,
});

describe('createDockerInstanceStore', () => {
  it('persists records across store instances and isolates them per id', async () => {
    const { store, dir, fsPromises } = await makeStore();
    await store.upsert(sampleRecord());
    await store.upsert(sampleRecord({ id: 'docker-def', label: 'B' }));

    const reopened = createDockerInstanceStore({
      filePath: join(dir, 'docker-instances.json'),
      fsPromises,
    });
    const list = await reopened.list();
    expect(list.map((entry) => entry.id)).toEqual(['docker-abc', 'docker-def']);

    const one = await reopened.get('docker-abc');
    expect(one.label).toBe('Project A');
    expect(one.mappingRules).toEqual([{ hostPrefix: 'C:\\proj\\a', remotePrefix: '/workspace' }]);
  });

  it('update patches a record and returns the normalized result', async () => {
    const { store } = await makeStore();
    await store.upsert(sampleRecord());
    const updated = await store.update('docker-abc', (current) => ({
      ...current,
      containerId: 'cid-1',
      port: 4567,
      lifecycleState: 'running',
      resourceJournal: [{ type: 'container', ref: 'cid-1' }],
    }));
    expect(updated.lifecycleState).toBe('running');
    expect((await store.get('docker-abc')).containerId).toBe('cid-1');
  });

  it('remove deletes the record and clears an active pointer', async () => {
    const { store } = await makeStore();
    await store.upsert(sampleRecord());
    await store.setActiveInstanceId('docker-abc');
    expect(await store.getActiveInstanceId()).toBe('docker-abc');

    await expect(store.remove('docker-xyz')).resolves.toBe(false);
    await store.remove('docker-abc');
    expect(await store.get('docker-abc')).toBeNull();
    expect(await store.getActiveInstanceId()).toBeNull();
  });

  it('setActiveInstanceId rejects unknown ids', async () => {
    const { store } = await makeStore();
    await expect(store.setActiveInstanceId('ghost')).rejects.toThrow(/Unknown docker instance/);
    await expect(store.setActiveInstanceId(null)).resolves.toBeNull();
  });

  it('tolerates a corrupt registry file by starting clean instead of crashing', async () => {
    const { dir, fsPromises } = await makeStore();
    await fsPromises.writeFile(join(dir, 'docker-instances.json'), '{not json', 'utf8');
    const store = createDockerInstanceStore({
      filePath: join(dir, 'docker-instances.json'),
      fsPromises,
      logger: { warn: vi.fn() },
    });
    expect(await store.list()).toEqual([]);
    expect(await store.getActiveInstanceId()).toBeNull();
    // And it recovers for future writes.
    await store.upsert(sampleRecord());
    expect((await store.list()).length).toBe(1);
  });

  it('drops malformed records on load while keeping valid siblings', async () => {
    const { dir, fsPromises } = await makeStore();
    const payload = {
      version: 1,
      activeInstanceId: 'docker-good',
      instances: [
        { id: 'docker-good', workspaceHostPath: 'C:\\ok', lifecycleState: 'running', port: 4000 },
        { nope: true },
        { id: '', workspaceHostPath: 'x' },
        'garbage',
      ],
    };
    await fsPromises.writeFile(join(dir, 'docker-instances.json'), JSON.stringify(payload), 'utf8');
    const store = createDockerInstanceStore({ filePath: join(dir, 'docker-instances.json'), fsPromises });
    const list = await store.list();
    expect(list.map((entry) => entry.id)).toEqual(['docker-good']);
    expect((await store.get('docker-good')).lifecycleState).toBe('running');
    expect(await store.getActiveInstanceId()).toBe('docker-good');
  });
});
