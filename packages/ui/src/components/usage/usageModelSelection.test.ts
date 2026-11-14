import { describe, expect, test } from 'bun:test';

import { selectVisibleModelEntries } from './usageModelSelection';

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
