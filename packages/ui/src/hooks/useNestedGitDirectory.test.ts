import React, { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import { Window } from 'happy-dom';

import { RuntimeAPIContext } from '@/contexts/runtimeAPIContext';
import type { GitStatus } from '@/lib/api/types';
import { useGitStore } from '@/stores/useGitStore';

import { createWebAPIs } from '../../../web/src/api/index';

import { resolveRepositoryOptions, shouldDiscoverNestedRepositories, useNestedGitDirectory } from './useNestedGitDirectory';

describe('shouldDiscoverNestedRepositories', () => {
  test('runs for a root that is not a repository', () => {
    expect(shouldDiscoverNestedRepositories(false, false)).toBe(true);
  });

  test('runs for an unborn root repository', () => {
    expect(shouldDiscoverNestedRepositories(true, true)).toBe(true);
  });

  test('stays off for an established root repository', () => {
    expect(shouldDiscoverNestedRepositories(true, false)).toBe(false);
  });

  test('waits while the root has not probed', () => {
    expect(shouldDiscoverNestedRepositories(null, false)).toBe(false);
  });
});

describe('resolveRepositoryOptions', () => {
  const root = '/project';
  const nested = ['/project/one', '/project/two'];

  test('an unborn root lists itself first, then the nested repositories', () => {
    expect(resolveRepositoryOptions({
      root,
      rootIsGitRepo: true,
      rootIsUnborn: true,
      nestedRepos: { repositories: nested, complete: true },
      nestedRepoSelection: null,
    })).toEqual([root, ...nested]);
  });

  test('an unborn root with no nested repositories has no picker', () => {
    expect(resolveRepositoryOptions({
      root,
      rootIsGitRepo: true,
      rootIsUnborn: true,
      nestedRepos: { repositories: [], complete: true },
      nestedRepoSelection: null,
    })).toBeNull();
  });

  test('a non-repository root lists the discovered repositories once one is selected', () => {
    expect(resolveRepositoryOptions({
      root,
      rootIsGitRepo: false,
      rootIsUnborn: false,
      nestedRepos: { repositories: nested, complete: true },
      nestedRepoSelection: nested[1],
    })).toEqual(nested);
  });

  test('a non-repository root with nothing selected has no picker yet', () => {
    expect(resolveRepositoryOptions({
      root,
      rootIsGitRepo: false,
      rootIsUnborn: false,
      nestedRepos: { repositories: nested, complete: true },
      nestedRepoSelection: null,
    })).toBeNull();
  });

  test('a non-repository root lists the repositories once every one was stale-cleared', () => {
    expect(resolveRepositoryOptions({
      root,
      rootIsGitRepo: false,
      rootIsUnborn: false,
      nestedRepos: { repositories: nested, complete: true },
      nestedRepoSelection: null,
      staleClearedSelections: new Set(nested),
    })).toEqual(nested);
  });

  test('a non-repository root keeps waiting while an eligible candidate remains', () => {
    for (const staleClearedSelections of [undefined, null, new Set<string>(), new Set([nested[0]])]) {
      expect(resolveRepositoryOptions({
        root,
        rootIsGitRepo: false,
        rootIsUnborn: false,
        nestedRepos: { repositories: nested, complete: true },
        nestedRepoSelection: null,
        staleClearedSelections,
      })).toBeNull();
    }
  });

  test('a root-valued selection counts as none when every repository was stale-cleared', () => {
    expect(resolveRepositoryOptions({
      root,
      rootIsGitRepo: false,
      rootIsUnborn: false,
      nestedRepos: { repositories: nested, complete: true },
      nestedRepoSelection: root,
      staleClearedSelections: new Set(nested),
    })).toEqual(nested);
  });

  test('an unborn root still lists itself first when every repository was stale-cleared', () => {
    expect(resolveRepositoryOptions({
      root,
      rootIsGitRepo: true,
      rootIsUnborn: true,
      nestedRepos: { repositories: nested, complete: true },
      nestedRepoSelection: null,
      staleClearedSelections: new Set(nested),
    })).toEqual([root, ...nested]);
  });

  test('an established root has no picker even when every repository was stale-cleared', () => {
    expect(resolveRepositoryOptions({
      root,
      rootIsGitRepo: true,
      rootIsUnborn: false,
      nestedRepos: { repositories: nested, complete: true },
      nestedRepoSelection: null,
      staleClearedSelections: new Set(nested),
    })).toBeNull();
  });

  test('an established root has no picker even with a stored selection', () => {
    expect(resolveRepositoryOptions({
      root,
      rootIsGitRepo: true,
      rootIsUnborn: false,
      nestedRepos: { repositories: nested, complete: true },
      nestedRepoSelection: nested[0],
    })).toBeNull();
  });

  test('failed, unsupported, and not-yet-run discovery has no picker', () => {
    for (const nestedRepos of [null, 'unsupported', undefined] as const) {
      expect(resolveRepositoryOptions({
        root,
        rootIsGitRepo: false,
        rootIsUnborn: false,
        nestedRepos,
        nestedRepoSelection: nested[0],
      })).toBeNull();
    }
  });

  test('a root-valued selection counts as no selection for a non-repository root', () => {
    expect(resolveRepositoryOptions({
      root,
      rootIsGitRepo: false,
      rootIsUnborn: false,
      nestedRepos: { repositories: nested, complete: true },
      nestedRepoSelection: root,
    })).toBeNull();
  });

  test('an unborn root still lists itself first when the selection is the root', () => {
    expect(resolveRepositoryOptions({
      root,
      rootIsGitRepo: true,
      rootIsUnborn: true,
      nestedRepos: { repositories: nested, complete: true },
      nestedRepoSelection: root,
    })).toEqual([root, ...nested]);
  });
});

// The resolution flow (root probe, discovery, auto-select, stale recovery)
// runs through React effects, so it needs a mounted hook and a DOM.
describe('useNestedGitDirectory resolution flow', () => {
  type DirectoryGitState = NonNullable<ReturnType<ReturnType<typeof useGitStore.getState>['getDirectoryState']>>;
  type GitAPI = Parameters<ReturnType<typeof useGitStore.getState>['fetchStatus']>[1];

  const DOM_GLOBAL_NAMES = [
    'window', 'document', 'navigator', 'Node', 'Element', 'HTMLElement', 'localStorage',
    'getComputedStyle', 'ResizeObserver', 'requestAnimationFrame', 'cancelAnimationFrame',
    'IS_REACT_ACT_ENVIRONMENT',
  ] as const;

  const installDom = () => {
    const win = new Window({ url: 'http://localhost' });
    const previous = DOM_GLOBAL_NAMES.map((name) => [name, Object.getOwnPropertyDescriptor(globalThis, name)] as const);
    const values = {
      window: win, document: win.document, navigator: win.navigator, Node: win.Node,
      Element: win.Element, HTMLElement: win.HTMLElement, localStorage: win.localStorage,
      getComputedStyle: win.getComputedStyle.bind(win), ResizeObserver: win.ResizeObserver,
      requestAnimationFrame: win.requestAnimationFrame.bind(win),
      cancelAnimationFrame: win.cancelAnimationFrame.bind(win), IS_REACT_ACT_ENVIRONMENT: true,
    };
    for (const name of DOM_GLOBAL_NAMES) {
      Object.defineProperty(globalThis, name, { value: values[name], configurable: true, writable: true });
    }
    const container = document.createElement('div');
    document.body.appendChild(container);
    return {
      container,
      restore: () => {
        for (const [name, descriptor] of previous) {
          if (descriptor) Object.defineProperty(globalThis, name, descriptor);
          else Reflect.deleteProperty(globalThis, name);
        }
        void win.happyDOM.close();
      },
    };
  };

  const createStatus = (unborn: boolean): GitStatus => ({
    current: 'main',
    tracking: null,
    ahead: 0,
    behind: 0,
    files: [],
    isClean: true,
    unborn,
  });

  const createDirectoryState = (isGitRepo: boolean | null, status: GitStatus | null): DirectoryGitState => ({
    isGitRepo,
    status,
    branches: null,
    log: null,
    identity: null,
    diffCache: new Map(),
    indexRevision: 0,
    lastRepoCheckAt: 0,
    lastStatusFetch: 0,
    lastStatusChange: 0,
    lastLogFetch: 0,
    lastBranchesFetch: 0,
    lastIdentityFetch: 0,
    logMaxCount: 25,
    isLoadingStatus: false,
    isLoadingLog: false,
    isLoadingBranches: false,
    isLoadingIdentity: false,
  });

  let dom: ReturnType<typeof installDom>;
  let root: Root;
  const apis = createWebAPIs();

  beforeEach(() => {
    dom = installDom();
    root = createRoot(dom.container);
    useGitStore.setState({
      ensureStatus: async () => {},
      recheckRepository: async () => true,
      ensureNestedRepos: async () => {},
      selectNestedRepo: () => {},
      clearNestedRepoSelection: () => {},
      directories: new Map(),
      nestedReposByRoot: new Map(),
      nestedRepoSelection: new Map(),
      staleClearedSelections: new Map(),
    });
  });

  afterEach(async () => {
    await act(async () => root.unmount());
    dom.restore();
  });

  const renderHook = async (directory: string, options: { enabled?: boolean; recheckOnOpen?: boolean } = {}) => {
    let result: ReturnType<typeof useNestedGitDirectory> | null = null;
    const Harness: React.FC = () => {
      result = useNestedGitDirectory(directory, options);
      return null;
    };
    await act(async () => {
      root.render(
        React.createElement(RuntimeAPIContext.Provider, { value: apis }, React.createElement(Harness)),
      );
    });
    return { current: () => result };
  };

  test('re-probes a root cached as unborn when the surface opens', async () => {
    useGitStore.setState({ directories: new Map([['/root', createDirectoryState(true, createStatus(true))]]) });
    const rechecked: Array<[string, GitAPI]> = [];
    useGitStore.setState({
      recheckRepository: async (directory, git) => {
        rechecked.push([directory, git]);
        return true;
      },
    });

    await renderHook('/root', { recheckOnOpen: true });

    expect(rechecked).toEqual([['/root', apis.git]]);
  });

  test('leaves an established root alone when the surface opens', async () => {
    useGitStore.setState({ directories: new Map([['/root', createDirectoryState(true, createStatus(false))]]) });
    const rechecked: Array<[string, GitAPI]> = [];
    useGitStore.setState({
      recheckRepository: async (directory, git) => {
        rechecked.push([directory, git]);
        return true;
      },
    });

    await renderHook('/root', { recheckOnOpen: true });

    expect(rechecked).toEqual([]);
  });

  test('still re-probes a root cached as not a repository', async () => {
    useGitStore.setState({ directories: new Map([['/root', createDirectoryState(false, null)]]) });
    const rechecked: Array<[string, GitAPI]> = [];
    useGitStore.setState({
      recheckRepository: async (directory, git) => {
        rechecked.push([directory, git]);
        return true;
      },
    });

    await renderHook('/root', { recheckOnOpen: true });

    expect(rechecked).toEqual([['/root', apis.git]]);
  });

  test('auto-selects a nested repository when the stored selection is the root itself', async () => {
    useGitStore.setState({
      directories: new Map([['/root', createDirectoryState(false, null)]]),
      nestedReposByRoot: new Map([['/root', { repositories: ['/root/nested'], complete: true }]]),
      nestedRepoSelection: new Map([['/root', '/root']]),
    });
    const selections: Array<[string, string]> = [];
    useGitStore.setState({
      selectNestedRepo: (directory, repository) => {
        selections.push([directory, repository]);
      },
    });

    await renderHook('/root');

    expect(selections).toEqual([['/root', '/root/nested']]);
  });

  test('offers the picker when every discovered repository was stale-cleared', async () => {
    useGitStore.setState({
      directories: new Map([['/root', createDirectoryState(false, null)]]),
      nestedReposByRoot: new Map([['/root', { repositories: ['/root/one', '/root/two'], complete: true }]]),
      staleClearedSelections: new Map([['/root', new Set(['/root/one', '/root/two'])]]),
    });
    const selections: Array<[string, string]> = [];
    useGitStore.setState({
      selectNestedRepo: (directory, repository) => {
        selections.push([directory, repository]);
      },
    });

    const hook = await renderHook('/root');

    expect(hook.current()?.repositoryOptions).toEqual(['/root/one', '/root/two']);
    expect(selections).toEqual([]);
  });

  test('keeps an existing nested selection untouched', async () => {
    useGitStore.setState({
      directories: new Map([['/root', createDirectoryState(false, null)]]),
      nestedReposByRoot: new Map([['/root', { repositories: ['/root/one', '/root/two'], complete: true }]]),
      nestedRepoSelection: new Map([['/root', '/root/two']]),
    });
    const selections: Array<[string, string]> = [];
    useGitStore.setState({
      selectNestedRepo: (directory, repository) => {
        selections.push([directory, repository]);
      },
    });

    await renderHook('/root');

    expect(selections).toEqual([]);
  });
});
