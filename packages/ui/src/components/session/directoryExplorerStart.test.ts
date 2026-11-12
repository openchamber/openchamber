import { describe, expect, test } from 'bun:test';

import { initialBrowseQuery, projectBrowsePlaces, resolveBrowseQuery, trimTrailingBrowseSeparators } from './directoryExplorerStart';

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

  test('keeps filesystem roots as browseable absolute paths', () => {
    expect(initialBrowseQuery([{ path: 'D:\\' }], home)).toBe('D:/');
    expect(initialBrowseQuery([{ path: 'D:\\repo' }], home)).toBe('D:/');
    expect(initialBrowseQuery([{ path: '/repo' }], home)).toBe('/');
    expect(initialBrowseQuery([{ path: '/' }], home)).toBe('/');
  });
});

describe('projectBrowsePlaces', () => {
  const home = '/home/me';

  test('lists the folders holding projects, latest first, once each, home left out', () => {
    expect(projectBrowsePlaces([
      { path: '/home/me/code/a', addedAt: 1 },
      { path: '/home/me/work/b', addedAt: 3 },
      { path: '/home/me/code/c', addedAt: 2 },
      { path: '/home/me/d', addedAt: 4 },
      { path: '/srv/e', addedAt: 0 },
      { path: '  ', addedAt: 9 },
    ], home)).toEqual(['~/work/', '~/code/', '/srv/']);
  });

  test('keeps the three latest', () => {
    expect(projectBrowsePlaces([
      { path: '/a/x', addedAt: 4 },
      { path: '/b/x', addedAt: 3 },
      { path: '/c/x', addedAt: 2 },
      { path: '/d/x', addedAt: 1 },
    ], home)).toEqual(['/a/', '/b/', '/c/']);
  });

  test('lists drive and filesystem roots as absolute places', () => {
    expect(projectBrowsePlaces([
      { path: 'D:\\', addedAt: 2 },
      { path: '/repo', addedAt: 1 },
    ], home)).toEqual(['D:/', '/']);
  });
});

describe('resolveBrowseQuery', () => {
  test('puts a name without a root into the browsed folder', () => {
    expect(resolveBrowseQuery('new-app', '~/projects/')).toBe('~/projects/new-app');
    expect(resolveBrowseQuery('a/b', '/srv/')).toBe('/srv/a/b');
    expect(resolveBrowseQuery('', '~/projects/')).toBe('~/projects/');
    expect(resolveBrowseQuery('~project', '~/')).toBe('~/~project');
  });

  test('keeps a rooted path as typed', () => {
    for (const query of ['~', '~/code/', '/srv/app', 'C:/code']) {
      expect(resolveBrowseQuery(query, '~/projects/')).toBe(query);
    }
    expect(resolveBrowseQuery(' /srv/app', '~/projects/')).toBe('/srv/app');
  });
});

describe('trimTrailingBrowseSeparators', () => {
  test('preserves roots when preparing a folder for selection', () => {
    expect(trimTrailingBrowseSeparators('D:/')).toBe('D:/');
    expect(trimTrailingBrowseSeparators('/')).toBe('/');
    expect(trimTrailingBrowseSeparators('D:/repo/')).toBe('D:/repo');
    expect(trimTrailingBrowseSeparators('/repo/')).toBe('/repo');
  });
});
