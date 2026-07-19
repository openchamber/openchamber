/**
 * Regression test for issue #2305: the Agents section in Settings did not show
 * custom subagents.
 *
 * Root cause: user-defined subagents commonly set `hidden: true` in their
 * frontmatter, which keeps them out of the composer agent picker while they
 * remain callable via the `task` tool. The Settings > Agents sidebar reused the
 * picker-oriented `hidden` filter, so those user-defined agents disappeared from
 * the management UI entirely and could not be viewed or edited.
 *
 * Fix: Settings now shows agents via `isAgentManageable`, which surfaces
 * user-defined (non-native) agents even when hidden, while keeping native
 * internal agents (title, summary, compaction) hidden. The composer picker path
 * (`filterVisibleAgents`) is unchanged.
 *
 * The test drives the real `useAgentsStore.loadAgents` against a mocked OpenCode
 * agent list that mirrors the reporter's config, then applies the exact
 * predicates the production sidebar and picker use.
 */
import { beforeEach, describe, expect, mock, test } from 'bun:test';
import type { Agent } from '@opencode-ai/sdk/v2';

type TestAgent = Agent & { native?: boolean; hidden?: boolean };

let liveAgents: TestAgent[] = [];

const makeStorage = () => ({
  getItem: () => null,
  setItem: () => undefined,
  removeItem: () => undefined,
});

mock.module('./utils/safeStorage', () => ({
  createDeferredSafeJSONStorage: () => makeStorage(),
}));

mock.module('@/lib/opencode/client', () => ({
  opencodeClient: {
    getDirectory: () => undefined,
    listAgents: mock(async () => liveAgents),
    listToolIds: mock(async () => []),
    checkHealth: mock(async () => true),
  },
}));

mock.module('@/lib/runtime-fetch', () => ({
  // Emulates GET /api/config/agents/:name — every agent resolves to a global
  // (~/.config/opencode/agents/<name>.md) user-scope definition.
  runtimeFetch: mock(async (url: string) => {
    const match = /\/api\/config\/agents\/([^?]+)/.exec(url);
    const name = match ? decodeURIComponent(match[1]) : 'unknown';
    return new Response(
      JSON.stringify({
        name,
        scope: 'user',
        sources: { md: { exists: true, scope: 'user', path: `/home/u/.config/opencode/agents/${name}.md` } },
      }),
      { headers: { 'Content-Type': 'application/json' } },
    );
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

const { useAgentsStore, filterVisibleAgents, isAgentManageable, isAgentBuiltIn } = await import('./useAgentsStore');

const agent = (
  name: string,
  mode: Agent['mode'],
  extra: { native?: boolean; hidden?: boolean } = {},
): TestAgent => ({ name, mode, permission: [], options: {}, ...extra } as TestAgent);

const HIDDEN_SUBAGENTS = ['builder-claude', 'reviewer-claude', 'planner-gpt', 'axdb-investigator'];

describe('issue #2305 — custom subagents in Settings > Agents', () => {
  beforeEach(() => {
    useAgentsStore.setState({ agents: [], isLoading: false, selectedAgentName: null, agentDraft: null });
    liveAgents = [
      // OpenCode built-ins
      agent('build', 'primary', { native: true }),
      agent('plan', 'primary', { native: true }),
      agent('general', 'subagent', { native: true }),
      // native internal agents (hidden machinery)
      agent('title', 'primary', { native: true, hidden: true }),
      agent('summary', 'primary', { native: true, hidden: true }),
      // user-global custom primary / all agents
      agent('ops-engineer', 'primary'),
      agent('software-lead', 'primary'),
      agent('prompt-engineer', 'all'),
      // user-global custom SUBAGENTS that opt out of the picker with hidden: true
      ...HIDDEN_SUBAGENTS.map((name) => agent(name, 'subagent', { hidden: true })),
    ];
  });

  test('loads the full agent list including hidden custom subagents', async () => {
    await useAgentsStore.getState().loadAgents();
    const names = useAgentsStore.getState().agents.map((a) => a.name);
    for (const name of HIDDEN_SUBAGENTS) {
      expect(names).toContain(name);
    }
  });

  test('Settings shows hidden custom subagents (the fix)', async () => {
    await useAgentsStore.getState().loadAgents();
    const stored = useAgentsStore.getState().agents;

    // Exactly how AgentsSidebar derives its rows.
    const settingsAgents = stored.filter(isAgentManageable);
    const customNames = settingsAgents.filter((a) => !isAgentBuiltIn(a)).map((a) => a.name);

    for (const name of HIDDEN_SUBAGENTS) {
      expect(customNames).toContain(name);
    }
    // Custom primary/all agents keep showing too.
    for (const name of ['ops-engineer', 'software-lead', 'prompt-engineer']) {
      expect(customNames).toContain(name);
    }
  });

  test('native internal agents stay hidden from Settings', async () => {
    await useAgentsStore.getState().loadAgents();
    const settingsNames = useAgentsStore.getState().agents.filter(isAgentManageable).map((a) => a.name);
    expect(settingsNames).not.toContain('title');
    expect(settingsNames).not.toContain('summary');
  });

  test('composer picker still excludes hidden subagents (invariant preserved)', async () => {
    await useAgentsStore.getState().loadAgents();
    const pickerNames = filterVisibleAgents(useAgentsStore.getState().agents).map((a) => a.name);
    for (const name of HIDDEN_SUBAGENTS) {
      expect(pickerNames).not.toContain(name);
    }
    // Non-hidden agents remain available in the picker.
    expect(pickerNames).toContain('ops-engineer');
    expect(pickerNames).toContain('build');
  });
});
