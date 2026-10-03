import { afterEach, beforeEach, describe, expect, spyOn, test } from 'bun:test';
import type { Agent } from '@/lib/opencode/model';
import { opencodeClient } from '@/lib/opencode/client';
import { useConfigStore } from './useConfigStore';
import { useProjectsStore } from './useProjectsStore';
import { invalidateAgentsLoadCache, selectAgentsForDirectory, useAgentsStore } from './useAgentsStore';
import { refreshStoresForCatalogKind } from './catalogRefresh';

const AMBIENT = '/workspace/ambient';
const DIRECTORY = '/workspace/settings-project';
const originalListAgents = opencodeClient.listAgents;
const originalConfigLoad = useConfigStore.getState().loadAgents;
let restoreFetch = () => {};

const agent = (name: string): Agent => ({
  id: name, name, displayName: name, mode: 'subagent', hidden: false,
  request: { settings: {}, headers: {}, body: {} }, permissions: [],
});
const deferred = <T>() => {
  let resolvePromise: (value: T) => void = () => undefined;
  const promise = new Promise<T>((resolve) => { resolvePromise = resolve; });
  return { promise, resolve: resolvePromise };
};

beforeEach(() => {
  const fetch = spyOn(globalThis, 'fetch').mockResolvedValue(Response.json({ scope: 'project', sources: {} }));
  restoreFetch = () => fetch.mockRestore();
  useProjectsStore.setState({ projects: [{ id: 'ambient', path: AMBIENT }], activeProjectId: 'ambient' });
  useAgentsStore.getState().resetForRuntimeSwitch();
  useConfigStore.setState({ loadAgents: async () => true });
});

afterEach(() => {
  opencodeClient.listAgents = originalListAgents;
  useConfigStore.setState({ loadAgents: originalConfigLoad });
  restoreFetch();
});

describe('agent catalog refresh', () => {
  test('replaces the Settings directory list while keeping the ambient project mirror', async () => {
    const lists = new Map([[AMBIENT, [agent('ambient-agent')]], [DIRECTORY, [agent('old-agent')]]]);
    opencodeClient.listAgents = async (directory) => lists.get(directory ?? AMBIENT) ?? [];
    await useAgentsStore.getState().loadAgents(AMBIENT);
    await useAgentsStore.getState().loadAgents(DIRECTORY);
    lists.set(DIRECTORY, [agent('new-agent')]);

    await refreshStoresForCatalogKind('agent', [DIRECTORY]);

    expect(selectAgentsForDirectory(useAgentsStore.getState(), DIRECTORY).map((entry) => entry.name)).toEqual(['new-agent']);
    expect(useAgentsStore.getState().agents.map((entry) => entry.name)).toEqual(['ambient-agent']);
  });

  test('an invalidated response cannot publish a pre-change list or fresh TTL', async () => {
    const staleResponse = deferred<Agent[]>();
    let listCalls = 0;
    opencodeClient.listAgents = async () => ++listCalls === 1 ? staleResponse.promise : [agent('new-agent')];
    const staleLoad = useAgentsStore.getState().loadAgents(DIRECTORY);
    invalidateAgentsLoadCache(DIRECTORY);
    const freshLoad = useAgentsStore.getState().loadAgents(DIRECTORY);
    staleResponse.resolve([agent('old-agent')]);

    expect(await staleLoad).toBe(true);
    expect(await freshLoad).toBe(true);
    expect(listCalls).toBe(2);
    expect(selectAgentsForDirectory(useAgentsStore.getState(), DIRECTORY).map((entry) => entry.name)).toEqual(['new-agent']);
  });

  test('runtime reset rejects an older load for the same directory', async () => {
    const staleResponse = deferred<Agent[]>();
    let listCalls = 0;
    opencodeClient.listAgents = async () => ++listCalls === 1 ? staleResponse.promise : [agent('new-runtime-agent')];
    const staleLoad = useAgentsStore.getState().loadAgents(DIRECTORY);
    useAgentsStore.getState().resetForRuntimeSwitch();
    const freshLoad = useAgentsStore.getState().loadAgents(DIRECTORY);
    staleResponse.resolve([agent('old-runtime-agent')]);

    expect(await staleLoad).toBe(false);
    expect(await freshLoad).toBe(true);
    expect(selectAgentsForDirectory(useAgentsStore.getState(), DIRECTORY).map((entry) => entry.name)).toEqual(['new-runtime-agent']);
  });
});
