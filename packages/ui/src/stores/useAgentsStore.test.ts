import { beforeEach, describe, expect, mock, test } from 'bun:test';

const activeProjectPath = '/workspace/project';

let listAgentsImpl: () => Promise<unknown[]> = async () => [];
let getDirectoryImpl: () => string = () => activeProjectPath;
let runtimeFetchImpl: () => Promise<Response> = async () => new Response(JSON.stringify({ scope: 'project' }), {
  headers: { 'Content-Type': 'application/json' },
});

const listAgentsMock = async () => listAgentsImpl();
const getDirectoryMock = () => getDirectoryImpl();
const runtimeFetchMock = async () => runtimeFetchImpl();

mock.module('@/lib/opencode/client', () => ({
  opencodeClient: {
    getDirectory: getDirectoryMock,
    setDirectory: mock(() => undefined),
    listAgents: listAgentsMock,
  },
}));

mock.module('@/stores/useProjectsStore', () => ({
  useProjectsStore: {
    getState: () => ({
      getActiveProject: () => ({ path: activeProjectPath }),
    }),
  },
}));

mock.module('@/lib/runtime-fetch', () => ({
  runtimeFetch: runtimeFetchMock,
}));

mock.module('@/lib/configUpdate', () => ({
  startConfigUpdate: mock(() => undefined),
  finishConfigUpdate: mock(() => undefined),
  updateConfigUpdateMessage: mock(() => undefined),
}));

mock.module('@/lib/configSync', () => ({
  emitConfigChange: mock(() => undefined),
  scopeMatches: mock(() => false),
  subscribeToConfigChanges: mock(() => () => undefined),
}));

const { useAgentsStore } = await import('./useAgentsStore');

describe('useAgentsStore', () => {
  beforeEach(() => {
    listAgentsImpl = async () => [];
    getDirectoryImpl = () => activeProjectPath;
    runtimeFetchImpl = async () => new Response(JSON.stringify({ scope: 'project' }), {
      headers: { 'Content-Type': 'application/json' },
    });

    useAgentsStore.setState({
      selectedAgentName: null,
      agents: [],
      isLoading: false,
      agentsLoadError: false,
      agentDraft: null,
    });
  });

  test('loadAgents sets agentsLoadError and preserves prior agents after exhausting retries', async () => {
    const previousAgents = [{ name: 'existing', mode: 'subagent' as const }];
    useAgentsStore.setState({ agents: previousAgents as never });
    listAgentsImpl = async () => {
      throw new Error('backend unreachable');
    };

    const result = await useAgentsStore.getState().loadAgents();

    expect(result).toBe(false);
    expect(useAgentsStore.getState().agentsLoadError).toBe(true);
    expect(useAgentsStore.getState().agents).toEqual(previousAgents as never);
  });

  test('a successful loadAgents clears a previously set agentsLoadError', async () => {
    useAgentsStore.setState({ agentsLoadError: true });
    listAgentsImpl = async () => [{ name: 'researcher', mode: 'subagent' as const }];

    const result = await useAgentsStore.getState().loadAgents();

    expect(result).toBe(true);
    expect(useAgentsStore.getState().agentsLoadError).toBe(false);
  });

  test('agentsLoadError is cleared at the start of a fresh load, before the new attempt resolves', async () => {
    useAgentsStore.setState({ agentsLoadError: true });
    let resolveList: (value: unknown[]) => void = () => {};
    listAgentsImpl = () => new Promise((resolve) => {
      resolveList = resolve;
    });

    const pending = useAgentsStore.getState().loadAgents();
    expect(useAgentsStore.getState().agentsLoadError).toBe(false);

    resolveList([]);
    await pending;
  });
});
