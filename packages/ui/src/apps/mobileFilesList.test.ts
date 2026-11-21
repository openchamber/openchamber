import { expect, test } from 'bun:test';
import { mobileFilesList, type MobileFilesListedFor } from './mobileFilesList';

const noResults: MobileFilesListedFor | null = null;
const noError: string | null = null;
const base = {
  runtimeKey: 'local',
  query: '',
  entriesDirectory: '/repo',
  directoryError: noError,
  searchResultsFor: noResults,
  isSearching: false,
};
const browser = { type: 'browser' as const, directory: '/repo' };

test('Back from a search result keeps the query\'s rows while the search re-runs', () => {
  const results = { ...base, query: 'app', searchResultsFor: { directory: '/repo', query: 'app' } };
  const before = mobileFilesList({ ...results, route: browser });
  expect(before).toEqual({ key: 'search:local:/repo:app', ready: true, searchLoading: false });

  // The opened file replaces the list: no list, nothing recorded.
  expect(mobileFilesList({ ...results, route: { type: 'file', path: '/repo/app.ts', returnDirectory: '/repo' } }).key).toBeNull();

  // Back re-runs the search; the delayed response must not swap the rows for a
  // loading placeholder, which would clamp the restored offset and be saved.
  const returning = mobileFilesList({ ...results, route: browser, isSearching: true });
  expect(returning).toEqual(before);
});

test('rows of another query or folder are not the list', () => {
  const typing = mobileFilesList({
    ...base, route: browser, query: 'apps', isSearching: true, searchResultsFor: { directory: '/repo', query: 'app' },
  });
  expect(typing).toEqual({ key: 'search:local:/repo:apps', ready: false, searchLoading: true });

  const otherFolder = mobileFilesList({
    ...base, route: { type: 'browser', directory: '/repo/src' }, query: 'app',
    searchResultsFor: { directory: '/repo', query: 'app' },
  });
  expect(otherFolder.ready).toBe(false);
});

test('a failed search or a folder error over the rows is not the list', () => {
  // A failed search leaves no rows of its own; the empty state must not be
  // restored against or saved as the query's offset.
  const failed = mobileFilesList({ ...base, route: browser, query: 'app' });
  expect(failed).toEqual({ key: 'search:local:/repo:app', ready: false, searchLoading: false });

  const shadowed = mobileFilesList({
    ...base, route: browser, query: 'app', directoryError: 'EACCES', searchResultsFor: { directory: '/repo', query: 'app' },
  });
  expect(shadowed.ready).toBe(false);
});

test('a folder is its list only once its own read succeeded', () => {
  const child = { type: 'browser' as const, directory: '/repo/src' };
  expect(mobileFilesList({ ...base, route: child }).ready).toBe(false);
  expect(mobileFilesList({ ...base, route: child, entriesDirectory: '/repo/src' }).ready).toBe(true);
  expect(mobileFilesList({ ...base, route: child, entriesDirectory: '/repo/src', directoryError: 'EACCES' }).ready).toBe(false);
});
