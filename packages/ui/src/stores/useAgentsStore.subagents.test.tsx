import { beforeEach, describe, expect, mock, test } from 'bun:test';
import type { Agent } from '@opencode-ai/sdk/v2';

type TestAgent = Agent & {
  native?: boolean;
  hidden?: boolean;
  options?: { hidden?: boolean };
  description?: string;
};

let liveAgents: TestAgent[] = [];
let lastCreatedAgent: Partial<TestAgent> | null = null;

mock.module('./utils/safeStorage', () => ({
  createDeferredSafeJSONStorage: () => ({
    getItem: () => null,
    setItem: () => undefined,
    removeItem: () => undefined,
  }),
}));

mock.module('@/lib/opencode/client', () => ({
  opencodeClient: {
    getDirectory: () => undefined,
    listAgents: mock(async () => liveAgents),
    checkHealth: mock(async () => true),
  },
}));

mock.module('@/lib/runtime-fetch', () => ({
  runtimeFetch: mock(async (url: string, init?: RequestInit) => {
    if (url === '/api/config/reload') {
      return Response.json({ requiresReload: false });
    }

    const match = /\/api\/config\/agents\/([^?]+)/.exec(url);
    const name = match ? decodeURIComponent(match[1]) : 'unknown';
    if (init?.method === 'POST') {
      lastCreatedAgent = JSON.parse(String(init.body)) as Partial<TestAgent>;
      return Response.json({ requiresManualRestart: true });
    }
    if (init?.method === 'PATCH') {
      const update = JSON.parse(String(init.body)) as Partial<TestAgent>;
      liveAgents = liveAgents.map((item) => item.name === name ? { ...item, ...update } : item);
      return Response.json({ requiresReload: false });
    }

    return Response.json({
      name,
      scope: 'user',
      sources: { md: { exists: true, scope: 'user', path: `/home/u/.config/opencode/agents/${name}.md` } },
    });
  }),
}));

mock.module('@/lib/configSync', () => ({
  emitConfigChange: mock(() => undefined),
  scopeMatches: mock(() => false),
  subscribeToConfigChanges: mock(() => () => undefined),
}));

mock.module('@/lib/configUpdate', () => ({
  startConfigUpdate: mock(() => undefined),
  finishConfigUpdate: mock(() => undefined),
  updateConfigUpdateMessage: mock(() => undefined),
}));

const emptyStore = { getState: () => ({}) };
mock.module('@/stores/useConfigStore', () => ({ useConfigStore: emptyStore }));
mock.module('@/stores/useCommandsStore', () => ({ useCommandsStore: emptyStore, invalidateCommandsLoadCache: () => undefined }));
mock.module('@/stores/useSkillsCatalogStore', () => ({ useSkillsCatalogStore: emptyStore }));
mock.module('@/stores/useSkillsStore', () => ({ useSkillsStore: emptyStore, invalidateSkillsLoadCache: () => undefined }));
mock.module('@/stores/useProjectsStore', () => ({
  useProjectsStore: { getState: () => ({ getActiveProject: () => null, projects: [] }) },
}));

const { useAgentsStore, reloadOpenCodeConfiguration, isAgentBuiltIn, isAgentManageable } = await import('@/stores/useAgentsStore');
const { copyAgentConfig } = await import('@/components/sections/agents/AgentsSidebar');

// Mirrors the Settings list derivation in AgentsSidebar.
const deriveSettingsAgentLists = (agents: Agent[]) => {
  const manageableAgents = agents.filter(isAgentManageable);
  return {
    manageableAgents,
    customAgents: manageableAgents.filter((item) => !isAgentBuiltIn(item)),
  };
};

const agent = (name: string, mode: Agent['mode'], extra: Partial<TestAgent> = {}): TestAgent =>
  ({ name, mode, permission: [], options: {}, ...extra } as TestAgent);

describe('Settings hidden custom subagents', () => {
  beforeEach(() => {
    useAgentsStore.setState({ agents: [], isLoading: false, selectedAgentName: null, agentDraft: null });
    lastCreatedAgent = null;
    liveAgents = [
      agent('build', 'primary', { native: true }),
      agent('title', 'primary', { native: true, hidden: true }),
      agent('summary', 'primary', { native: true, hidden: true }),
      agent('compaction', 'primary', { native: true, hidden: true }),
      agent('visible-custom', 'primary'),
      agent('hidden-custom', 'subagent', { hidden: true, description: 'Original description' }),
      agent('options-hidden-custom', 'subagent', { options: { hidden: true } }),
    ];
  });

  test('derives hidden custom agents as manageable without exposing hidden native agents to Settings or pickers', async () => {
    await useAgentsStore.getState().loadAgents();

    const { manageableAgents, customAgents } = deriveSettingsAgentLists(useAgentsStore.getState().agents);
    expect(manageableAgents.map((item) => item.name)).toEqual([
      'build',
      'visible-custom',
      'hidden-custom',
      'options-hidden-custom',
    ]);
    expect(customAgents.map((item) => item.name)).toEqual([
      'visible-custom',
      'hidden-custom',
      'options-hidden-custom',
    ]);

    const pickerNames = useAgentsStore.getState().getVisibleAgents().map((item) => item.name);
    expect(pickerNames).toContain('visible-custom');
    expect(pickerNames).not.toContain('hidden-custom');
    expect(pickerNames).not.toContain('options-hidden-custom');
  });

  test('keeps a hidden custom agent manageable after an update', async () => {
    await useAgentsStore.getState().loadAgents();
    await useAgentsStore.getState().updateAgent('hidden-custom', { description: 'Updated description' });

    const { customAgents } = deriveSettingsAgentLists(useAgentsStore.getState().agents);
    expect(customAgents.find((item) => item.name === 'hidden-custom')?.description).toBe('Updated description');
    expect(customAgents.map((item) => item.name)).toContain('visible-custom');
    expect(customAgents.map((item) => item.name)).not.toContain('title');
  });

  test('preserves hidden custom agent configuration when copying for rename or duplicate', async () => {
    const renameConfig = copyAgentConfig(
      agent('hidden-custom', 'subagent', { hidden: true }),
      'renamed-hidden-custom',
    );
    expect(renameConfig.name).toBe('renamed-hidden-custom');
    expect(renameConfig.hidden).toBe(true);
    const duplicateConfig = copyAgentConfig(
      agent('options-hidden-custom', 'subagent', { options: { hidden: true } }),
      'duplicated-hidden-custom',
    );
    expect(duplicateConfig.name).toBe('duplicated-hidden-custom');
    expect(duplicateConfig.hidden).toBe(true);

    await useAgentsStore.getState().createAgent(renameConfig);
    expect(lastCreatedAgent?.hidden).toBe(true);
  });

  test('derives Settings rows from the refreshed store snapshot', async () => {
    await useAgentsStore.getState().loadAgents();
    liveAgents = [...liveAgents, agent('reloaded-hidden-custom', 'subagent', { hidden: true })];

    await reloadOpenCodeConfiguration({ scopes: ['agents'], mode: 'active' });

    const { customAgents } = deriveSettingsAgentLists(useAgentsStore.getState().agents);
    expect(customAgents.map((item) => item.name)).toContain('reloaded-hidden-custom');
    expect(customAgents.map((item) => item.name)).toContain('visible-custom');
    expect(customAgents.map((item) => item.name)).not.toContain('summary');
  });
});
