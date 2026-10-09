import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import React, { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import type { GitStatus, RuntimeAPIs } from '@/lib/api/types';
import { RuntimeAPIContext } from '@/contexts/runtimeAPIContext';
import { useGitStore } from '@/stores/useGitStore';
import { installHookTestDom } from '../test-utils/testDom';
import { useProjectRepoStatus } from './useProjectRepoStatus';

type Project = { id: string; path: string; normalizedPath: string; sidebarCollapsed?: boolean };

// SAFETY: the hook only passes `git` through to the store's `ensureStatus`, which these tests replace.
const runtimeAPIs = { git: {} } as RuntimeAPIs;
const status: GitStatus = { current: 'main', tracking: null, ahead: 0, behind: 0, files: [], isClean: true };
const project = (id: string, extra: Partial<Project> = {}): Project => ({ id, path: `/${id}`, normalizedPath: `/${id}`, ...extra });
const noRepoStatus = new Map<string, { isGitRepo: boolean | null; branch: string | null }>();
const ignore = () => undefined;

const Probe: React.FC<{ projects: Project[] }> = ({ projects }) => {
  useProjectRepoStatus({
    normalizedProjects: projects,
    gitRepoStatus: noRepoStatus,
    setProjectRepoStatus: ignore,
    setProjectRootBranches: ignore,
  });
  return null;
};

describe('useProjectRepoStatus', () => {
  const originalEnsureStatus = useGitStore.getState().ensureStatus;
  let dom: ReturnType<typeof installHookTestDom>;
  let root: Root;
  let reads: string[];
  let failing: Set<string>;

  beforeEach(() => {
    dom = installHookTestDom();
    root = createRoot(dom.container);
    reads = [];
    failing = new Set();
    useGitStore.setState({
      directories: new Map(),
      ensureStatus: async (directory) => {
        reads.push(directory);
        if (failing.has(directory)) return;
        useGitStore.getState().setActiveDirectory(directory);
        const previous = useGitStore.getState().getDirectoryState(directory);
        if (!previous) throw new Error('Missing repository state');
        const directories = new Map(useGitStore.getState().directories);
        directories.set(directory, { ...previous, isGitRepo: true, status });
        useGitStore.setState({ directories });
      },
    });
  });

  afterEach(async () => {
    await act(async () => root.unmount());
    useGitStore.setState({ directories: new Map(), activeDirectory: null, ensureStatus: originalEnsureStatus });
    dom.restore();
  });

  const render = (projects: Project[]) => act(async () => {
    root.render(
      <RuntimeAPIContext.Provider value={runtimeAPIs}>
        <Probe projects={projects} />
      </RuntimeAPIContext.Provider>,
    );
  });

  test('a UI-only change to the project list reads no status; a new project reads its own', async () => {
    await render([project('a'), project('b')]);
    expect(reads).toEqual(['/a', '/b']);

    // Collapsing a project rebuilds the list with the same paths.
    await render([project('a', { sidebarCollapsed: true }), project('b')]);
    await render([project('a'), project('b')]);
    expect(reads).toEqual(['/a', '/b']);

    await render([project('a'), project('b'), project('c')]);
    expect(reads).toEqual(['/a', '/b', '/c']);
  });

  test('a failed read is retried on the next list change; a removed and re-added project is read again', async () => {
    failing.add('/b');
    await render([project('a'), project('b')]);
    expect(reads).toEqual(['/a', '/b']);

    failing.clear();
    await render([project('a', { sidebarCollapsed: true }), project('b')]);
    expect(reads).toEqual(['/a', '/b', '/b']);

    await render([project('b')]);
    await render([project('a'), project('b')]);
    expect(reads).toEqual(['/a', '/b', '/b', '/a']);
  });
});
