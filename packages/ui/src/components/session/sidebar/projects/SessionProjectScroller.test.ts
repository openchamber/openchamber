import { describe, expect, test } from 'bun:test';
import { buildGroupRenderDescriptors, resolveSearchResultPlacement, selectRenderedProjectSections } from './sessionProjectRender';
import type { SessionGroup } from '../types';
import { useSessionDisplayStore } from '@/stores/useSessionDisplayStore';

const makeGroup = (id: string, overrides: Partial<SessionGroup> = {}): SessionGroup => ({
  id,
  label: id,
  branch: null,
  description: null,
  isMain: id === 'main',
  worktree: null,
  directory: '/workspace',
  sessions: [],
  ...overrides,
});

describe('buildGroupRenderDescriptors', () => {
  test('renders the main group and archived bucket for the main workspace', () => {
    const section = {
      project: { id: 'project-a', normalizedPath: '/workspace' },
      groups: [makeGroup('main'), makeGroup('archived', { isArchivedBucket: true })],
    };

    expect(buildGroupRenderDescriptors(section, { mainWorkspaceOnly: true })).toEqual([
      {
        group: section.groups[0],
        groupKey: 'project-a:main',
        projectId: 'project-a',
        hideGroupLabel: true,
      },
      {
        group: section.groups[1],
        groupKey: 'project-a:archived',
        projectId: 'project-a',
        hideGroupLabel: false,
      },
    ]);
  });

  test('renders the primary group without a label and nested groups with labels', () => {
    const section = {
      project: { id: 'project-a', normalizedPath: '/workspace' },
      groups: [makeGroup('main'), makeGroup('feature')],
    };

    expect(buildGroupRenderDescriptors(section, { mainWorkspaceOnly: false })).toEqual([
      {
        group: section.groups[0],
        groupKey: 'project-a:main',
        projectId: 'project-a',
        hideGroupLabel: true,
      },
      {
        group: section.groups[1],
        groupKey: 'project-a:feature',
        projectId: 'project-a',
        hideGroupLabel: false,
      },
    ]);
  });

  test('keeps labels when a flat section has no main group', () => {
    const section = {
      project: { id: 'project-a', normalizedPath: '/workspace' },
      groups: [makeGroup('feature', { isMain: false }), makeGroup('other', { isMain: false })],
    };

    expect(buildGroupRenderDescriptors(section, { mainWorkspaceOnly: false }).map((descriptor) => descriptor.hideGroupLabel)).toEqual([false, false]);
  });
});

describe('single-project scroller projection', () => {
  test('renders only the selected project from persisted display state', () => {
    const previous = useSessionDisplayStore.getState();
    const sections = [
      { project: { id: 'project-a', normalizedPath: '/workspace/a' }, groups: [] },
      { project: { id: 'project-b', normalizedPath: '/workspace/b' }, groups: [] },
    ];

    try {
      useSessionDisplayStore.setState({ projectDisplayMode: 'single', singleProjectId: 'project-b' });
      const state = useSessionDisplayStore.getState();

      expect(selectRenderedProjectSections(sections, state.projectDisplayMode === 'single', state.singleProjectId)
        .map((section) => section.project.id)).toEqual(['project-b']);
    } finally {
      useSessionDisplayStore.setState(previous, true);
    }
  });
});

// Issue #3200: a query matching only a managed chat leaves no project section to
// render. The chats live in the scroller's top content, so answering with the
// empty state there hid a result the header was already counting.
describe('resolveSearchResultPlacement', () => {
  test('keeps the top content when the only match lives there', () => {
    expect(resolveSearchResultPlacement(true)).toBe('top-content');
  });

  test('falls back to the empty state when nothing matched anywhere', () => {
    expect(resolveSearchResultPlacement(false)).toBe('empty-state');
  });
});
