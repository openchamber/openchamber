import { describe, expect, test } from 'bun:test';

import { browseListMemory, getBrowseParentPath, initialBrowseQuery, joinBrowsePath, projectBrowsePlaces, resolveBrowseQuery, trimTrailingSeparators } from './directoryExplorerStart';

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

  test('keeps filesystem roots when the project is at or directly under one', () => {
    expect(initialBrowseQuery([{ path: 'D:\\' }], home)).toBe('D:/');
    expect(initialBrowseQuery([{ path: 'D:\\repo' }], home)).toBe('D:/');
    expect(initialBrowseQuery([{ path: '/' }], home)).toBe('/');
    expect(initialBrowseQuery([{ path: '/repo' }], home)).toBe('/');
    expect(projectBrowsePlaces([{ path: 'D:\\' }], home)).toEqual(['D:/']);
  });

  test('keeps extended drive roots and UNC share roots when the project is at or directly under one', () => {
    expect(initialBrowseQuery([{ path: '\\\\?\\D:\\' }], home)).toBe('//?/D:/');
    expect(initialBrowseQuery([{ path: '\\\\?\\D:\\repo' }], home)).toBe('//?/D:/');
    expect(initialBrowseQuery([{ path: '\\\\?\\D:\\code\\repo' }], home)).toBe('//?/D:/code/');
    expect(initialBrowseQuery([{ path: '\\\\server\\share\\' }], home)).toBe('//server/share/');
    expect(initialBrowseQuery([{ path: '\\\\server\\share\\repo' }], home)).toBe('//server/share/');
    expect(initialBrowseQuery([{ path: '\\\\?\\UNC\\server\\share\\repo' }], home)).toBe('//?/UNC/server/share/');
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

test('keeps drive roots absolute when preparing a selected path', () => {
  expect(trimTrailingSeparators('D:/')).toBe('D:/');
  expect(trimTrailingSeparators('D:///')).toBe('D:/');
  expect(trimTrailingSeparators('D:/repo/')).toBe('D:/repo');
  expect(trimTrailingSeparators('/')).toBe('/');
  expect(trimTrailingSeparators('D:')).toBe('D:/');
  expect(getBrowseParentPath('D:/')).toBeNull();
  expect(getBrowseParentPath('D:/repo/')).toBe('D:/');
});

test('keeps extended drive roots and UNC share roots absolute and offers no parent above them', () => {
  expect(trimTrailingSeparators('//?/D:/')).toBe('//?/D:/');
  expect(trimTrailingSeparators('//?/D:/repo/')).toBe('//?/D:/repo');
  expect(trimTrailingSeparators('//server/share/')).toBe('//server/share');
  expect(getBrowseParentPath('//?/D:/')).toBeNull();
  expect(getBrowseParentPath('//?/D:/repo/')).toBe('//?/D:/');
  expect(getBrowseParentPath('//server/share/')).toBeNull();
  expect(getBrowseParentPath('//server/share/repo/')).toBe('//server/share/');
  expect(getBrowseParentPath('//?/UNC/server/share/')).toBeNull();
  expect(getBrowseParentPath('//?/UNC/server/share/repo/')).toBe('//?/UNC/server/share/');
});

test('joins a clone destination under any folder with exactly one separator', () => {
  expect(joinBrowsePath('/', 'repo')).toBe('/repo');
  expect(joinBrowsePath('D:/', 'repo')).toBe('D:/repo');
  expect(joinBrowsePath('//?/D:/', 'repo')).toBe('//?/D:/repo');
  expect(joinBrowsePath('//server/share', 'repo')).toBe('//server/share/repo');
  expect(joinBrowsePath('//server/share/', 'repo')).toBe('//server/share/repo');
  expect(joinBrowsePath('/srv/app', 'repo')).toBe('/srv/app/repo');
});

test('walks up home-relative and Unix paths as before', () => {
  expect(getBrowseParentPath('~/')).toBeNull();
  expect(getBrowseParentPath('~/projects/')).toBe('~/');
  expect(getBrowseParentPath('~/projects/app/')).toBe('~/projects/');
  expect(getBrowseParentPath('/')).toBeNull();
  expect(getBrowseParentPath('/srv/')).toBe('/');
  expect(getBrowseParentPath('/srv/app/')).toBe('/srv/');
});

describe('browseListMemory', () => {
  const at = (browseDirectory: string, listedDirectory: string, state: { loading?: boolean; failed?: boolean } = {}) => browseListMemory({
    runtimeKey: 'local', openCodeView: false, browseDirectory, listedDirectory, loading: state.loading ?? false, failed: state.failed ?? false,
  });

  test('returning to a parent through a slow read waits for the parent\'s rows', () => {
    // The child's rows are still listed, then the loading message shows.
    expect(at('/work/', '/work/child')).toEqual({ key: 'explorer:local:/work', ready: false });
    expect(at('/work/', '/work/child', { loading: true }).ready).toBe(false);
    // The parent's rows arrived but the read has not settled yet.
    expect(at('/work/', '/work', { loading: true }).ready).toBe(false);
    expect(at('/work/', '/work').ready).toBe(true);
  });

  test('a failed read is not the folder\'s list', () => {
    expect(at('/work/', '/work', { failed: true }).ready).toBe(false);
  });

  test('folders that differ only in case are separate lists', () => {
    expect(at('/work/Foo', '/work/foo')).toEqual({ key: 'explorer:local:/work/Foo', ready: false });
    expect(at('/work/foo', '/work/foo')).toEqual({ key: 'explorer:local:/work/foo', ready: true });
  });

  test('a filtered folder is its own list, so clearing the filter returns to the full folder\'s offset', () => {
    const view = (filter: string, showHidden = false) => browseListMemory({
      runtimeKey: 'local', openCodeView: false, browseDirectory: '/work/', filter, showHidden, listedDirectory: '/work', loading: false, failed: false,
    });
    expect(view('').key).toBe('explorer:local:/work');
    expect(view('ap')).toEqual({ key: 'explorer:local:/work:filter:ap', ready: true });
    expect(view('', true).key).toBe('explorer:local:/work:hidden');
  });

  test('the OpenCode project list and another runtime keep their own offsets', () => {
    expect(browseListMemory({ runtimeKey: 'remote', openCodeView: true, browseDirectory: '/work', listedDirectory: '', loading: true, failed: false }))
      .toEqual({ key: 'explorer:remote:opencode', ready: true });
    expect(browseListMemory({ runtimeKey: 'remote', openCodeView: false, browseDirectory: '/work', listedDirectory: '/work', loading: false, failed: false }).key)
      .toBe('explorer:remote:/work');
  });
});
