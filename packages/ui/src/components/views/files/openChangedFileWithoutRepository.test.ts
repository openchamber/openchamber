import { afterEach, beforeEach, describe, expect, spyOn, test } from 'bun:test';

import { toast } from '@/components/ui';
import type { FilesAPI } from '@/lib/api/types';
import { getRuntimeKey, switchRuntimeEndpoint } from '@/lib/runtime-switch';
import { useUIStore } from '@/stores/useUIStore';
import { useSessionUIStore } from '@/sync/session-ui-store';

import {
  beginChangedFileOpen,
  createLatestRequestGate,
  isProjectFileOutsideRepositories,
  openChangedFileWithoutRepository,
} from './openChangedFileWithoutRepository';

const ROOT = '/plain-project';

type Deferred<T> = { promise: Promise<T>; resolve: (value: T) => void };
const deferred = <T,>(): Deferred<T> => {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((done) => { resolve = done; });
  return { promise, resolve };
};

const createFiles = (overrides: Partial<FilesAPI>): FilesAPI => ({
  listDirectory: async () => ({ directory: ROOT, entries: [] }),
  search: async () => [],
  createDirectory: async (path) => ({ success: true, path }),
  ...overrides,
});

const presentFile = (content: string) => createFiles({
  statFile: async (path) => ({ path, isFile: true, size: content.length }),
  readFile: async (path) => ({ content, path }),
});

const contextPanel = () => useUIStore.getState().contextPanelByDirectory[ROOT];
const openTabs = () => (contextPanel()?.tabs ?? [])
  .filter((tab) => tab.mode === 'file')
  .map((tab) => tab.targetPath);
const activeTab = () => {
  const panel = contextPanel();
  return panel?.tabs.find((tab) => tab.id === panel.activeTabId)?.targetPath ?? null;
};

describe('isProjectFileOutsideRepositories', () => {
  const noRepositories: string[] = [];
  const known = { rootDirectory: ROOT, rootIsGitRepo: false, nestedRepos: noRepositories, repositories: noRepositories };

  test('holds for a file in a project that is no repository and has none inside', () => {
    expect(isProjectFileOutsideRepositories(`${ROOT}/notes.md`, known)).toBe(true);
  });

  test('keeps Changes for a repository project, a repository holding the file, or a file outside the project', () => {
    expect(isProjectFileOutsideRepositories(`${ROOT}/notes.md`, { ...known, rootIsGitRepo: true })).toBe(false);
    expect(isProjectFileOutsideRepositories(`${ROOT}/app/notes.md`, { ...known, nestedRepos: [`${ROOT}/app`] })).toBe(false);
    expect(isProjectFileOutsideRepositories(`${ROOT}/app/notes.md`, { ...known, repositories: [`${ROOT}/app`] })).toBe(false);
    expect(isProjectFileOutsideRepositories('/elsewhere/notes.md', known)).toBe(false);
  });

  test('keeps Changes while repository discovery is unknown, failed or unsupported', () => {
    expect(isProjectFileOutsideRepositories(`${ROOT}/notes.md`, { ...known, rootIsGitRepo: null })).toBe(false);
    expect(isProjectFileOutsideRepositories(`${ROOT}/notes.md`, { ...known, nestedRepos: undefined })).toBe(false);
    expect(isProjectFileOutsideRepositories(`${ROOT}/notes.md`, { ...known, nestedRepos: null })).toBe(false);
    expect(isProjectFileOutsideRepositories(`${ROOT}/notes.md`, { ...known, nestedRepos: 'unsupported' })).toBe(false);
  });
});

describe('openChangedFileWithoutRepository', () => {
  let toastError: ReturnType<typeof spyOn>;

  beforeEach(() => {
    useUIStore.setState({ contextPanelByDirectory: {} });
    useSessionUIStore.setState({ currentSessionId: null });
    toastError = spyOn(toast, 'error').mockImplementation(() => 'toast');
  });

  afterEach(() => {
    toastError.mockRestore();
  });

  test('opens a readable file, an empty one included', async () => {
    const gate = createLatestRequestGate();
    expect(await openChangedFileWithoutRepository(`${ROOT}/empty.md`, ROOT, presentFile(''), gate.begin())).toBe(true);
    expect(openTabs()).toEqual([`${ROOT}/empty.md`]);
    expect(toastError).not.toHaveBeenCalled();
  });

  test('a deleted file the optional read answers with empty success shows not found and opens nothing', async () => {
    const files = createFiles({
      statFile: async () => {
        throw new Error('File not found');
      },
      readFile: async (path) => ({ content: '', path }),
    });
    expect(await openChangedFileWithoutRepository(`${ROOT}/gone.md`, ROOT, files, createLatestRequestGate().begin())).toBe(false);
    expect(openTabs()).toEqual([]);
    expect(toastError).toHaveBeenCalledTimes(1);
  });

  test('a binary file shows its toast and opens nothing', async () => {
    const files = createFiles({
      statFile: async (path) => ({ path, isFile: true, size: 8 }),
      readFile: async (path) => ({ content: '\u0000\u0001binary', path }),
    });
    expect(await openChangedFileWithoutRepository(`${ROOT}/binary.txt`, ROOT, files, createLatestRequestGate().begin())).toBe(false);
    expect(openTabs()).toEqual([]);
    expect(toastError).toHaveBeenCalledTimes(1);
  });

  test('of two clicks answered out of order, only the newer one opens', async () => {
    const gate = createLatestRequestGate();
    const firstRead = deferred<{ content: string; path: string }>();
    const secondRead = deferred<{ content: string; path: string }>();
    const files = createFiles({
      statFile: async (path) => ({ path, isFile: true, size: 4 }),
      readFile: (path) => (path === `${ROOT}/first.md` ? firstRead.promise : secondRead.promise),
    });

    const first = openChangedFileWithoutRepository(`${ROOT}/first.md`, ROOT, files, beginChangedFileOpen(gate, null));
    const second = openChangedFileWithoutRepository(`${ROOT}/second.md`, ROOT, files, beginChangedFileOpen(gate, null));
    secondRead.resolve({ content: 'new', path: `${ROOT}/second.md` });
    await second;
    firstRead.resolve({ content: 'old', path: `${ROOT}/first.md` });
    await first;

    expect(openTabs()).toEqual([`${ROOT}/second.md`]);
    expect(activeTab()).toBe(`${ROOT}/second.md`);
  });

  const pendingOpen = (isCurrent: () => boolean) => {
    const read = deferred<{ content: string; path: string }>();
    const files = createFiles({
      statFile: async (path) => ({ path, isFile: true, size: 4 }),
      readFile: () => read.promise,
    });
    const done = openChangedFileWithoutRepository(`${ROOT}/notes.md`, ROOT, files, isCurrent);
    return async (content: string) => {
      read.resolve({ content, path: `${ROOT}/notes.md` });
      await done;
    };
  };

  test('a request from a session no longer on screen neither opens nor toasts', async () => {
    useSessionUIStore.setState({ currentSessionId: 'session-a' });
    const finish = pendingOpen(beginChangedFileOpen(createLatestRequestGate(), 'session-a'));
    useSessionUIStore.setState({ currentSessionId: 'session-b' });
    await finish('\u0000\u0001binary');
    expect(openTabs()).toEqual([]);
    expect(toastError).not.toHaveBeenCalled();
  });

  test('a newer click cancels an open still reading, before the newer one starts its own', async () => {
    const gate = createLatestRequestGate();
    const finish = pendingOpen(beginChangedFileOpen(gate, null));
    gate.cancel();
    await finish('notes');
    expect(openTabs()).toEqual([]);
    expect(toastError).not.toHaveBeenCalled();
  });

  test('a request from a runtime left and returned to neither opens nor toasts', async () => {
    const runtimeKey = getRuntimeKey();
    const finish = pendingOpen(beginChangedFileOpen(createLatestRequestGate(), null));
    switchRuntimeEndpoint({ apiBaseUrl: 'https://other.test', runtimeKey: 'changed-file-other' });
    switchRuntimeEndpoint({ apiBaseUrl: 'https://local.test', runtimeKey });
    await finish('notes');
    expect(openTabs()).toEqual([]);
    expect(toastError).not.toHaveBeenCalled();
  });
});
