import { describe, expect, test } from 'bun:test';

import { initialBrowseQuery } from './directoryExplorerStart';

describe('initialBrowseQuery', () => {
  const home = '/Users/me';

  test('starts at home when there is no project yet', () => {
    expect(initialBrowseQuery([], home)).toBe('~/');
  });

  test('starts in the folder of the most recently added project', () => {
    const projects = [
      { path: '/Users/me/work/old', addedAt: 1 },
      { path: '/Users/me/projects/newest', addedAt: 9 },
      { path: '/srv/repos/mid', addedAt: 5 },
    ];
    expect(initialBrowseQuery(projects, home)).toBe('~/projects/');
  });

  test('keeps a folder outside home absolute, and falls back to the last entry without dates', () => {
    expect(initialBrowseQuery([{ path: '/Users/me/a' }, { path: 'D:\\code\\repo\\' }], home)).toBe('D:/code/');
    expect(initialBrowseQuery([{ path: '/Users/me/repo' }], home)).toBe('~/');
  });
});
