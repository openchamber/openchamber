import { describe, expect, test } from 'bun:test';
import {
  isPathWithinProject,
  selectExpandedParentKeysForContext,
  toggleExpandedParentKey,
} from './utils';

describe('isPathWithinProject', () => {
  test('matches child directories for root projects', () => {
    expect(isPathWithinProject('/workspace/app', '/')).toBe(true);
  });

  test('matches exact project directories', () => {
    expect(isPathWithinProject('/workspace/app', '/workspace/app')).toBe(true);
  });

  test('does not match sibling directory prefixes', () => {
    expect(isPathWithinProject('/workspace/app2', '/workspace/app')).toBe(false);
  });

  test('returns false when directory is null', () => {
    expect(isPathWithinProject(null, '/workspace/app')).toBe(false);
  });

  test('returns false when projectPath is null', () => {
    expect(isPathWithinProject('/workspace/app', null)).toBe(false);
  });

  test('matches deep child directories', () => {
    expect(isPathWithinProject('/workspace/app/sub/dir', '/workspace/app')).toBe(true);
  });
});

describe('selectExpandedParentKeysForContext', () => {
  test('keeps project and recent expansion state isolated', () => {
    const expanded = new Set([
      'project:active:parent-a',
      'project:archived:parent-b',
      'recent:active:parent-a',
    ]);

    expect(selectExpandedParentKeysForContext(new Set(), expanded, 'project')).toEqual(new Set([
      'project:active:parent-a',
      'project:archived:parent-b',
    ]));
    expect(selectExpandedParentKeysForContext(new Set(), expanded, 'recent')).toEqual(new Set([
      'recent:active:parent-a',
    ]));
  });

  test('preserves a context projection when only another context changes', () => {
    const recent = new Set(['recent:active:parent-a']);
    const expanded = new Set(['recent:active:parent-a', 'project:active:parent-a']);

    expect(selectExpandedParentKeysForContext(recent, expanded, 'recent')).toBe(recent);
  });
});

describe('parent expansion state', () => {
  const recentKey = 'recent:active:parent-a';
  const projectKey = 'project:active:parent-a';

  test('manually expands and collapses a parent', () => {
    const expanded = toggleExpandedParentKey(new Set(), recentKey);
    expect(expanded).toEqual(new Set([recentKey]));
    expect(toggleExpandedParentKey(expanded, recentKey)).toEqual(new Set());
  });

  test('does not change the other render context', () => {
    const recentExpanded = new Set([recentKey]);
    const bothExpanded = toggleExpandedParentKey(recentExpanded, projectKey);
    const projectCollapsed = toggleExpandedParentKey(bothExpanded, projectKey);

    expect(selectExpandedParentKeysForContext(new Set(), bothExpanded, 'recent')).toEqual(new Set([recentKey]));
    expect(selectExpandedParentKeysForContext(new Set(), projectCollapsed, 'recent')).toEqual(new Set([recentKey]));
  });
});
