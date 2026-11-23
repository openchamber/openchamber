import { afterEach, beforeEach, describe, expect, test } from 'bun:test';

import { useProjectsStore } from '@/stores/useProjectsStore';
import { useUIStore } from '@/stores/useUIStore';
import { useSessionUIStore } from '@/sync/session-ui-store';

import { closeGuestTabsOutsideChangedFolders } from './tabs';
import type { InstalledGuest } from './types';

const originalUI = useUIStore.getState();
const originalProjects = useProjectsStore.getState();
const originalSessionUI = useSessionUIStore.getState();
afterEach(() => {
  useUIStore.setState(originalUI, true);
  useProjectsStore.setState(originalProjects, true);
  useSessionUIStore.setState(originalSessionUI, true);
});

const PROJECT = '/home/me/projects/flow/skunkworks';
const WORKTREE = '/home/me/.local/share/opencode/worktree/abc/fix';
const OUTSIDE = '/home/me/projects/personal/site';

const flow = (folders?: string[]): InstalledGuest => ({
  id: 'flow', name: 'Flow', icon: 'apps', capabilities: { requested: [], granted: [] }, folders,
});

const openModes = () => Object.fromEntries(Object.entries(useUIStore.getState().contextPanelByDirectory)
  .map(([directory, state]) => [directory, state.tabs.map((tab) => tab.mode)]));

beforeEach(() => {
  useProjectsStore.setState({ projects: [{ id: 'sk', path: PROJECT }, { id: 'site', path: OUTSIDE }] });
  useSessionUIStore.setState({
    availableWorktreesByProject: new Map([[PROJECT, [{ path: WORKTREE, projectDirectory: PROJECT, branch: 'fix', label: 'fix' }]]]),
  });
  for (const directory of [PROJECT, WORKTREE, OUTSIDE]) {
    useUIStore.getState().openContextPanelTab(directory, { mode: 'plugin:flow' });
  }
});

describe('closeGuestTabsOutsideChangedFolders', () => {
  test('a new limit closes tabs outside it and keeps a worktree of a project inside it', () => {
    closeGuestTabsOutsideChangedFolders([flow()], [flow(['/home/me/projects/flow'])]);

    const modes = openModes();
    expect(modes[PROJECT]).toEqual(['plugin:flow']);
    expect(modes[WORKTREE]).toEqual(['plugin:flow']);
    expect(modes[OUTSIDE]).toEqual([]);
  });

  test('a worktree whose project is not known yet keeps its tab', () => {
    useSessionUIStore.setState({ availableWorktreesByProject: new Map() });
    closeGuestTabsOutsideChangedFolders([flow()], [flow(['/home/me/projects/flow'])]);

    const modes = openModes();
    expect(modes[WORKTREE]).toEqual(['plugin:flow']);
    expect(modes[OUTSIDE]).toEqual([]);
  });

  test('the first catalog this window reads closes nothing', () => {
    closeGuestTabsOutsideChangedFolders([], [flow(['/home/me/projects/flow'])]);

    expect(openModes()[OUTSIDE]).toEqual(['plugin:flow']);
  });
});
