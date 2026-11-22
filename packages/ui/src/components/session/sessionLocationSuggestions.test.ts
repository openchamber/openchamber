import { describe, expect, test } from 'bun:test';
import type { WorktreeMetadata } from '@/types/worktree';
import { buildSessionLocationSuggestions, expandSessionLocationInput } from './sessionLocationSuggestions';

const worktree = (overrides: Partial<WorktreeMetadata>): WorktreeMetadata => ({
  path: '/repo/.worktrees/feature',
  projectDirectory: '/repo',
  branch: 'feature',
  label: 'feature',
  worktreeStatus: 'ready',
  worktreeSource: 'existing',
  ...overrides,
});

describe('expandSessionLocationInput', () => {
  test('expands a leading tilde against the home directory', () => {
    expect(expandSessionLocationInput('~/git/repo', '/Users/me')).toBe('/Users/me/git/repo');
    expect(expandSessionLocationInput(' ~ ', '/Users/me/')).toBe('/Users/me');
  });

  test('leaves other input as typed, trimmed', () => {
    expect(expandSessionLocationInput('  /abs/path ', '/Users/me')).toBe('/abs/path');
    expect(expandSessionLocationInput('~other/path', '/Users/me')).toBe('~other/path');
    expect(expandSessionLocationInput('~/x', '')).toBe('~/x');
  });
});

describe('buildSessionLocationSuggestions', () => {
  test('lists each project root followed by its ready worktrees, named by branch', () => {
    const suggestions = buildSessionLocationSuggestions({
      projects: [{ path: '/repo', label: 'Repo' }, { path: '/other/' }],
      worktreesByProject: new Map([
        ['/repo', [
          worktree({}),
          worktree({ path: '/repo/.worktrees/pending', branch: 'pending', worktreeStatus: 'pending' }),
        ]],
      ]),
      currentDirectory: '/gone',
    });

    expect(suggestions).toEqual([
      { path: '/repo', label: 'Repo', branch: null },
      { path: '/repo/.worktrees/feature', label: 'feature', branch: 'feature' },
      { path: '/other', label: 'other', branch: null },
    ]);
  });

  test('leaves out the folder the session is already in and duplicates', () => {
    const suggestions = buildSessionLocationSuggestions({
      projects: [{ path: '/repo' }, { path: '/repo/' }],
      worktreesByProject: new Map([['/repo', [worktree({ path: '/repo/.worktrees/feature/' })]]]),
      currentDirectory: '/repo/.worktrees/feature',
    });

    expect(suggestions.map((suggestion) => suggestion.path)).toEqual(['/repo']);
  });
});
