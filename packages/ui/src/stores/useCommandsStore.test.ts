import { beforeEach, describe, expect, mock, test } from 'bun:test';

const activeProjectPath = '/workspace/project';

let listCommandsWithDetailsCalls = 0;
let listCommandsWithDetailsImpl: () => Promise<unknown[]> = async () => [];
let withDirectoryImpl: (_directory: string | null, callback: () => Promise<unknown>) => Promise<unknown> = async (_directory, callback) => callback();
let getDirectoryImpl: () => string = () => '/fallback/project';
let runtimeFetchImpl: () => Promise<Response> = async () => new Response(JSON.stringify({ scope: 'project' }), {
  headers: { 'Content-Type': 'application/json' },
});

const listCommandsWithDetailsMock = async () => {
  listCommandsWithDetailsCalls += 1;
  return listCommandsWithDetailsImpl();
};

const withDirectoryMock = async (directory: string | null, callback: () => Promise<unknown>) => withDirectoryImpl(directory, callback);
const getDirectoryMock = () => getDirectoryImpl();
const runtimeFetchMock = async () => runtimeFetchImpl();

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
    runtimeFetchImpl = async () => new Response(JSON.stringify({ scope: 'project' }), {
      headers: { 'Content-Type': 'application/json' },
    });

    useCommandsStore.setState({
      selectedCommandName: null,
      commands: [],
      commandsByDirectory: {},
      isLoading: false,
      commandDraft: null,
    });
  });

  test('loading another project leaves the active project\'s commands alone', async () => {
    // Settings can browse a project the app is not on. Chat reads `commands`,
    // so that list must keep describing the active project.
    const activeCommands = [{
      name: 'active-only',
      description: 'Active project command',
      template: 'run it',
      scope: 'project' as const,
    }];
    useCommandsStore.setState({
      commands: activeCommands,
      commandsByDirectory: { [activeProjectPath]: activeCommands },
    });
    listCommandsWithDetailsImpl = async () => [
      { name: 'other-only', description: 'Other project command', template: 'run there' },
    ];

    const result = await useCommandsStore.getState().loadCommands('/workspace/other');

    expect(result).toBe(true);
    const state = useCommandsStore.getState();
    expect(state.commands).toEqual(activeCommands);
    expect(state.commandsByDirectory['/workspace/other']?.map((command) => command.name)).toEqual(['other-only']);
    expect(state.commandsByDirectory[activeProjectPath]).toEqual(activeCommands);
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
});
