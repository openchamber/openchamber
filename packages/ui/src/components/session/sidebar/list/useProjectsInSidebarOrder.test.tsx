import React, { act } from 'react';
import { createRoot } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import type { Session } from '@/lib/opencode/model';
import type { ProjectEntry } from '@/lib/api/types';
import { useGlobalSessionsStore } from '@/stores/useGlobalSessionsStore';
import { useSpacesStore } from '@/lib/spaces/spaces-store';
import { useProjectsStore } from '@/stores/useProjectsStore';
import { useSessionDisplayStore, type ProjectSortOrder } from '@/stores/useSessionDisplayStore';
import { installHookTestDom } from '../test-utils/testDom';
import { useProjectsInSidebarOrder } from './useProjectsInSidebarOrder';

const projects: ProjectEntry[] = [
  { id: 'charlie', path: '/repos/charlie', label: 'Charlie', addedAt: 100, lastOpenedAt: 300 },
  { id: 'alpha', path: '/repos/alpha', label: 'Alpha', addedAt: 400, lastOpenedAt: 400 },
  { id: 'delta', path: '/repos/delta', label: 'Delta', addedAt: 200, lastOpenedAt: 200 },
  { id: 'bravo', path: '/repos/bravo', label: 'Bravo', addedAt: 300, lastOpenedAt: 100 },
];

const session = (id: string, directory: string, updated: number): Session => ({
  id,
  directory,
  projectID: 'global',
  title: id,
  cost: 0,
  tokens: { input: 0, output: 0, reasoning: 0, cache: { read: 0, write: 0 } },
  time: { created: updated, updated },
});

const initialProjects = useProjectsStore.getState();
const initialDisplay = useSessionDisplayStore.getState();
const initialSpaces = useSpacesStore.getState();

describe('useProjectsInSidebarOrder', () => {
  let dom: ReturnType<typeof installHookTestDom>;
  let root: ReturnType<typeof createRoot>;
  let shown: string[] = [];
  let shownList: readonly { id: string }[] = [];
  let renders = 0;

  const Harness = ({ items, enabled }: { items: readonly { id: string }[]; enabled?: boolean }) => {
    renders += 1;
    shownList = useProjectsInSidebarOrder(items, enabled);
    shown = shownList.map((item) => item.id);
    return null;
  };

  beforeEach(() => {
    dom = installHookTestDom();
    root = createRoot(dom.container);
    renders = 0;
    useGlobalSessionsStore.getState().resetForRuntimeSwitch();
    useProjectsStore.setState({ projects, manualProjectOrder: ['delta', 'bravo', 'charlie', 'alpha'] });
    useSessionDisplayStore.setState({ sidebarViewMode: 'projects', projectSortOrder: 'manual' });
  });

  afterEach(async () => {
    await act(async () => root.unmount());
    dom.restore();
    useGlobalSessionsStore.getState().resetForRuntimeSwitch();
    useProjectsStore.setState(initialProjects, true);
    useSessionDisplayStore.setState(initialDisplay, true);
    useSpacesStore.setState(initialSpaces, true);
  });

  test('follows each sidebar sort and re-sorts when the sidebar sort changes', async () => {
    await act(async () => root.render(<Harness items={projects} />));
    expect(shown).toEqual(['delta', 'bravo', 'charlie', 'alpha']);

    const expected: Array<[ProjectSortOrder, string[]]> = [
      ['a-z', ['alpha', 'bravo', 'charlie', 'delta']],
      ['z-a', ['delta', 'charlie', 'bravo', 'alpha']],
      ['date-added', ['alpha', 'bravo', 'delta', 'charlie']],
      ['recent', ['alpha', 'charlie', 'delta', 'bravo']],
    ];
    for (const [order, ids] of expected) {
      await act(async () => useSessionDisplayStore.setState({ projectSortOrder: order }));
      expect(shown).toEqual(ids);
    }
  });

  test('follows the stored sort whatever the old List view setting says', async () => {
    useSessionDisplayStore.setState({ sidebarViewMode: 'timeline', projectSortOrder: 'a-z' });
    await act(async () => root.render(<Harness items={projects} />));
    expect(shown).toEqual(['alpha', 'bravo', 'charlie', 'delta']);
  });

  test('Recent ranks by the newest session in each project, worktrees included by path', async () => {
    useSessionDisplayStore.setState({ projectSortOrder: 'recent' });
    await act(async () => root.render(<Harness items={projects} />));
    // No sessions yet: last opened first, as the sidebar before sessions load.
    expect(shown).toEqual(['alpha', 'charlie', 'delta', 'bravo']);

    await act(async () => useGlobalSessionsStore.getState().applySnapshot([
      session('in-bravo', '/repos/bravo/src', 900),
      session('in-delta', '/repos/delta', 500),
      session('elsewhere', '/tmp/other', 10_000),
    ], []));
    expect(shown).toEqual(['bravo', 'delta', 'alpha', 'charlie']);

    // A newer session in the project already on top moves nothing: same list object.
    const before = shownList;
    await act(async () => useGlobalSessionsStore.getState().applySnapshot([
      session('in-bravo', '/repos/bravo/src', 950),
      session('in-delta', '/repos/delta', 500),
    ], []));
    expect(shownList).toBe(before);
  });

  test('entries that are not projects stay first, and a closed list reads nothing', async () => {
    const withChat = [{ id: 'chat' }, ...projects];
    useSessionDisplayStore.setState({ projectSortOrder: 'recent' });
    await act(async () => root.render(<Harness items={withChat} enabled={false} />));
    expect(shown).toEqual(['chat', 'charlie', 'alpha', 'delta', 'bravo']);

    const closedRenders = renders;
    await act(async () => useGlobalSessionsStore.getState().applySnapshot([session('in-bravo', '/repos/bravo', 900)], []));
    await act(async () => useSpacesStore.setState({ spaces: new Map(), journey: new Map() }));
    expect(renders).toBe(closedRenders);

    await act(async () => root.render(<Harness items={withChat} enabled />));
    expect(shown).toEqual(['chat', 'bravo', 'alpha', 'charlie', 'delta']);

    // Closing again keeps that order while the popup fades out.
    await act(async () => root.render(<Harness items={withChat} enabled={false} />));
    expect(shown).toEqual(['chat', 'bravo', 'alpha', 'charlie', 'delta']);
  });

  test('an empty list renders without error', async () => {
    await act(async () => root.render(<Harness items={[]} />));
    expect(shown).toEqual([]);
  });
});
