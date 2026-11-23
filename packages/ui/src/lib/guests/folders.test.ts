import { describe, expect, test } from 'bun:test';

import { guestsInScope, isGuestInFolders, isGuestTabHidden, keepGuestItemsInScope, setGuestScopePaths, useGuestScopeStore, withPendingFolder } from './folders';
import type { InstalledGuest } from './types';

const guest = (id: string, folders?: string[]): InstalledGuest => ({
  id,
  name: id,
  icon: 'apps',
  capabilities: { requested: [], granted: [] },
  folders,
});

describe('isGuestInFolders', () => {
  test('a guest without folders is everywhere, even with nothing open', () => {
    expect(isGuestInFolders(guest('a'), [])).toBe(true);
  });

  test('a limited guest shows inside its folders only', () => {
    const flow = guest('flow', ['/Users/me/projects/flow']);
    expect(isGuestInFolders(flow, ['/Users/me/projects/flow/skunkworks'])).toBe(true);
    expect(isGuestInFolders(flow, ['/Users/me/projects/flow'])).toBe(true);
    expect(isGuestInFolders(flow, ['/Users/me/projects/flowers'])).toBe(false);
    expect(isGuestInFolders(flow, [])).toBe(false);
  });

  test('Windows paths compare without case, POSIX paths with it', () => {
    const flow = guest('flow', ['c:\\users\\alex\\projects\\flow']);
    expect(isGuestInFolders(flow, ['C:/Users/Alex/Projects/Flow'])).toBe(true);
    expect(isGuestInFolders(flow, ['C:/Users/Alex/Projects/Flowers'])).toBe(false);
    expect(isGuestInFolders(guest('unc', ['\\\\server\\share\\flow']), ['//SERVER/Share/Flow/app'])).toBe(true);
    expect(isGuestInFolders(guest('posix', ['/work/Flow']), ['/work/flow'])).toBe(false);
    expect(isGuestInFolders(guest('root', ['/']), ['/work/flow'])).toBe(true);
  });

  test('a worktree outside the folder counts through its project', () => {
    const flow = guest('flow', ['/Users/me/projects/flow/']);
    expect(isGuestInFolders(flow, ['/Users/me/.local/share/opencode/worktree/abc/fix', '/Users/me/projects/flow/skunkworks'])).toBe(true);
  });
});

describe('guestsInScope', () => {
  test('keeps the same array while the members stay the same', () => {
    const guests = [guest('a'), guest('flow', ['/work/flow']), guest('personal', ['/work/personal'])];
    const inFlow = guestsInScope(guests, ['/work/flow/app']);
    expect(inFlow.map((entry) => entry.id)).toEqual(['a', 'flow']);
    expect(guestsInScope(guests, ['/work/flow/other'])).toBe(inFlow);
    expect(guestsInScope(guests, ['/work/personal/x']).map((entry) => entry.id)).toEqual(['a', 'personal']);
  });

  test('returns the catalog itself when nothing is limited out', () => {
    const guests = [guest('a'), guest('flow', ['/work/flow'])];
    expect(guestsInScope(guests, ['/work/flow'])).toBe(guests);
  });
});

describe('setGuestScopePaths', () => {
  test('normalizes, drops empty and repeated paths, and skips an unchanged scope', () => {
    setGuestScopePaths(['/work/flow/', null, '/work/flow', undefined]);
    const first = useGuestScopeStore.getState().paths;
    expect(first).toEqual(['/work/flow']);
    setGuestScopePaths(['/work/flow']);
    expect(useGuestScopeStore.getState().paths).toBe(first);
  });
});

describe('keepGuestItemsInScope', () => {
  const rows = [{ guestId: 'flow' }, { guestId: 'everywhere' }, { guestId: 'gone' }];
  const guests = [guest('flow', ['/Users/me/projects/flow']), guest('everywhere')];

  test('drops the rows of an extension whose folders leave the place out', () => {
    expect(keepGuestItemsInScope(rows, guests, ['/Users/me/projects/personal/site'])).toEqual([{ guestId: 'everywhere' }, { guestId: 'gone' }]);
  });

  test('returns the same list when every row stays', () => {
    expect(keepGuestItemsInScope(rows, guests, ['/Users/me/projects/flow/skunkworks'])).toBe(rows);
  });
});

describe('withPendingFolder', () => {
  test('a folder typed but not added still counts', () => {
    expect(withPendingFolder(['/work'], ' ~/projects/flow ')).toEqual(['/work', '~/projects/flow']);
    expect(withPendingFolder(['/work'], '/work')).toEqual(['/work']);
    expect(withPendingFolder(['/work'], '  ')).toEqual(['/work']);
  });

  test('a relative one stops the install instead of being dropped', () => {
    expect(withPendingFolder([], 'projects/flow')).toBeNull();
  });
});

describe('isGuestTabHidden', () => {
  const flow = guest('flow', ['/Users/me/projects/flow']);
  const loaded = { loaded: true, guests: [flow, guest('everywhere')] };
  const WORKTREE = '/Users/me/.local/share/opencode/worktree/abc/fix';

  test('a tab restored in a project outside the folders stays hidden', () => {
    expect(isGuestTabHidden('flow', loaded, ['/Users/me/projects/personal/site'])).toBe(true);
    expect(isGuestTabHidden('everywhere', loaded, ['/Users/me/projects/personal/site'])).toBe(false);
  });

  test('a worktree tab waits hidden for its project, then shows once the project is known', () => {
    expect(isGuestTabHidden('flow', loaded, [WORKTREE])).toBe(true);
    expect(isGuestTabHidden('flow', loaded, [WORKTREE, '/Users/me/projects/flow'])).toBe(false);
  });

  test('every extension tab waits for the catalog; one the catalog no longer has is left to its pane', () => {
    expect(isGuestTabHidden('everywhere', { loaded: false, guests: [] }, ['/Users/me/projects/flow'])).toBe(true);
    expect(isGuestTabHidden('gone', loaded, ['/Users/me/projects/flow'])).toBe(false);
  });
});
