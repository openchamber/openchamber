import { beforeEach, describe, expect, test } from 'bun:test';
import type { Command } from './useCommandsStore';
import { runSessionListNetworkTask } from '../lib/background-network';
import { directoryEnvironment } from './test-support/directoryEnvironment';

const environment = directoryEnvironment({ home: '/workspace', fakeTimers: false });

function deferred<T>() {
  let resolve: (value: T) => void = () => { throw new Error('Promise not initialized'); };
  const promise = new Promise<T>((onResolve) => { resolve = onResolve; });
  return { promise, resolve: (value: T) => resolve(value) };
}

let activeProjectPath = '/workspace/project';

let listCommandsCalls = 0;
let listCommandsImpl: (directory?: string | null) => Promise<Command[]> = async () => [];
// `/api/config/commands/:name/config` answers the stored entity plus where it
// lives; the v2 `CommandInfo` the list returns carries only name + description.
let runtimeFetchImpl: () => Promise<Response> = async () => new Response(
  JSON.stringify({ source: 'md', scope: 'project', path: null, legacy: false, config: {} }),
  { headers: { 'Content-Type': 'application/json' } },
);

const listCommandsMock = async (directory?: string | null) => {
  listCommandsCalls += 1;
  return listCommandsImpl(directory);
};

// These tests read entries per command, as against a server without the batch
// route; `batchEntries` answers that route when a test sets it.
let batchEntries: ((names: string[]) => Promise<Response>) | null = null;
const runtimeFetchMock = async (input: string) => {
  if (!input.startsWith('/api/config/command-configs')) return runtimeFetchImpl();
  if (!batchEntries) return new Response(null, { status: 404 });
  return batchEntries(new URLSearchParams(input.split('?')[1]).getAll('name'));
};

environment.respond(async (url, init) => {
  if (url.pathname === '/api/command') {
    const directory = decodeURIComponent(new Headers(init?.headers).get('x-opencode-directory') ?? '');
    return Response.json({ data: await listCommandsMock(directory) });
  }
  if (url.pathname.startsWith('/api/config/command')) return runtimeFetchMock(`${url.pathname}${url.search}`);
  if (url.pathname === '/api/fs/home') return Response.json({ home: '/workspace', chatsRoot: '/workspace/chats' });
  if (url.pathname === '/api/location' || url.pathname === '/api/session') return Response.json({}, { status: 401 });
  throw new Error(`Unexpected request: ${url}`);
});
const { useProjectsStore } = await import('./useProjectsStore');
const selectProject = (path: string) => {
  activeProjectPath = path;
  useProjectsStore.setState({ projects: [{ id: path, path }], activeProjectId: path });
};

const { useCommandsStore, invalidateCommandsLoadCache, resolveCommandDirectory, selectCommandsForComposer, selectCommandsForDirectory, isCommandOfferedInComposer } = await import('./useCommandsStore');

describe('useCommandsStore', () => {
  beforeEach(() => {
    selectProject('/workspace/project');
    invalidateCommandsLoadCache(activeProjectPath);
    invalidateCommandsLoadCache('/workspace/other');
    listCommandsCalls = 0;
    listCommandsImpl = async () => [];
    runtimeFetchImpl = async () => new Response(
      JSON.stringify({ source: 'md', scope: 'project', path: null, legacy: false, config: {} }),
      { headers: { 'Content-Type': 'application/json' } },
    );

    useCommandsStore.setState({
      selectedCommandName: null,
      commands: [],
      commandsByDirectory: {},
      isLoading: false,
      commandDraft: null,
    });
  });

  test('reads every command entry in one request when the server has the batch route', async () => {
    let perCommandReads = 0;
    const batches: string[][] = [];
    listCommandsImpl = async () => [{ name: 'review' }, { name: 'git/commit' }, { name: 'unknown' }];
    runtimeFetchImpl = async () => {
      perCommandReads += 1;
      return Response.json({});
    };
    batchEntries = async (names) => {
      batches.push(names);
      return Response.json({ commands: [
        { name: 'review', entry: { source: 'none', scope: null, path: null, legacy: false, config: {} } },
        { name: 'git/commit', entry: { source: 'md', scope: 'user', path: '/home/commands/git/commit.md', legacy: false, config: { description: 'Commit' } } },
      ] });
    };
    try {
      expect(await useCommandsStore.getState().loadCommands()).toBe(true);
    } finally {
      batchEntries = null;
    }
    expect(batches).toEqual([['review', 'git/commit', 'unknown']]);
    expect(perCommandReads).toBe(0);
    expect(useCommandsStore.getState().commands).toMatchObject([
      { name: 'review', fromOpenCode: true },
      { name: 'git/commit', scope: 'user', description: 'Commit', path: '/home/commands/git/commit.md' },
      { name: 'unknown' },
    ]);
  });

  test('an invalidated batch metadata read cannot publish stale entries', async () => {
    const pending = deferred<Response>();
    const started = deferred<void>();
    let reads = 0;
    listCommandsImpl = async () => [{ name: 'review' }];
    batchEntries = async () => {
      reads += 1;
      if (reads === 1) {
        started.resolve();
        return pending.promise;
      }
      return Response.json({ commands: [{ name: 'review', entry: { config: { description: 'fresh' } } }] });
    };
    const descriptions: Array<string | undefined> = [];
    const unsubscribe = useCommandsStore.subscribe(state => descriptions.push(state.commands[0]?.description));
    try {
      const first = useCommandsStore.getState().loadCommands();
      await started.promise;
      invalidateCommandsLoadCache(activeProjectPath);
      const refreshed = useCommandsStore.getState().loadCommands();
      pending.resolve(Response.json({ commands: [{ name: 'review', entry: { config: { description: 'stale' } } }] }));
      expect(await Promise.all([first, refreshed])).toEqual([true, true]);
      expect(useCommandsStore.getState().commands[0]?.description).toBe('fresh');
      expect(descriptions).not.toContain('stale');
      expect(reads).toBe(2);
    } finally {
      pending.resolve(Response.json({ commands: [] }));
      unsubscribe();
      batchEntries = null;
    }
  });

  test('command scope enrichment stays bounded and leaves room for session lists', async () => {
    const release = deferred<void>();
    const started = deferred<void>();
    let active = 0;
    let peak = 0;
    listCommandsImpl = async () => Array.from({ length: 24 }, (_, index) => ({ name: `command-${index}` }));
    runtimeFetchImpl = async () => {
      active += 1;
      peak = Math.max(peak, active);
      if (active === 2) started.resolve();
      await release.promise;
      active -= 1;
      return Response.json({ scope: 'project' });
    };
    const load = useCommandsStore.getState().loadCommands();
    try {
      await started.promise;
      expect(peak).toBe(2);
      expect(await runSessionListNetworkTask(async () => 'sessions ready')).toBe('sessions ready');
    } finally {
      release.resolve();
      expect(await load).toBe(true);
    }
    expect(peak).toBe(2);
  });

  test('runtime reset rejects old discovery without deleting a new in-flight request or user draft', async () => {
    const old = deferred<Command[]>();
    const fresh = deferred<Command[]>();
    const draft = { name: 'unsaved', scope: 'project' as const, template: 'keep this draft' };
    useCommandsStore.getState().setCommandDraft(draft);
    listCommandsImpl = () => old.promise;
    const oldLoad = useCommandsStore.getState().loadCommands();
    await Promise.resolve();
    await Promise.resolve();
    useCommandsStore.getState().resetForRuntimeSwitch();
    listCommandsImpl = () => fresh.promise;
    const newLoad = useCommandsStore.getState().loadCommands();
    await Promise.resolve();
    await Promise.resolve();
    old.resolve([{ name: 'old-command' }]);
    expect(await oldLoad).toBe(false);
    expect(useCommandsStore.getState().isLoading).toBe(true);
    const joined = useCommandsStore.getState().loadCommands();
    await Promise.resolve();
    await Promise.resolve();
    expect(listCommandsCalls).toBe(2);
    fresh.resolve([{ name: 'new-command' }]);
    expect(await newLoad).toBe(true);
    expect(await joined).toBe(true);
    expect(useCommandsStore.getState().commands.map((command) => command.name)).toEqual(['new-command']);
    expect(useCommandsStore.getState().commandDraft).toBe(draft);
    useCommandsStore.getState().setCommandDraft(null);
  });

  test('responses from old-runtime command mutations cannot alter the new runtime cache', async () => {
    const actions = [
      () => useCommandsStore.getState().createCommand({ name: 'same', template: 'old template' }),
      () => useCommandsStore.getState().updateCommand('same', { template: 'old template' }),
      () => useCommandsStore.getState().deleteCommand('same'),
    ];
    for (const action of actions) {
      const response = deferred<Response>();
      runtimeFetchImpl = () => response.promise;
      const pending = action();
      useCommandsStore.getState().resetForRuntimeSwitch();
      const current = [{ name: 'same', template: 'new runtime template' }];
      useCommandsStore.setState({ commands: current, commandsByDirectory: { [activeProjectPath]: current } });
      response.resolve(Response.json({ requiresManualRestart: true }));
      expect(await pending).toBe(false);
      expect(useCommandsStore.getState().commands).toBe(current);
    }
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
    listCommandsImpl = async () => [
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
    listCommandsImpl = async () => {
      throw new Error('network down');
    };

    const result = await useCommandsStore.getState().loadCommands();

    expect(result).toBe(false);
    expect(listCommandsCalls).toBe(3);
    expect(useCommandsStore.getState().commands).toEqual(previousCommands);
    expect(useCommandsStore.getState().isLoading).toBe(false);
  });

  test('first load publishes a directory even when its commands match the previous project', async () => {
    const commands = [{ name: 'shared', scope: 'project' as const, path: null, legacy: false }];
    useCommandsStore.setState({
      commands,
      commandsByDirectory: { '/workspace/other': commands },
    });
    listCommandsImpl = async () => commands;

    expect(await useCommandsStore.getState().loadCommands()).toBe(true);
    expect(selectCommandsForDirectory(useCommandsStore.getState(), activeProjectPath)).toEqual(commands);
    expect(await useCommandsStore.getState().loadCommands()).toBe(true);
    expect(listCommandsCalls).toBe(1);
  });

  test('revisiting a cached project restores its mirror without another request', async () => {
    listCommandsImpl = async () => [{ name: 'first' }];
    await useCommandsStore.getState().loadCommands();
    const firstCommands = useCommandsStore.getState().commands;
    selectProject('/workspace/other');
    listCommandsImpl = async () => [{ name: 'second' }];
    await useCommandsStore.getState().loadCommands();
    selectProject('/workspace/project');

    await useCommandsStore.getState().loadCommands();
    expect(useCommandsStore.getState().commands).toBe(firstCommands);
    expect(listCommandsCalls).toBe(2);

    invalidateCommandsLoadCache(activeProjectPath);
    listCommandsImpl = async () => [{ name: 'first' }];
    useCommandsStore.setState({ commands: [] });
    await useCommandsStore.getState().loadCommands();
    expect(useCommandsStore.getState().commands).toBe(firstCommands);
  });

  test('a late response only updates its own directory after a project switch', async () => {
    const pending = deferred<Command[]>();
    const started = deferred<void>();
    listCommandsImpl = async (directory) => {
      expect(directory).toBe('/workspace/project');
      started.resolve();
      return pending.promise;
    };
    const firstLoad = useCommandsStore.getState().loadCommands();
    await started.promise;
    selectProject('/workspace/other');
    listCommandsImpl = async () => [{ name: 'second' }];
    await useCommandsStore.getState().loadCommands();
    const secondCommands = useCommandsStore.getState().commands;
    pending.resolve([{ name: 'first' }]);
    await firstLoad;

    expect(useCommandsStore.getState().commands).toBe(secondCommands);
    expect(selectCommandsForDirectory(useCommandsStore.getState(), '/workspace/project').map(c => c.name)).toEqual(['first']);
  });

  test('successful empty discovery clears only that project and allows a fresh read', async () => {
    const commands = [{ name: 'old' }];
    useCommandsStore.setState({ commands, commandsByDirectory: { [activeProjectPath]: commands } });
    expect(await useCommandsStore.getState().loadCommands()).toBe(true);
    expect(selectCommandsForDirectory(useCommandsStore.getState(), activeProjectPath)).toEqual([]);
    expect(useCommandsStore.getState().commands).toEqual([]);
    await useCommandsStore.getState().loadCommands();
    expect(listCommandsCalls).toBe(2);
  });


  test('a failed first load cannot copy the previous project and can recover on retry', async () => {
    const otherCommands = [{ name: 'other-only' }];
    useCommandsStore.setState({ commands: otherCommands, commandsByDirectory: { '/workspace/other': otherCommands } });
    listCommandsImpl = async () => { throw new Error('unavailable'); };
    expect(await useCommandsStore.getState().loadCommands()).toBe(false);
    expect(useCommandsStore.getState().commands).toEqual([]);
    expect(useCommandsStore.getState().commandsByDirectory[activeProjectPath]).toBeUndefined();
    expect(selectCommandsForDirectory(useCommandsStore.getState(), '/workspace/other')).toBe(otherCommands);

    listCommandsImpl = async () => [{ name: 'recovered' }];
    expect(await useCommandsStore.getState().loadCommands()).toBe(true);
    expect(selectCommandsForDirectory(useCommandsStore.getState(), activeProjectPath).map(c => c.name)).toEqual(['recovered']);
  });

  test('an in-flight settings load becomes the active mirror if its project is selected', async () => {
    const pending = deferred<Command[]>();
    listCommandsImpl = () => pending.promise;
    const settingsLoad = useCommandsStore.getState().loadCommands('/workspace/other');
    selectProject('/workspace/other');
    const activeLoad = useCommandsStore.getState().loadCommands();
    pending.resolve([{ name: 'selected' }]);
    expect(await settingsLoad).toBe(true);
    expect(await activeLoad).toBe(true);
    expect(listCommandsCalls).toBe(1);
    expect(useCommandsStore.getState().commands.map(c => c.name)).toEqual(['selected']);
  });

  test('a worktree draft reads the commands of the folder its session starts in, once that folder is known', () => {
    const worktreeRoot = '/repo/worktrees/feature';
    const folder = `${worktreeRoot}/ai`;
    const resolved = { open: true, worktreeStartDirectory: { worktreeRoot, directory: folder } };

    expect(resolveCommandDirectory(worktreeRoot, resolved)).toEqual({ status: 'resolved', directory: folder });
    expect(resolveCommandDirectory(`${worktreeRoot}/`, resolved)).toEqual({ status: 'resolved', directory: folder });
    // Another worktree, a closed draft, a composer that shows no draft, or no directory: unchanged.
    expect(resolveCommandDirectory('/repo/worktrees/other', resolved)).toEqual({ status: 'resolved', directory: '/repo/worktrees/other' });
    expect(resolveCommandDirectory(worktreeRoot, { ...resolved, open: false })).toEqual({ status: 'resolved', directory: worktreeRoot });
    expect(resolveCommandDirectory(worktreeRoot, null)).toEqual({ status: 'resolved', directory: worktreeRoot });
    expect(resolveCommandDirectory(null, resolved)).toEqual({ status: 'resolved', directory: null });
  });

  test('a worktree draft whose start folder is still resolving lists nothing and requests nothing', () => {
    const worktreeRoot = '/repo/worktrees/feature';
    const pending = { open: true, worktreeStartDirectory: { worktreeRoot, directory: null } };
    const rootOnly = [{ name: 'root-only', description: '', template: '', scope: 'project' as const }];
    useCommandsStore.setState({ commandsByDirectory: { [worktreeRoot]: rootOnly } });

    expect(resolveCommandDirectory(worktreeRoot, pending)).toEqual({ status: 'pending' });
    // The root's cached commands are not offered for a draft that has not resolved its folder.
    expect(selectCommandsForComposer(useCommandsStore.getState(), { status: 'pending' })).toEqual([]);
    expect(selectCommandsForComposer(useCommandsStore.getState(), { status: 'resolved', directory: worktreeRoot })).toBe(rootOnly);
  });

  test('a worktree draft whose start folder fell back to the root lists the root', () => {
    const worktreeRoot = '/repo/worktrees/feature';
    const fallback = { open: true, worktreeStartDirectory: { worktreeRoot, directory: worktreeRoot } };

    expect(resolveCommandDirectory(worktreeRoot, fallback)).toEqual({ status: 'resolved', directory: worktreeRoot });
  });

  test('a pinned root session keeps its own directory beside a subfolder draft', () => {
    const worktreeRoot = '/repo/worktrees/feature';
    const folder = `${worktreeRoot}/ai`;
    const draft = { open: true, worktreeStartDirectory: { worktreeRoot, directory: folder } };

    // The main composer maps the draft; the pinned column passes no draft and stays on the root.
    expect(resolveCommandDirectory(worktreeRoot, draft)).toEqual({ status: 'resolved', directory: folder });
    expect(resolveCommandDirectory(worktreeRoot, null)).toEqual({ status: 'resolved', directory: worktreeRoot });
  });

});

describe('isCommandOfferedInComposer', () => {
  test('hides OpenCode\'s own /goal but keeps a user command of that name', () => {
    expect(isCommandOfferedInComposer({ name: 'goal', fromOpenCode: true })).toBe(false);
    expect(isCommandOfferedInComposer({ name: 'goal', scope: 'project' })).toBe(true);
    // A failed metadata read leaves the command unclassified: keep it.
    expect(isCommandOfferedInComposer({ name: 'goal' })).toBe(true);
    expect(isCommandOfferedInComposer({ name: 'review' })).toBe(true);
  });
});
