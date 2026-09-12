import { beforeEach, describe, expect, mock, test } from 'bun:test';
import type { Command } from './useCommandsStore';

function deferred<T>() {
  let resolve: (value: T) => void = () => { throw new Error('Promise not initialized'); };
  const promise = new Promise<T>((onResolve) => { resolve = onResolve; });
  return { promise, resolve: (value: T) => resolve(value) };
}

let activeProjectPath = '/workspace/project';

let listCommandsWithDetailsCalls = 0;
let listCommandsWithDetailsImpl: (directory?: string | null) => Promise<Command[]> = async () => [];
let getDirectoryImpl: () => string = () => '/fallback/project';
let runtimeFetchImpl: () => Promise<Response> = async () => new Response(JSON.stringify({ scope: 'project' }), {
  headers: { 'Content-Type': 'application/json' },
});

const listCommandsWithDetailsMock = async (directory?: string | null) => {
  listCommandsWithDetailsCalls += 1;
  return listCommandsWithDetailsImpl(directory);
};

const getDirectoryMock = () => getDirectoryImpl();
const runtimeFetchMock = async () => runtimeFetchImpl();

mock.module('@/lib/opencode/client', () => ({
  opencodeClient: {
    getDirectory: getDirectoryMock,
    listCommandsWithDetails: listCommandsWithDetailsMock,
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

const { useCommandsStore, invalidateCommandsLoadCache, selectCommandsForDirectory } = await import('./useCommandsStore');

describe('useCommandsStore', () => {
  beforeEach(() => {
    activeProjectPath = '/workspace/project';
    invalidateCommandsLoadCache(activeProjectPath);
    invalidateCommandsLoadCache('/workspace/other');
    listCommandsWithDetailsCalls = 0;
    listCommandsWithDetailsImpl = async () => [];
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
    useCommandsStore.setState({ commands: previousCommands, commandsByDirectory: { [activeProjectPath]: previousCommands } });
    listCommandsWithDetailsImpl = async () => {
      throw new Error('network down');
    };

    const result = await useCommandsStore.getState().loadCommands();

    expect(result).toBe(false);
    expect(listCommandsWithDetailsCalls).toBe(3);
    expect(useCommandsStore.getState().commands).toEqual(previousCommands);
    expect(useCommandsStore.getState().isLoading).toBe(false);
  });

  test('first load publishes a directory even when its commands match the previous project', async () => {
    const commands = [{ name: 'shared', scope: 'project' as const }];
    useCommandsStore.setState({
      commands,
      commandsByDirectory: { '/workspace/other': commands },
    });
    listCommandsWithDetailsImpl = async () => commands;

    expect(await useCommandsStore.getState().loadCommands()).toBe(true);
    expect(selectCommandsForDirectory(useCommandsStore.getState(), activeProjectPath)).toEqual(commands);
    expect(await useCommandsStore.getState().loadCommands()).toBe(true);
    expect(listCommandsWithDetailsCalls).toBe(1);
  });

  test('revisiting a cached project restores its mirror without another request', async () => {
    listCommandsWithDetailsImpl = async () => [{ name: 'first' }];
    await useCommandsStore.getState().loadCommands();
    const firstCommands = useCommandsStore.getState().commands;
    activeProjectPath = '/workspace/other';
    listCommandsWithDetailsImpl = async () => [{ name: 'second' }];
    await useCommandsStore.getState().loadCommands();
    activeProjectPath = '/workspace/project';

    await useCommandsStore.getState().loadCommands();
    expect(useCommandsStore.getState().commands).toBe(firstCommands);
    expect(listCommandsWithDetailsCalls).toBe(2);

    invalidateCommandsLoadCache(activeProjectPath);
    listCommandsWithDetailsImpl = async () => [{ name: 'first' }];
    useCommandsStore.setState({ commands: [] });
    await useCommandsStore.getState().loadCommands();
    expect(useCommandsStore.getState().commands).toBe(firstCommands);
  });

  test('a late response only updates its own directory after a project switch', async () => {
    const pending = deferred<Command[]>();
    const started = deferred<void>();
    listCommandsWithDetailsImpl = async (directory) => {
      expect(directory).toBe('/workspace/project');
      started.resolve();
      return pending.promise;
    };
    const firstLoad = useCommandsStore.getState().loadCommands();
    await started.promise;
    activeProjectPath = '/workspace/other';
    listCommandsWithDetailsImpl = async () => [{ name: 'second' }];
    await useCommandsStore.getState().loadCommands();
    const secondCommands = useCommandsStore.getState().commands;
    pending.resolve([{ name: 'first' }]);
    await firstLoad;

    expect(useCommandsStore.getState().commands).toBe(secondCommands);
    expect(selectCommandsForDirectory(useCommandsStore.getState(), '/workspace/project').map(c => c.name)).toEqual(['first']);
  });

  test('successful empty discovery clears only that project and is cached', async () => {
    const commands = [{ name: 'old' }];
    useCommandsStore.setState({ commands, commandsByDirectory: { [activeProjectPath]: commands } });
    expect(await useCommandsStore.getState().loadCommands()).toBe(true);
    expect(selectCommandsForDirectory(useCommandsStore.getState(), activeProjectPath)).toEqual([]);
    expect(useCommandsStore.getState().commands).toEqual([]);
    await useCommandsStore.getState().loadCommands();
    expect(listCommandsWithDetailsCalls).toBe(1);
  });


  test('a failed first load cannot copy the previous project and can recover on retry', async () => {
    const otherCommands = [{ name: 'other-only' }];
    useCommandsStore.setState({ commands: otherCommands, commandsByDirectory: { '/workspace/other': otherCommands } });
    listCommandsWithDetailsImpl = async () => { throw new Error('unavailable'); };
    expect(await useCommandsStore.getState().loadCommands()).toBe(false);
    expect(useCommandsStore.getState().commands).toEqual([]);
    expect(useCommandsStore.getState().commandsByDirectory[activeProjectPath]).toBeUndefined();
    expect(selectCommandsForDirectory(useCommandsStore.getState(), '/workspace/other')).toBe(otherCommands);

    listCommandsWithDetailsImpl = async () => [{ name: 'recovered' }];
    expect(await useCommandsStore.getState().loadCommands()).toBe(true);
    expect(selectCommandsForDirectory(useCommandsStore.getState(), activeProjectPath).map(c => c.name)).toEqual(['recovered']);
  });

  test('an in-flight settings load becomes the active mirror if its project is selected', async () => {
    const pending = deferred<Command[]>();
    listCommandsWithDetailsImpl = () => pending.promise;
    const settingsLoad = useCommandsStore.getState().loadCommands('/workspace/other');
    activeProjectPath = '/workspace/other';
    const activeLoad = useCommandsStore.getState().loadCommands();
    pending.resolve([{ name: 'selected' }]);
    expect(await settingsLoad).toBe(true);
    expect(await activeLoad).toBe(true);
    expect(listCommandsWithDetailsCalls).toBe(1);
    expect(useCommandsStore.getState().commands.map(c => c.name)).toEqual(['selected']);
  });

});
