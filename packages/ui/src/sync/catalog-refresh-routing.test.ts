import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import type { Project } from '@/lib/opencode/model';
import { opencodeClient } from '@/lib/opencode/client';
import { getRuntimeApiBaseUrl, getRuntimeKey, switchRuntimeEndpoint } from '@/lib/runtime-switch';
import { useAgentsStore } from '@/stores/useAgentsStore';
import { useConfigStore } from '@/stores/useConfigStore';
import { useProjectsStore } from '@/stores/useProjectsStore';
import { ChildStoreManager } from './child-store';
import { useGlobalSyncStore } from './global-sync-store';
import { createEventRoutingIndex, handleEvent } from './sync-context';

const originalListAgents = opencodeClient.listAgents;
const originalListProjects = opencodeClient.listProjects;
const originalAgentLoad = useAgentsStore.getState().loadAgents;
const originalConfigLoad = useConfigStore.getState().loadAgents;
const originalRuntime = getRuntimeKey();
const originalBase = getRuntimeApiBaseUrl();
let childStores: ChildStoreManager;
let agentLoads: Array<string | null | undefined> = [];
let sdkReads: Array<string | null | undefined> = [];

const project = (id: string): Project => ({ id, worktree: `/workspace/${id}`, time: { created: 1, updated: 1 }, sandboxes: [] });
const deferred = <T>() => {
  let resolvePromise: (value: T) => void = () => undefined;
  const promise = new Promise<T>((resolve) => { resolvePromise = resolve; });
  return { promise, resolve: resolvePromise };
};

beforeEach(() => {
  agentLoads = [];
  sdkReads = [];
  childStores = new ChildStoreManager();
  childStores.ensureChild('/workspace/project', { bootstrap: false });
  childStores.ensureChild('/workspace/unrelated', { bootstrap: false });
  useProjectsStore.setState({ projects: [{ id: 'ambient', path: '/workspace/ambient' }], activeProjectId: 'ambient' });
  useAgentsStore.setState({ loadAgents: async (directory) => { agentLoads.push(directory); return true; } });
  useConfigStore.setState({ loadAgents: async () => true });
  opencodeClient.listAgents = async (directory) => { sdkReads.push(directory); return []; };
  useGlobalSyncStore.getState().actions.reset();
});

afterEach(() => {
  opencodeClient.listAgents = originalListAgents;
  opencodeClient.listProjects = originalListProjects;
  useAgentsStore.setState({ loadAgents: originalAgentLoad });
  useConfigStore.setState({ loadAgents: originalConfigLoad });
  switchRuntimeEndpoint({ apiBaseUrl: originalBase, runtimeKey: originalRuntime });
  childStores.disposeAll();
});

describe('catalog refresh routing', () => {
  test('an open-directory event refreshes its Settings list without reading unrelated locations', async () => {
    handleEvent('/workspace/project', { type: 'catalog.updated', properties: { kind: 'agent' } }, childStores, createEventRoutingIndex(), getRuntimeKey());
    await new Promise((resolve) => setTimeout(resolve, 300));
    expect(agentLoads).toContain('/workspace/project');
    expect(agentLoads).not.toContain('/workspace/unrelated');
    expect(sdkReads).toEqual([]);
  });

  test('a queued catalog batch is discarded after a runtime switch', async () => {
    handleEvent('/workspace/project', { type: 'catalog.updated', properties: { kind: 'agent' } }, childStores, createEventRoutingIndex(), getRuntimeKey());
    switchRuntimeEndpoint({ apiBaseUrl: 'https://runtime-b.test', runtimeKey: 'runtime-b' });
    await new Promise((resolve) => setTimeout(resolve, 300));
    expect(agentLoads).toEqual([]);
    expect(sdkReads).toEqual([]);
  });

  test('a project catalog response cannot publish after its runtime changes', async () => {
    const response = deferred<Project[]>();
    const started = deferred<void>();
    const retained = [project('runtime-b')];
    opencodeClient.listProjects = () => { started.resolve(); return response.promise; };
    useGlobalSyncStore.getState().actions.set({ projects: retained });
    handleEvent('global', { type: 'catalog.updated', properties: { kind: 'project' } }, childStores, createEventRoutingIndex(), getRuntimeKey());
    await started.promise;
    switchRuntimeEndpoint({ apiBaseUrl: 'https://runtime-b.test', runtimeKey: 'runtime-b' });
    response.resolve([project('runtime-a')]);
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(useGlobalSyncStore.getState().projects).toBe(retained);
  });

  test('a reconnected SDK rejects an older project response even when the runtime key stays the same', async () => {
    const response = deferred<Project[]>();
    const started = deferred<void>();
    const retained = [project('current-runtime')];
    opencodeClient.listProjects = () => { started.resolve(); return response.promise; };
    useGlobalSyncStore.getState().actions.set({ projects: retained });
    handleEvent('global', { type: 'catalog.updated', properties: { kind: 'project' } }, childStores, createEventRoutingIndex(), getRuntimeKey());
    await started.promise;
    opencodeClient.reconnectToRuntimeBaseUrl();
    response.resolve([project('obsolete-sdk')]);
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(useGlobalSyncStore.getState().projects).toBe(retained);
  });
});
