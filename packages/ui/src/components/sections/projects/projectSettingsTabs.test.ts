import { describe, expect, test } from 'bun:test';
import { SETTINGS_ANCHOR_PAGES } from '@/lib/settings/search';
import { projectSettingsTabAnchors, projectSettingsTabForSearchTarget } from './projectSettingsTabs';

// Shown in the page header above every tab, so no tab has to open for them.
const HEADER_TARGETS = new Set(['projects.name', 'projects.icon', 'projects.close']);

describe('project settings search targets', () => {
  test('the repository notes and todos option opens the General tab', () => {
    expect(projectSettingsTabForSearchTarget('projects.notes-todos.repository')).toBe('general');
    expect(projectSettingsTabAnchors('general')).toContain('projects.notes-todos.repository');
  });

  test('every project search target below the header opens a tab', () => {
    const projectTargets = [...SETTINGS_ANCHOR_PAGES]
      .filter(([id, page]) => page === 'projects' && !HEADER_TARGETS.has(id))
      .map(([id]) => id);
    expect(projectTargets.filter((id) => projectSettingsTabForSearchTarget(id) === null)).toEqual([]);
  });
});
