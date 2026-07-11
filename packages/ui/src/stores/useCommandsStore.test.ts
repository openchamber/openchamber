import { beforeEach, describe, expect, mock, test } from 'bun:test';

const activeProjectPath = '/workspace/project';

let listCommandsWithDetailsCalls = 0;
let listCommandsWithDetailsImpl: () => Promise<unknown[]> = async () => [];
let withDirectoryImpl: (_directory: string | null, callback: () => Promise<unknown>) => Promise<unknown> = async (_directory, callback) => callback();
let getDirectoryImpl: () => string = () => '/fallback/project';
let runtimeFetchCalls: Array<{ input: string; init?: RequestInit }> = [];
let runtimeFetchImpl: (input: string, init?: RequestInit) => Promise<Response> = async () => new Response(JSON.stringify({ commands: {} }), {
  headers: { 'Content-Type': 'application/json' },
});

const listCommandsWithDetailsMock = async () => {
  listCommandsWithDetailsCalls += 1;
  return listCommandsWithDetailsImpl();
};

const withDirectoryMock = async (directory: string | null, callback: () => Promise<unknown>) => withDirectoryImpl(directory, callback);
const getDirectoryMock = () => getDirectoryImpl();
const runtimeFetchMock = async (input: string, init?: RequestInit) => {
  runtimeFetchCalls.push({ input, init });
  return runtimeFetchImpl(input, init);
};

mock.module('@/lib/opencode/client', () => ({
  opencodeClient: {
    getDirectory: getDirectoryMock,
    listCommandsWithDetails: listCommandsWithDetailsMock,
    withDirectory: withDirectoryMock,
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

const { useCommandsStore } = await import('./useCommandsStore');

describe('useCommandsStore', () => {
  beforeEach(() => {
    listCommandsWithDetailsCalls = 0;
    listCommandsWithDetailsImpl = async () => [];
    withDirectoryImpl = async (_directory, callback) => callback();
    getDirectoryImpl = () => '/fallback/project';
    runtimeFetchCalls = [];
    runtimeFetchImpl = async () => new Response(JSON.stringify({ commands: {} }), {
      headers: { 'Content-Type': 'application/json' },
    });

    useCommandsStore.setState({
      selectedCommandName: null,
      commands: [],
      isLoading: false,
      commandDraft: null,
    });
  });

  test('loadCommands preserves previous commands when the command list fails', async () => {
    const previousCommands = [{
      name: 'existing',
      description: 'Existing command',
      template: 'do the previous thing',
      scope: 'project' as const,
    }];
    useCommandsStore.setState({ commands: previousCommands });
    listCommandsWithDetailsImpl = async () => {
      throw new Error('network down');
    };

    const result = await useCommandsStore.getState().loadCommands();

    expect(result).toBe(false);
    expect(listCommandsWithDetailsCalls).toBe(3);
    expect(useCommandsStore.getState().commands).toEqual(previousCommands);
    expect(useCommandsStore.getState().isLoading).toBe(false);
  });

  test('loads scope metadata for many commands with one batched runtime request', async () => {
    listCommandsWithDetailsImpl = async () => Array.from({ length: 80 }, (_, index) => ({
      name: `command-${index}`,
      description: `Command ${index}`,
      source: 'command',
    }));
    runtimeFetchImpl = async (_input, init) => {
      const body = JSON.parse(String(init?.body)) as { names: string[] };
      return new Response(JSON.stringify({
        commands: Object.fromEntries(body.names.map((name) => [name, { scope: 'project', isBuiltIn: false }])),
      }), { headers: { 'Content-Type': 'application/json' } });
    };

    const result = await useCommandsStore.getState().loadCommands();

    expect(result).toBe(true);
    expect(runtimeFetchCalls).toHaveLength(1);
    expect(runtimeFetchCalls[0]?.input).toBe('/api/config/commands/metadata');
    expect(runtimeFetchCalls[0]?.init?.method).toBe('POST');
    expect(useCommandsStore.getState().commands).toHaveLength(80);
    expect(useCommandsStore.getState().commands.every((command) => command.scope === 'project')).toBe(true);
  });
});
