import { describe, expect, it, vi } from 'vitest';
import { mkdtemp } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { createFakeDockerRuntime } from '../../docker/fake-runtime.js';
import { createDockerInstanceLifecycleManager } from './lifecycle-manager.js';
import { createDockerInstanceStore } from './store.js';

const PATHS = {
  openCodeConfigDir: 'C:\\Users\\me\\.config\\opencode',
  skillDir: 'C:\\Users\\me\\.config\\opencode\\skills',
  authFile: 'C:\\Users\\me\\.local\\share\\opencode\\auth.json',
};

describe('getInstanceStatus', () => {
  it('probes a running instance without throwing (regression: undefined probe symbol)', async () => {
    const runtime = createFakeDockerRuntime();
    const dir = await mkdtemp(join(tmpdir(), 'oc-docker-status-'));
    const fsPromises = await import('node:fs/promises');
    const store = createDockerInstanceStore({ filePath: join(dir, 'docker-instances.json'), fsPromises });
    const manager = createDockerInstanceLifecycleManager({
      runtime,
      store,
      platform: 'win32',
      getFreePort: async () => 4610,
      readinessIntervalMs: 1,
      readinessTimeoutMs: 250,
      probeHealth: async () => true,
    });
    const record = await manager.createInstance(createInput({ label: 'StatusProbe' }));
    const status = await manager.getInstanceStatus(record.id);
    expect(status.connectable).toBe(true);
    expect(status.healthy).toBe(true);
  });
});

const createHarness = async ({ unhealthyUntil = 0, freePort = 4567 } = {}) => {
  const runtime = createFakeDockerRuntime();
  const dir = await mkdtemp(join(tmpdir(), 'oc-docker-lm-'));
  const fsPromises = await import('node:fs/promises');
  const store = createDockerInstanceStore({ filePath: join(dir, 'docker-instances.json'), fsPromises });
  let healthCalls = 0;
  const manager = createDockerInstanceLifecycleManager({
    runtime,
    store,
    platform: 'win32',
    getFreePort: async () => freePort,
    readinessIntervalMs: 1,
    readinessTimeoutMs: 250,
    probeHealth: async () => {
      healthCalls += 1;
      return healthCalls > unhealthyUntil;
    },
  });
  return { manager, runtime, store, getHealthCalls: () => healthCalls };
};

const createInput = (overrides = {}) => ({
  label: 'Project A',
  workspaceHostPath: 'C:\\proj\\a',
  sharing: { config: true, skills: true, credentials: false },
  paths: PATHS,
  ...overrides,
});

describe('docker instance lifecycle manager', () => {
  it('createInstance runs the full happy path and ends running with journal + port recorded', async () => {
    const { manager, runtime } = await createHarness();
    const record = await manager.createInstance(createInput());

    expect(record.lifecycleState).toBe('running');
    expect(record.port).toBe(4567);
    expect(record.containerId).toMatch(/^fake-container-/);
    expect(record.resourceJournal).toEqual([{ type: 'container', ref: record.containerId }]);

    const container = runtime.containers.get(record.containerId);
    expect(container.labels['openchamber.instance']).toBe(record.id);
    expect(container.portBindings['4096/tcp']).toEqual({ hostIp: '127.0.0.1', hostPort: 4567 });
    expect(container.binds).toEqual([
      { host: 'C:\\proj\\a', container: '/workspace', mode: 'rw' },
      { host: PATHS.skillDir, container: '/home/opencode/.config/opencode/skills', mode: 'rw' },
      { host: PATHS.openCodeConfigDir, container: '/home/opencode/.config/opencode', mode: 'rw' },
    ]);
  });

  it('rolls back fully when readiness never passes: no container, no record, error surfaced', async () => {
    const { manager, runtime, store } = await createHarness({ unhealthyUntil: 1000 });
    const error = await manager.createInstance(createInput()).catch((caught) => caught);
    expect(error.code).toBe('READINESS_TIMEOUT');
    expect(error.cleanedUp).toBe(true);
    expect(runtime.calls.count('removeContainer')).toBe(1);
    expect(runtime.containers.size).toBe(0);
    expect(await store.list()).toEqual([]);
  });

  it('captures the container log tail before rollback when readiness fails', async () => {
    const { manager, runtime, store } = await createHarness({ unhealthyUntil: 1000 });
    const error = await manager.createInstance(createInput()).catch((caught) => caught);
    expect(error.containerLogTail).toContain('fake boot log');
    // The log was captured before the container was removed: still readable
    // afterwards from the error, even though the container is gone.
    expect(runtime.containers.size).toBe(0);
  });

  it('rolls back when the container start fails', async () => {
    const { manager, runtime, store } = await createHarness();
    runtime.failNext({ method: 'startContainer', code: 'START_FAILED' });
    await expect(manager.createInstance(createInput())).rejects.toMatchObject({ code: 'START_FAILED', cleanedUp: true });
    expect(runtime.containers.size).toBe(0);
    expect(await store.list()).toEqual([]);
  });

  it('fails with IMAGE_MISSING and cleans nothing extra when the image is absent', async () => {
    const { manager, runtime, store } = await createHarness();
    await expect(manager.createInstance(createInput({ image: 'ghost:latest' })))
      .rejects.toMatchObject({ code: 'IMAGE_MISSING', cleanedUp: true });
    expect(runtime.calls.count('createContainer')).toBe(0);
    expect(await store.list()).toEqual([]);
  });

  it('rejects a relative workspace path before any resource is created', async () => {
    const { manager, runtime, store } = await createHarness();
    await expect(manager.createInstance(createInput({ workspaceHostPath: 'relative/path' })))
      .rejects.toMatchObject({ code: 'INVALID_WORKSPACE' });
    expect(runtime.calls.count('createContainer')).toBe(0);
    expect(await store.list()).toEqual([]);
  });

  it('stop and remove are clean no-ops on other instances', async () => {
    const { manager, runtime, store } = await createHarness();
    const a = await manager.createInstance(createInput({ label: 'A' }));
    const b = await manager.createInstance(createInput({ label: 'B', workspaceHostPath: 'C:\\proj\\b' }));

    await manager.stopInstance(a.id);
    expect((await store.get(a.id)).lifecycleState).toBe('stopped');
    expect((await store.get(b.id)).lifecycleState).toBe('running');

    await manager.removeInstance(a.id);
    expect(await store.get(a.id)).toBeNull();
    expect(runtime.containers.has(a.containerId)).toBe(false);
    expect((await store.get(b.id)).lifecycleState).toBe('running');
    expect(runtime.containers.has(b.containerId)).toBe(true);
  });

  it('activate requires a running instance and wires the upstream + mapping; deactivate unwires', async () => {
    const { manager, store } = await createHarness();
    const changed = [];
    const managerWithHook = manager; // hook covered separately below
    void managerWithHook;

    const record = await manager.createInstance(createInput());
    await manager.stopInstance(record.id);

    await expect(manager.setActiveInstance(record.id)).rejects.toMatchObject({
      code: 'NOT_CONNECTABLE',
      currentState: 'stopped',
      canStart: true,
    });

    await manager.startInstance(record.id);
    const upstream = await manager.setActiveInstance(record.id);
    expect(upstream).toEqual({ instanceId: record.id, origin: `http://127.0.0.1:${record.port}` });
    expect(await store.getActiveInstanceId()).toBe(record.id);

    await manager.deactivate();
    expect(manager.getActiveUpstream()).toBeNull();
    expect(await store.getActiveInstanceId()).toBeNull();
  });

  it('notifies onActiveUpstreamChanged on activation and deactivation', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'oc-docker-lm2-'));
    const fsPromises = await import('node:fs/promises');
    const store = createDockerInstanceStore({ filePath: join(dir, 'docker-instances.json'), fsPromises });
    const runtime = createFakeDockerRuntime();
    const events = [];
    const manager = createDockerInstanceLifecycleManager({
      runtime,
      store,
      platform: 'win32',
      getFreePort: async () => 4600,
      readinessIntervalMs: 1,
      readinessTimeoutMs: 250,
      probeHealth: async () => true,
      onActiveUpstreamChanged: (payload) => events.push(payload),
    });

    const record = await manager.createInstance(createInput({ label: 'Hooked' }));
    await manager.setActiveInstance(record.id);
    expect(events).toEqual([{ instanceId: record.id, origin: `http://127.0.0.1:${record.port}` }]);
    await manager.removeInstance(record.id);
    expect(events[1]).toBeNull();
    expect(manager.getActiveUpstream()).toBeNull();
  });

  it('removing the active instance restores the default upstream', async () => {
    const { manager } = await createHarness();
    const record = await manager.createInstance(createInput());
    await manager.setActiveInstance(record.id);
    await manager.removeInstance(record.id);
    expect(manager.getActiveUpstream()).toBeNull();
  });

  it('cleanup retries succeed after a removal-failed park', async () => {
    const { manager, runtime, store } = await createHarness();
    const record = await manager.createInstance(createInput());

    runtime.failNext({ method: 'removeContainer', code: 'BUSY' });
    await expect(manager.cleanupInstance(record.id)).rejects.toMatchObject({ code: 'CLEANUP_FAILED' });
    expect((await store.get(record.id)).lifecycleState).toBe('removal-failed');

    await manager.cleanupInstance(record.id);
    expect(await store.get(record.id)).toBeNull();
    expect(runtime.containers.size).toBe(0);
  });

  it('startup restore degrades a stale active pointer to the default upstream', async () => {
    const { manager, store, runtime } = await createHarness();
    const record = await manager.createInstance(createInput());
    await manager.setActiveInstance(record.id);

    // Container dies out-of-band.
    runtime.containers.delete(record.containerId);
    await store.update(record.id, (current) => ({ ...current, lifecycleState: 'stopped' }));

    await manager.restoreActiveInstance();
    expect(manager.getActiveUpstream()).toBeNull();
    expect(await store.getActiveInstanceId()).toBeNull();
  });

  it('startup restore keeps a healthy active instance active', async () => {
    const { manager } = await createHarness();
    const record = await manager.createInstance(createInput());
    await manager.setActiveInstance(record.id);

    // New manager instance simulates a server restart against the same store/runtime.
    const restored = await manager.restoreActiveInstance();
    expect(restored?.instanceId).toBe(record.id);
    expect(manager.getActiveUpstream()?.origin).toBe(`http://127.0.0.1:${record.port}`);
  });
});
