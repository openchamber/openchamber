import { afterAll, beforeEach, describe, expect, mock, test } from 'bun:test';
import { Window } from 'happy-dom';

const browser = new Window({ url: 'http://localhost/' });
Object.defineProperties(globalThis, {
  window: { configurable: true, writable: true, value: browser },
  localStorage: { configurable: true, writable: true, value: browser.localStorage },
});

const ACTIVE = '/workspace/active';
const OTHER = '/workspace/other';

type ProviderLoad = { directory?: string | null; source?: string; fresh?: boolean };
type AgentLoad = { directory?: string | null; source?: string; fresh?: boolean };

let providerLoads: ProviderLoad[] = [];
let sdkAgentLoads: AgentLoad[] = [];
let uiAgentLoads: Array<string | null> = [];
let commandLoads: Array<string | null> = [];
let catalogInvalidations: Array<readonly string[]> = [];
const projectsState = {
  activeProjectId: 'active',
  projects: [
    { id: 'active', path: ACTIVE, label: 'Active' },
    { id: 'other', path: OTHER, label: 'Other' },
  ],
};

const configState = {
  loadProviders: async (options: ProviderLoad) => { providerLoads.push(options); },
  loadAgents: async (options: AgentLoad) => { sdkAgentLoads.push(options); return true; },
};
const commandsState = {
  loadCommands: async (directory?: string | null) => { commandLoads.push(directory ?? null); return true; },
};
const skillsState = { loadSkills: async () => true };
const skillsCatalogState = { loadCatalog: async () => true };

mock.module('@/lib/opencode/client', () => ({
  opencodeClient: {
    getDirectory: () => ACTIVE,
    invalidateAgentList: () => undefined,
    clearAgentListRequests: () => undefined,
  },
}));
mock.module('@/lib/configSync', () => ({
  emitConfigChange: () => undefined,
  scopeMatches: () => false,
  subscribeToConfigChanges: () => () => undefined,
}));
mock.module('@/lib/configUpdate', () => ({
  startConfigUpdate: () => undefined,
  finishConfigUpdate: () => undefined,
  updateConfigUpdateMessage: () => undefined,
}));
mock.module('@/stores/waitForOpenCodeConnection', () => ({
  waitForOpenCodeConnection: async () => undefined,
}));
mock.module('@/stores/useConfigStore', () => ({
  useConfigStore: { getState: () => configState },
  invalidateConfigCatalogsForReload: (kinds: readonly string[]) => { catalogInvalidations.push(kinds); },
}));
mock.module('@/stores/useCommandsStore', () => ({
  invalidateCommandsLoadCache: () => undefined,
  useCommandsStore: { getState: () => commandsState },
}));
mock.module('@/stores/useProjectsStore', () => ({
  useProjectsStore: { getState: () => projectsState },
}));
mock.module('@/stores/useSkillsCatalogStore', () => ({
  useSkillsCatalogStore: { getState: () => skillsCatalogState },
}));
mock.module('@/stores/useSkillsStore', () => ({
  invalidateSkillsLoadCache: () => undefined,
  useSkillsStore: { getState: () => skillsState },
}));
mock.module('@/lib/runtime-fetch', () => ({
  runtimeFetch: mock(async () => Response.json({
    success: true,
    requiresReload: true,
    message: 'Configuration reloaded',
    reloadDelayMs: 0,
  })),
}));
mock.module('@/lib/runtime-switch', () => ({
  getRuntimeKey: () => 'test-runtime',
}));

const { reloadOpenCodeConfiguration, useAgentsStore } = await import('@/stores/useAgentsStore');

beforeEach(() => {
  providerLoads = [];
  sdkAgentLoads = [];
  uiAgentLoads = [];
  commandLoads = [];
  catalogInvalidations = [];
  useAgentsStore.setState({
    loadAgents: async (directory?: string | null) => {
      uiAgentLoads.push(directory ?? null);
      return true;
    },
  });
});

afterAll(() => {
  browser.close();
});

describe('configuration reload refresh scope', () => {
  test('reads only the active directory and retires every other catalog', async () => {
    await reloadOpenCodeConfiguration();

    expect(providerLoads).toEqual([{
      directory: ACTIVE,
      source: 'agentsStore:refreshConfig',
      fresh: true,
    }]);
    expect(sdkAgentLoads).toEqual([{
      directory: ACTIVE,
      source: 'agentsStore:refreshConfig',
      fresh: true,
    }]);
    expect(uiAgentLoads).toEqual([ACTIVE]);
    expect(commandLoads).toEqual([ACTIVE]);
    expect(catalogInvalidations).toEqual([['provider', 'agent']]);
    expect(providerLoads.some((options) => options.directory === OTHER)).toBe(false);
    expect(sdkAgentLoads.some((options) => options.directory === OTHER)).toBe(false);
  });
});
