import { afterEach, beforeEach, describe, expect, spyOn, test } from 'bun:test';
import { opencodeClient } from '@/lib/opencode/client';
import { refreshStoresForCatalogKind } from './catalogRefresh';
import { useProjectsStore } from './useProjectsStore';
import { invalidateCommandsLoadCache, selectCommandsForDirectory, useCommandsStore, type Command } from './useCommandsStore';

const AMBIENT = '/workspace/ambient';
const DRAFT = '/workspace/draft';
const originalList = opencodeClient.listCommands;
const originalProjects = useProjectsStore.getState();
let restoreFetch = () => {};

const names = (directory: string) => selectCommandsForDirectory(useCommandsStore.getState(), directory).map(command => command.name);

beforeEach(() => {
  const fetch = spyOn(globalThis, 'fetch').mockImplementation(async () => Response.json({ scope: 'project', config: {} }));
  restoreFetch = () => fetch.mockRestore();
  useProjectsStore.setState({ projects: [{ id: 'ambient', path: AMBIENT }], activeProjectId: 'ambient' });
  useCommandsStore.getState().resetForRuntimeSwitch();
});

afterEach(() => {
  opencodeClient.listCommands = originalList;
  useProjectsStore.setState(originalProjects);
  restoreFetch();
});

describe('command catalog refresh', () => {
  test('a location event replaces the cold draft list and preserves the ambient mirror', async () => {
    const lists = new Map<string, Command[]>([[AMBIENT, [{ name: 'ambient-command' }]], [DRAFT, []]]);
    const reads: string[] = [];
    opencodeClient.listCommands = async directory => {
      reads.push(directory ?? AMBIENT);
      return lists.get(directory ?? AMBIENT) ?? [];
    };
    await useCommandsStore.getState().loadCommands(AMBIENT);
    await useCommandsStore.getState().loadCommands(DRAFT);
    lists.set(DRAFT, [{ name: 'draft-command' }]);
    reads.length = 0;

    await refreshStoresForCatalogKind('command', [DRAFT, ` ${DRAFT} `, 'global', '']);

    expect(names(DRAFT)).toEqual(['draft-command']);
    expect(useCommandsStore.getState().commands.map(command => command.name)).toEqual(['ambient-command']);
    expect(reads.sort()).toEqual([AMBIENT, DRAFT]);
  });

  test('reopening after an empty cold read asks again without waiting for the TTL', async () => {
    let reads = 0;
    opencodeClient.listCommands = async () => ++reads === 1 ? [] : [{ name: 'ready-command' }];
    await useCommandsStore.getState().loadCommands(DRAFT);
    expect(names(DRAFT)).toEqual([]);
    await useCommandsStore.getState().loadCommands(DRAFT);
    expect(names(DRAFT)).toEqual(['ready-command']);
    await useCommandsStore.getState().loadCommands(DRAFT);
    expect(reads).toBe(2);
  });

  test('a failed event directory preserves its list without blocking another directory', async () => {
    opencodeClient.listCommands = async () => [{ name: 'previous-command' }];
    await useCommandsStore.getState().loadCommands(DRAFT);
    const previous = selectCommandsForDirectory(useCommandsStore.getState(), DRAFT);
    opencodeClient.listCommands = async directory => {
      if (directory === DRAFT) throw new Error('directory unavailable');
      return [{ name: 'updated-command' }];
    };
    const error = spyOn(console, 'error').mockImplementation(() => {});
    try {
      await refreshStoresForCatalogKind('command', [DRAFT, '/workspace/other']);
      expect(selectCommandsForDirectory(useCommandsStore.getState(), DRAFT)).toBe(previous);
      expect(names('/workspace/other')).toEqual(['updated-command']);
      expect(names(AMBIENT)).toEqual(['updated-command']);
    } finally {
      error.mockRestore();
    }
  });

  test('an event during the menu read waits for a fresh list, including callers already joined', async () => {
    let release: (commands: Command[]) => void = () => {};
    let started: () => void = () => {};
    const pending = new Promise<Command[]>(resolve => { release = resolve; });
    const reading = new Promise<void>(resolve => { started = resolve; });
    let reads = 0;
    opencodeClient.listCommands = async () => {
      reads += 1;
      if (reads > 1) return [{ name: 'ready-command' }];
      started();
      return pending;
    };
    const shown: string[][] = [];
    const unsubscribe = useCommandsStore.subscribe(() => shown.push(names(DRAFT)));
    try {
      const first = useCommandsStore.getState().loadCommands(DRAFT);
      await reading;
      const joined = useCommandsStore.getState().loadCommands(DRAFT);
      invalidateCommandsLoadCache(DRAFT);
      const refreshed = useCommandsStore.getState().loadCommands(DRAFT);
      release([{ name: 'obsolete-command' }]);

      expect(await Promise.all([first, joined, refreshed])).toEqual([true, true, true]);
      expect(names(DRAFT)).toEqual(['ready-command']);
      expect(reads).toBe(2);
      expect(shown.flat()).not.toContain('obsolete-command');
    } finally {
      release([]);
      unsubscribe();
    }
  });
});
