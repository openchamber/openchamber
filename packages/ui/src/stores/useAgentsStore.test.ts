import { beforeEach, describe, expect, mock, test } from 'bun:test';
import type { Agent } from '@opencode-ai/sdk/v2';

const DIRECTORY = '/workspace/project';
// Session directory differs from the active project path (multi-project usage).
const SESSION_DIRECTORY = '/workspace/session';

let storage = new Map<string, string>();
let liveAgents: TestAgent[] = [];
let fetchCalls: Array<{ method: string; url: string }> = [];

type TestAgent = {
  name: string;
  mode?: string;
  hidden?: boolean;
  description?: string;
  model?: { providerID?: string; modelID?: string };
  variant?: string;
  prompt?: string;
  temperature?: number;
  topP?: number;
};

const makeStorage = (): Storage => ({
  getItem: (key: string) => storage.get(key) ?? null,
  setItem: (key: string, value: string) => { storage.set(key, value); },
  removeItem: (key: string) => { storage.delete(key); },
  clear: () => { storage.clear(); },
  key: (index: number) => Array.from(storage.keys())[index] ?? null,
  get length() { return storage.size; },
}) as Storage;

const testAgent = (name: string, options?: Partial<TestAgent>): Agent => ({
  name,
  mode: options?.mode ?? 'primary',
  description: options?.description,
  hidden: options?.hidden,
  model: options?.model,
  variant: options?.variant,
  prompt: options?.prompt,
  temperature: options?.temperature,
  topP: options?.topP,
  permission: {},
  options: {},
}) as Agent;

const jsonResponse = (body: unknown): Response => new Response(JSON.stringify(body), {
  status: 200,
  headers: { 'Content-Type': 'application/json' },
});

mock.module('@/stores/utils/safeStorage', () => ({
  getDeferredSafeStorage: () => makeStorage(),
  getSafeStorage: () => makeStorage(),
  createDeferredSafeJSONStorage: () => {
    const testStorage = makeStorage();
    return {
      getItem: (name: string) => {
        const value = testStorage.getItem(name);
        return value === null ? null : JSON.parse(value);
      },
      setItem: (name: string, value: unknown) => {
        testStorage.setItem(name, JSON.stringify(value));
      },
      removeItem: (name: string) => { testStorage.removeItem(name); },
    };
  },
}));

mock.module('@/stores/useProjectsStore', () => ({
  useProjectsStore: {
    getState: () => ({
      activeProjectId: 'project',
      projects: [{ id: 'project', path: DIRECTORY, label: 'Project' }],
    }),
  },
}));

mock.module('@/lib/opencode/client', () => ({
  opencodeClient: {
    setDirectory: mock(() => undefined),
    getDirectory: mock(() => SESSION_DIRECTORY),
    checkHealth: mock(async () => true),
    listAgents: mock(async () => liveAgents as Agent[]),
    getProviders: mock(async () => ({ providers: [], default: { default: 'none' } })),
    getConfig: mock(async () => ({})),
    clearConfigCache: mock(() => undefined),
  },
}));

mock.module('@/contexts/runtimeAPIRegistry', () => ({
  getRegisteredRuntimeAPIs: mock(() => null),
}));

mock.module('@/lib/runtime-fetch', () => ({
  runtimeFetch: mock(async (input: string, init?: RequestInit) => {
    const url = String(input);
    const method = (init?.method ?? 'GET').toUpperCase();
    fetchCalls.push({ method, url });
    if (method === 'PATCH' && url.includes('/api/config/agents/')) {
      return jsonResponse({ success: true, requiresReload: true, reloadDelayMs: 0 });
    }
    if (url.includes('/api/config/agents/')) {
      const name = decodeURIComponent(url.match(/\/agents\/([^?]+)/)?.[1] ?? '');
      return jsonResponse({ name, sources: { md: { exists: true, path: `${DIRECTORY}/.opencode/agents/${name}.md`, scope: 'project' } }, scope: 'project', isBuiltIn: false });
    }
    return jsonResponse({});
  }),
}));

mock.module('@/lib/persistence', () => ({
  updateDesktopSettings: mock(async () => undefined),
}));

mock.module('@/lib/startupTrace', () => ({
  markStartupTrace: mock(() => undefined),
  measureStartupTrace: mock(async (_name: string, callback: () => Promise<unknown>) => callback()),
}));

mock.module('@/lib/configSync', () => ({
  emitConfigChange: mock(() => undefined),
  scopeMatches: mock((event: { scopes: string[] }, scope: string) => event.scopes.includes('all') || event.scopes.includes(scope)),
  subscribeToConfigChanges: mock(() => () => undefined),
}));

const { useAgentsStore } = await import('./useAgentsStore');

describe('useAgentsStore agent update persistence', () => {
  beforeEach(() => {
    storage = new Map<string, string>();
    fetchCalls = [];
    useAgentsStore.setState({
      selectedAgentName: null,
      agents: [],
      isLoading: false,
      agentDraft: null,
    });
  });

  test('updateAgent persists the new model and reload reflects it', async () => {
    liveAgents = [
      testAgent('strateg', {
        description: 'Strategy agent',
        mode: 'primary',
        model: { providerID: 'anthropic', modelID: 'claude-sonnet-4' },
      }),
    ];

    await useAgentsStore.getState().loadAgents();
    expect(useAgentsStore.getState().getAgentByName('strateg')?.model).toEqual({
      providerID: 'anthropic',
      modelID: 'claude-sonnet-4',
    });

    // Simulate the server having written the new model to disk and OpenCode
    // having restarted: the next listAgents returns the new value.
    liveAgents = [
      testAgent('strateg', {
        description: 'Strategy agent',
        mode: 'primary',
        model: { providerID: 'openai', modelID: 'gpt-5' },
      }),
    ];

    const result = await useAgentsStore.getState().updateAgent('strateg', {
      model: 'openai/gpt-5',
    });

    expect(result.ok).toBe(true);
    const patchCall = fetchCalls.find((c) => c.method === 'PATCH');
    expect(patchCall).toBeDefined();
    expect(patchCall?.url).toContain('/api/config/agents/strateg');

    // After the save the store must reflect the saved model so the page can
    // reset its dirty state from the fresh agent.
    const reloaded = useAgentsStore.getState().getAgentByName('strateg');
    expect(reloaded?.model).toEqual({ providerID: 'openai', modelID: 'gpt-5' });
  });

  test('updateAgent reflects the saved model even when the post-save reload is stale', async () => {
    liveAgents = [
      testAgent('strateg', {
        description: 'Strategy agent',
        mode: 'primary',
        model: { providerID: 'anthropic', modelID: 'claude-sonnet-4' },
      }),
    ];

    await useAgentsStore.getState().loadAgents();

    // The server persisted the write, but the background reload keeps serving
    // the pre-save snapshot (stale cache / in-flight reuse / reload failure).
    // The in-memory list must still reflect what the user just saved, so the
    // settings page can clear its dirty state instead of showing stale values.
    const result = await useAgentsStore.getState().updateAgent('strateg', {
      model: 'openai/gpt-5',
    });

    expect(result.ok).toBe(true);
    const after = useAgentsStore.getState().getAgentByName('strateg');
    expect(after?.model).toEqual({ providerID: 'openai', modelID: 'gpt-5' });
  });

  test('updateAgent applies all saved fields to the local agent', async () => {
    liveAgents = [
      testAgent('strateg', {
        description: 'Old description',
        mode: 'primary',
        model: { providerID: 'anthropic', modelID: 'claude-sonnet-4' },
        variant: 'thinking',
        temperature: 0.5,
        topP: 0.8,
        prompt: 'Old prompt',
      }),
    ];

    await useAgentsStore.getState().loadAgents();

    const result = await useAgentsStore.getState().updateAgent('strateg', {
      description: 'New description',
      mode: 'subagent',
      model: 'openai/gpt-5',
      variant: null,
      temperature: 0.2,
      top_p: null,
      prompt: 'New prompt',
    });

    expect(result.ok).toBe(true);
    const after = useAgentsStore.getState().getAgentByName('strateg');
    expect(after?.description).toBe('New description');
    expect(after?.mode).toBe('subagent');
    expect(after?.model).toEqual({ providerID: 'openai', modelID: 'gpt-5' });
    expect(after?.variant).toBe(undefined);
    expect(after?.temperature).toBe(0.2);
    expect(after?.topP).toBe(undefined);
    expect(after?.prompt).toBe('New prompt');
  });
});
