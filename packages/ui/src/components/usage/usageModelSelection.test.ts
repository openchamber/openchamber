import { describe, expect, test } from 'bun:test';

import { selectVisibleModelEntries, toggleVisibleModel } from './usageModelSelection';

const entries = [['alpha', 1], ['beta', 2]] as const;

describe('selectVisibleModelEntries', () => {
  test('shows every row when nothing is selected', () => {
    expect(selectVisibleModelEntries('opencode', entries, [])).toEqual(entries);
    expect(selectVisibleModelEntries('claude', entries, [])).toEqual(entries);
  });

  test('shows only the selected rows that still exist', () => {
    expect(selectVisibleModelEntries('opencode', entries, ['alpha', 'removed'])).toEqual([['alpha', 1]]);
    expect(selectVisibleModelEntries('claude', entries, ['alpha', 'removed'])).toEqual([['alpha', 1]]);
  });

  test('recovers the current Zen rows when the saved Zen names are stale', () => {
    expect(selectVisibleModelEntries('opencode', entries, ['removed-go-model'])).toEqual(entries);
  });

  test('keeps a stale selection filtered for every other provider', () => {
    expect(selectVisibleModelEntries('claude', entries, ['removed-model'])).toEqual([]);
    expect(selectVisibleModelEntries('opencode-go', entries, ['removed-model'])).toEqual([]);
  });

  test('keeps an empty list empty', () => {
    expect(selectVisibleModelEntries('opencode', [], ['alpha'])).toEqual([]);
  });
});

describe('toggleVisibleModel', () => {
  const names = ['alpha', 'beta', 'gamma'];

  test('hiding one model with nothing saved keeps every other model shown', () => {
    expect(toggleVisibleModel('google', names, [], 'beta')).toEqual(['alpha', 'gamma']);
  });

  test('hiding one model from a stale Zen selection keeps the other current Zen models', () => {
    expect(toggleVisibleModel('opencode', names, ['removed-go-model'], 'alpha')).toEqual(['beta', 'gamma']);
  });

  test('showing a hidden model adds it to the shown ones', () => {
    expect(toggleVisibleModel('claude', names, ['alpha', 'removed'], 'gamma')).toEqual(['alpha', 'gamma']);
  });

  test('the last shown model stays shown, since an empty selection would show them all', () => {
    expect(toggleVisibleModel('claude', names, ['alpha'], 'alpha')).toEqual(['alpha']);
  });
});
