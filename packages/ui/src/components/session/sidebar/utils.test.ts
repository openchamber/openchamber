import { describe, expect, test } from 'bun:test';
import {
  isPathWithinProject,
  mergeExpandedParentKeys,
  replaceAutoExpandedParentKeys,
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

describe('replaceAutoExpandedParentKeys', () => {
  test('replaces the previous navigation path instead of accumulating parents', () => {
    const first = replaceAutoExpandedParentKeys(new Set(), 'parent-a');
    const second = replaceAutoExpandedParentKeys(first, 'parent-b');

    expect(second).toEqual(new Set([
      'project:active:parent-b',
      'project:archived:parent-b',
      'recent:active:parent-b',
      'recent:archived:parent-b',
    ]));
    expect([...second].some((key) => key.endsWith('parent-a'))).toBe(false);
  });

  test('preserves the set reference when the current parent is unchanged', () => {
    const current = replaceAutoExpandedParentKeys(new Set(), 'parent-a');
    expect(replaceAutoExpandedParentKeys(current, 'parent-a')).toBe(current);
  });

  test('clears automatic expansion for a root session', () => {
    expect(replaceAutoExpandedParentKeys(new Set(['project:active:parent-a']), null)).toEqual(new Set());
  });
});

describe('parent expansion state', () => {
  const recentKey = 'recent:active:parent-a';

  test('manually expands a parent in the recent section', () => {
    const next = toggleExpandedParentKey(new Set(), new Set(), new Set(), recentKey);
    expect(next.manual).toEqual(new Set([recentKey]));
    expect(mergeExpandedParentKeys(next.manual, new Set(), next.suppressedAutomatic).has(recentKey)).toBe(true);
  });

  test('manual collapse overrides automatic expansion for the active parent', () => {
    const automatic = new Set([recentKey]);
    const collapsed = toggleExpandedParentKey(new Set(), automatic, new Set(), recentKey);
    expect(collapsed.manual.has(recentKey)).toBe(false);
    expect(collapsed.suppressedAutomatic).toEqual(new Set([recentKey]));
    expect(mergeExpandedParentKeys(collapsed.manual, automatic, collapsed.suppressedAutomatic).has(recentKey)).toBe(false);
  });

  test('expands a suppressed automatic parent on the next toggle', () => {
    const automatic = new Set([recentKey]);
    const expanded = toggleExpandedParentKey(new Set(), automatic, new Set([recentKey]), recentKey);
    expect(expanded.suppressedAutomatic.size).toBe(0);
    expect(mergeExpandedParentKeys(expanded.manual, automatic, expanded.suppressedAutomatic).has(recentKey)).toBe(true);
  });
});
