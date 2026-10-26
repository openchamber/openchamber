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

const Probe: React.FC<{ projects: Project[]; enabled?: boolean }> = ({ projects, enabled = true }) => {
  useProjectRepoStatus({
    normalizedProjects: projects,
    enabled,
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

  const render = (projects: Project[], enabled = true, apis: RuntimeAPIs = runtimeAPIs) => act(async () => {
    root.render(
      <RuntimeAPIContext.Provider value={apis}>
        <Probe projects={projects} enabled={enabled} />
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

  test('hidden it reads nothing and keeps its paths; shown again it re-ensures each known path once', async () => {
    await render([project('a'), project('b')]);
    expect(reads).toEqual(['/a', '/b']);

    await render([project('a'), project('b')], false);
    await render([project('a', { sidebarCollapsed: true }), project('b')], false);
    expect(reads).toEqual(['/a', '/b']);

    // ensureStatus itself skips a path read within its staleness window.
    await render([project('a'), project('b')]);
    expect(reads).toEqual(['/a', '/b', '/a', '/b']);
    await render([project('a'), project('b')]);
    expect(reads).toEqual(['/a', '/b', '/a', '/b']);
  });

  test('new paths are prefetched in one batch before the per-project reads', async () => {
    const events: string[] = [];
    // SAFETY: the hook only calls `prefetchProjectStatuses` and passes `git` through to the store's `ensureStatus`, which these tests replace.
    const batchingAPIs = { git: {
      prefetchProjectStatuses: async (directories: string[]) => {
        events.push(`prefetch:${directories.join(',')}`);
      },
    } } as RuntimeAPIs;
    const ensureStatus = useGitStore.getState().ensureStatus;
    useGitStore.setState({
      ensureStatus: async (directory, git) => {
        events.push(`read:${directory}`);
        await ensureStatus(directory, git);
      },
    });

    await render([project('a'), project('b')], true, batchingAPIs);
    expect(events).toEqual(['prefetch:/a,/b', 'read:/a', 'read:/b']);

    await render([project('a'), project('b'), project('c')], true, batchingAPIs);
    expect(events).toEqual(['prefetch:/a,/b', 'read:/a', 'read:/b', 'prefetch:/c', 'read:/c']);
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
